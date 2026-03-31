import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, desc } from 'drizzle-orm'
import { releases, releaseDocuments, systemSettings } from '../db/schema'
import { compareBranches, checkBranchExists, createBranch, fetchGitLab, batchSequential } from '../utils/gitlab'
import { fetchYouTrack } from '../utils/youtrack'
import { extractTickets } from '../utils/tickets'

type Bindings = {
  DB: D1Database
  GITLAB_TOKEN: string
  YOUTRACK_TOKEN: string
  YOUTRACK_BASE_URL: string
}

const releaseCtrl = new Hono<{ Bindings: Bindings }>()

async function getLiveRepos(token: string) {
  return await fetchGitLab('/projects?membership=true&simple=true&per_page=100', token) as any[]
}

async function getExcludedTickets(db: any): Promise<Set<string>> {
  const settings = await db.select().from(systemSettings).where(eq(systemSettings.key, 'EXCLUDED_TICKETS'))
  const line = settings[0]?.value || ''
  return new Set(line.split(',').map((t: string) => t.trim().toUpperCase()).filter(Boolean))
}

// ── GET /releases ────────────────────────────────────────────────────────────
releaseCtrl.get('/', async (c) => {
  const db = drizzle(c.env.DB)
  const results = await db.select().from(releases).orderBy(desc(releases.created_at))
  return c.json(results)
})

// ── POST /releases ────────────────────────────────────────────────────────────
// Creates the release record and branches across all GitLab repos.
// Batch-safe: 10 repos at a time with a 200ms pause between batches.
releaseCtrl.post('/', async (c) => {
  const user = c.get('jwtPayload') as { id: string, role: string }
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403)

  const { name } = await c.req.json()
  if (!name) return c.json({ error: 'Release name required' }, 400)

  const db = drizzle(c.env.DB)
  const releaseId = crypto.randomUUID()

  try {
    await db.insert(releases).values({
      id: releaseId,
      name,
      status: 'active',
      created_by: user.id,
      created_at: new Date().toISOString()
    })
  } catch (e: any) {
    if (e.message.includes('UNIQUE')) return c.json({ error: 'Release already exists' }, 400)
    throw e
  }

  const repos = await getLiveRepos(c.env.GITLAB_TOKEN)

  const results = await batchSequential(repos, 10, 200, async (repo) => {
    try {
      const exists = await checkBranchExists(String(repo.id), name, c.env.GITLAB_TOKEN)
      if (!exists) {
        await createBranch(String(repo.id), name, 'stage', c.env.GITLAB_TOKEN)
        return { repo: repo.name, status: 'created' }
      }
      return { repo: repo.name, status: 'exists' }
    } catch (e: any) {
      return { repo: repo.name, status: 'error', error: e.message }
    }
  })

  return c.json({ releaseId, branching: results })
})

// ── GET /releases/compare ────────────────────────────────────────────────────
// Live comparison — batch-safe GitLab calls, sequential YouTrack enrichment.
// NOTE: prefer POST /:id/generate to persist results; this is for quick previews.
releaseCtrl.get('/compare', async (c) => {
  const from = c.req.query('from') || 'stage'
  const to = c.req.query('to') || 'main'
  const db = drizzle(c.env.DB)

  const excludedSet = await getExcludedTickets(db)
  const ticketMap = new Map<string, { summary: string, assignee: string, projects: Set<string> }>()

  const repos = await getLiveRepos(c.env.GITLAB_TOKEN)

  // Fetch diffs in batches of 10, 150ms between batches
  await batchSequential(repos, 10, 150, async (repo) => {
    try {
      const comparison = await compareBranches(String(repo.id), from, to, c.env.GITLAB_TOKEN) as any
      for (const commit of (comparison.commits || [])) {
        for (const ticketId of extractTickets(commit.message)) {
          if (excludedSet.has(ticketId.toUpperCase())) continue
          if (!ticketMap.has(ticketId)) {
            ticketMap.set(ticketId, { summary: 'Loading...', assignee: 'Unassigned', projects: new Set() })
          }
          ticketMap.get(ticketId)!.projects.add(repo.name)
        }
      }
    } catch {
      // Skip repos without matching branches
    }
  })

  const tickets = Array.from(ticketMap.entries()).map(([id, data]) => ({
    id,
    summary: data.summary,
    assignee: data.assignee,
    projects: Array.from(data.projects)
  }))

  // Enrich with YouTrack sequentially to avoid hammering the API
  const youtrackErrors: string[] = []
  for (const t of tickets) {
    const result = await fetchYouTrack(t.id, c.env.YOUTRACK_BASE_URL, c.env.YOUTRACK_TOKEN)
    if (result.ok) {
      t.summary = result.data.summary || t.summary
      t.assignee = result.data.assignee?.name || t.assignee
    } else if (result.status === 401 || result.status === 403) {
      // Auth failure — stop enriching and report it, but still return ticket list
      youtrackErrors.push(result.error)
      break
    }
    // 404 = ticket not in YouTrack yet, just keep defaults
  }

  return c.json({ from, to, count: tickets.length, tickets, youtrackErrors })
})

// ── POST /releases/:id/generate ──────────────────────────────────────────────
// Runs the full GitLab + YouTrack comparison once and persists it to D1.
// The frontend calls this on demand — not on every page load.
releaseCtrl.post('/:id/generate', async (c) => {
  const user = c.get('jwtPayload') as { id: string, role: string }
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403)

  const releaseId = c.req.param('id')
  const { from = 'stage', to = 'main' } = await c.req.json().catch(() => ({}))

  const db = drizzle(c.env.DB)

  // Verify release exists
  const release = await db.select().from(releases).where(eq(releases.id, releaseId)).get() as any
  if (!release) return c.json({ error: 'Release not found' }, 404)

  const excludedSet = await getExcludedTickets(db)
  const ticketMap = new Map<string, { summary: string, assignee: string, projects: Set<string> }>()

  const repos = await getLiveRepos(c.env.GITLAB_TOKEN)

  await batchSequential(repos, 10, 150, async (repo) => {
    try {
      const comparison = await compareBranches(String(repo.id), from, to, c.env.GITLAB_TOKEN) as any
      for (const commit of (comparison.commits || [])) {
        for (const ticketId of extractTickets(commit.message)) {
          if (excludedSet.has(ticketId.toUpperCase())) continue
          if (!ticketMap.has(ticketId)) {
            ticketMap.set(ticketId, { summary: 'Pending YouTrack...', assignee: 'Unassigned', projects: new Set() })
          }
          ticketMap.get(ticketId)!.projects.add(repo.name)
        }
      }
    } catch {
      // Skip repos without matching branches
    }
  })

  const tickets = Array.from(ticketMap.entries()).map(([id, data]) => ({
    id,
    summary: data.summary,
    assignee: data.assignee,
    projects: Array.from(data.projects)
  }))

  const youtrackErrors: string[] = []
  for (const t of tickets) {
    const result = await fetchYouTrack(t.id, c.env.YOUTRACK_BASE_URL, c.env.YOUTRACK_TOKEN)
    if (result.ok) {
      t.summary = result.data.summary || t.summary
      t.assignee = result.data.assignee?.name || t.assignee
    } else if (result.status === 401 || result.status === 403) {
      youtrackErrors.push(result.error)
      break
    }
  }

  const snapshot = {
    release_name: release.name,
    from,
    to,
    generated_at: new Date().toISOString(),
    ticket_count: tickets.length,
    tickets,
    youtrackErrors,
  }

  // Upsert: delete existing snapshot for this release then insert fresh
  await db.delete(releaseDocuments).where(eq(releaseDocuments.release_id, releaseId))
  await db.insert(releaseDocuments).values({
    id: crypto.randomUUID(),
    release_id: releaseId,
    type: 'snapshot',
    content: JSON.stringify(snapshot),
    generated_at: snapshot.generated_at,
  })

  return c.json({ success: true, ...snapshot })
})

// ── GET /releases/:id/document ───────────────────────────────────────────────
// Returns the stored snapshot for a release (no live API calls).
releaseCtrl.get('/:id/document', async (c) => {
  const releaseId = c.req.param('id')
  const db = drizzle(c.env.DB)

  const doc = await db.select()
    .from(releaseDocuments)
    .where(eq(releaseDocuments.release_id, releaseId))
    .get() as any

  if (!doc) return c.json({ error: 'No document generated yet for this release' }, 404)

  return c.json({ ...doc, content: JSON.parse(doc.content || '{}') })
})

export default releaseCtrl
