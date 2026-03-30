import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, desc } from 'drizzle-orm'
import { releases, releaseDocuments, systemSettings } from '../db/schema'
import { compareBranches, checkBranchExists, createBranch } from '../utils/gitlab'
import { fetchYouTrack } from '../utils/youtrack'
import { extractTickets } from '../utils/tickets'

type Bindings = {
  DB: D1Database
  GITLAB_TOKEN: string
  YOUTRACK_TOKEN: string
  YOUTRACK_BASE_URL: string
}

const releaseCtrl = new Hono<{ Bindings: Bindings }>()

// Helper to get projects from GitLab
async function getLiveRepos(token: string) {
  const response = await fetch('https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=100', {
    headers: { 'PRIVATE-TOKEN': token }
  })
  if (!response.ok) throw new Error(`GitLab API error: ${response.statusText}`)
  return await response.json() as any[]
}

releaseCtrl.get('/', async (c) => {
  const db = drizzle(c.env.DB)
  const results = await db.select().from(releases).orderBy(desc(releases.created_at))
  return c.json(results)
})

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

  // --- LIVE REPOS FROM GITLAB ---
  const repos = await getLiveRepos(c.env.GITLAB_TOKEN)
  const results = []
  
  for (const repo of repos) {
    // Attempt creation from 'stage'
    try {
      const exists = await checkBranchExists(String(repo.id), name, c.env.GITLAB_TOKEN)
      if (!exists) {
        await createBranch(String(repo.id), name, 'stage', c.env.GITLAB_TOKEN)
        results.push({ repo: repo.name, status: 'created' })
      } else {
        results.push({ repo: repo.name, status: 'exists' })
      }
    } catch (e: any) {
      results.push({ repo: repo.name, status: 'error', error: e.message })
    }
  }

  return c.json({ releaseId, branching: results })
})

releaseCtrl.get('/compare', async (c) => {
  const from = c.req.query('from') || 'stage'
  const to = c.req.query('to') || 'main'
  const db = drizzle(c.env.DB)
  
  const settings = await db.select().from(systemSettings).where(eq(systemSettings.key, 'EXCLUDED_TICKETS'))
  const excludedLine = settings[0]?.value || ''
  const excludedSet = new Set(excludedLine.split(',').map(t => t.trim().toUpperCase()))

  const ticketMap = new Map<string, { summary: string, assignee: string, projects: Set<string> }>()
  
  // --- LIVE REPOS FROM GITLAB ---
  const repos = await getLiveRepos(c.env.GITLAB_TOKEN)

  for (const repo of repos) {
      try {
        const comparison = await compareBranches(String(repo.id), from, to, c.env.GITLAB_TOKEN) as any
        for (const commit of (comparison.commits || [])) {
          const foundTickets = extractTickets(commit.message)
          for (const ticketId of foundTickets) {
            if (excludedSet.has(ticketId.toUpperCase())) continue;
            if (!ticketMap.has(ticketId)) {
               ticketMap.set(ticketId, { summary: 'Loading...', assignee: 'Unassigned', projects: new Set<string>() })
            }
            ticketMap.get(ticketId)!.projects.add(repo.name)
          }
        }
      } catch (e) {
        // Skip projects without branch matches
      }
  }

  const tickets = Array.from(ticketMap.entries()).map(([id, data]) => ({
    id,
    summary: data.summary,
    assignee: data.assignee,
    projects: Array.from(data.projects)
  }))

  const enrichedPromises = tickets.map(async (t) => {
    const data = await fetchYouTrack(t.id, c.env.YOUTRACK_BASE_URL, c.env.YOUTRACK_TOKEN) as any
    if (data) {
      t.summary = data.summary || t.summary
      t.assignee = data.assignee?.name || t.assignee
    }
  })

  await Promise.all(enrichedPromises)

  return c.json({ from, to, count: tickets.length, tickets })
})

export default releaseCtrl
