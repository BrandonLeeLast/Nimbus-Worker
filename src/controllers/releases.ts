import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, desc } from 'drizzle-orm'
import { repositories, releases, releaseDocuments, systemSettings } from '../db/schema'
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
  const repos = await db.select().from(repositories)
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

  const results = []
  for (const repo of repos) {
    if (repo.provider !== 'gitlab' || !repo.remote_id) continue
    
    try {
      const exists = await checkBranchExists(repo.remote_id, name, c.env.GITLAB_TOKEN)
      if (!exists) {
        await createBranch(repo.remote_id, name, 'stage', c.env.GITLAB_TOKEN)
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
  const repos = await db.select().from(repositories)
  
  const settings = await db.select().from(systemSettings).where(eq(systemSettings.key, 'EXCLUDED_TICKETS'))
  const excludedLine = settings[0]?.value || ''
  const excludedSet = new Set(excludedLine.split(',').map(t => t.trim().toUpperCase()))

  const ticketMap = new Map<string, { summary: string, assignee: string, projects: Set<string> }>()

  for (const repo of repos) {
    if (repo.provider === 'gitlab' && repo.remote_id) {
        try {
          const comparison = await compareBranches(repo.remote_id, from, to, c.env.GITLAB_TOKEN)
          for (const commit of (comparison.commits || [])) {
            const foundTickets = extractTickets(commit.message)
            for (const ticketId of foundTickets) {
              if (excludedSet.has(ticketId.toUpperCase())) continue;
              if (!ticketMap.has(ticketId)) {
                 ticketMap.set(ticketId, { summary: 'Loading...', assignee: 'Unassigned', projects: new Set() })
              }
              ticketMap.get(ticketId)!.projects.add(repo.name)
            }
          }
        } catch (e) {
          console.error(`Error comparing ${repo.name}:`, e)
        }
    }
  }

  const tickets = Array.from(ticketMap.entries()).map(([id, data]) => ({
    id,
    summary: data.summary,
    assignee: data.assignee,
    projects: Array.from(data.projects)
  }))

  const enrichedPromises = tickets.map(async (t) => {
    const data = await fetchYouTrack(t.id, c.env.YOUTRACK_BASE_URL, c.env.YOUTRACK_TOKEN)
    if (data) {
      t.summary = data.summary || t.summary
      t.assignee = data.assignee?.name || t.assignee
    }
  })

  await Promise.all(enrichedPromises)

  return c.json({ from, to, count: tickets.length, tickets })
})

export default releaseCtrl
