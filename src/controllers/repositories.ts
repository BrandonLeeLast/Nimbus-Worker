import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { systemSettings } from '../db/schema'
import { checkBranchExists } from '../utils/gitlab'

type Bindings = {
  DB: D1Database
  KV: KVNamespace
  GITLAB_TOKEN: string
}

const repos = new Hono<{ Bindings: Bindings }>()

// Helper to get active release name
async function getActiveRelease(db: any) {
  const setting = await db.select().from(systemSettings).where(eq(systemSettings.key, 'ACTIVE_RELEASE')).get()
  return setting?.value || ''
}

// Live fetch from GitLab
repos.get('/repositories', async (c) => {
  if (!c.env.GITLAB_TOKEN) {
    console.error('Environment Error: GITLAB_TOKEN is missing')
    return c.json({ error: 'System configuration error: GITLAB_TOKEN missing' }, 500)
  }

  const cached = await c.env.KV.get('gitlab:projects')
  if (cached) return c.json(JSON.parse(cached))

  try {
    const response = await fetch('https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=100', {
      headers: { 'PRIVATE-TOKEN': c.env.GITLAB_TOKEN }
    })
    if (!response.ok) throw new Error(`GitLab API error: ${response.statusText}`)
    
    const projects = await response.json() as any[]
    const results = projects.map(p => ({
      id: String(p.id),
      name: p.name_with_namespace,
      url: p.web_url,
      provider: 'gitlab',
      remote_id: String(p.id)
    }))

    await c.env.KV.put('gitlab:projects', JSON.stringify(results), { expirationTtl: 3600 })
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

repos.get('/branches', async (c) => {
  const db = drizzle(c.env.DB)
  const activeRelease = await getActiveRelease(db)
  if (!activeRelease) return c.json([])

  const cacheKey = `gitlab:branches:${activeRelease}`
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json(JSON.parse(cached))

  try {
      const projectsRes = await fetch('https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=50', {
        headers: { 'PRIVATE-TOKEN': c.env.GITLAB_TOKEN }
      })
      const projects = await projectsRes.json() as any[]
      
      const branchPromises = projects.map(async (p) => {
        const exists = await checkBranchExists(String(p.id), activeRelease, c.env.GITLAB_TOKEN)
        return exists ? { project: p.name, branch: activeRelease } : null
      })
      
      const results = (await Promise.all(branchPromises)).filter(Boolean)
      await c.env.KV.put(cacheKey, JSON.stringify(results), { expirationTtl: 300 })
      return c.json(results)
  } catch (e: any) {
      return c.json({ error: e.message }, 500)
  }
})

repos.get('/hotfixes', async (c) => {
  const db = drizzle(c.env.DB)
  const activeRelease = await getActiveRelease(db)
  
  const cacheKey = `gitlab:hotfixes:${activeRelease || 'any'}`
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json(JSON.parse(cached))

  try {
    // Fetch merged MRs related to the active release (matching title or labels)
    const searchQuery = activeRelease ? `hotfix ${activeRelease}` : 'hotfix'
    const response = await fetch(`https://gitlab.com/api/v4/merge_requests?state=merged&scope=all&search=${searchQuery}&per_page=20`, {
      headers: { 'PRIVATE-TOKEN': c.env.GITLAB_TOKEN }
    })
    if (!response.ok) throw new Error(`GitLab API error: ${response.statusText}`)
    
    const mrs = await response.json() as any[]
    const results = mrs.map(mr => ({
      id: String(mr.id),
      ticket_id: mr.title.match(/INDEV-\d+|OPENBET-\d+/i)?.[0] || 'N/A',
      ticket_summary: mr.title,
      author: mr.author.name,
      merged_at: mr.merged_at
    }))

    await c.env.KV.put(cacheKey, JSON.stringify(results), { expirationTtl: 300 })
    return c.json(results)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// Settings remain in D1
repos.get('/settings', async (c) => {
  const db = drizzle(c.env.DB)
  const results = await db.select().from(systemSettings)
  return c.json(results)
})

repos.post('/settings', async (c) => {
  const user = c.get('jwtPayload') as { id: string, role: string }
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
  
  const body = await c.req.json()
  const db = drizzle(c.env.DB)
  
  for (const [key, value] of Object.entries(body)) {
    await db.insert(systemSettings)
      .values({ key, value: String(value) })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: String(value) } })
  }
    
  return c.json({ success: true })
})

export default repos
