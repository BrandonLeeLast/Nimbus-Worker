import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { drizzle } from 'drizzle-orm/d1'
import { desc, eq } from 'drizzle-orm'
import { jwt } from 'hono/jwt'
import { branches, hotfixes, repositories, users, systemSettings } from './db/schema'
import { hashPassword, verifyPassword } from './utils/auth'
import { sendInvitationEmail } from './utils/emails'

export type Bindings = {
  DB: D1Database
  KV: KVNamespace
  RESEND_API_KEY: string
  GITLAB_TOKEN: string
  GITHUB_TOKEN: string
  YOUTRACK_TOKEN: string
  YOUTRACK_BASE_URL: string
  JWT_SECRET: string
}

export type JWTPayload = {
  id: string
  email: string
  role: string
  exp: number
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

// Auth Middleware (Only protect sensitive management routes)
app.use('/api/auth/invite', (c, next) => jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' })(c, next))
app.use('/api/auth/reset-password', (c, next) => jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' })(c, next))

// Protect Repository mutations (POST/DELETE) but not GET
app.post('/api/repositories', (c, next) => jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' })(c, next))
app.delete('/api/repositories/*', (c, next) => jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' })(c, next))

// Protect Settings entirely
app.use('/api/settings/*', (c, next) => jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' })(c, next))

// --- Helpers ---
function parseBranchName(branchName: string) {
  const normalized = branchName.replace(/^origin\//, '')
  const ticketRegex = /(OPENBET|OB|INDEV)-?\d+/i
  const ticketMatch = normalized.match(ticketRegex)
  const ticket = ticketMatch ? ticketMatch[0].toUpperCase() : null

  let developer = 'Unknown'
  let type = 'feature'
  
  if (normalized.toLowerCase().startsWith('hotfix/')) {
    type = 'hotfix'
    const parts = normalized.split('/')
    if (parts.length >= 3) developer = parts[1]
  } else {
    const parts = normalized.split('/')
    if (parts.length >= 2) {
      developer = parts[0]
      if (['feature', 'fix', 'bugfix'].includes(parts[1].toLowerCase())) {
         type = parts[1].toLowerCase()
      }
    }
  }
  return { developer, ticket, type }
}

async function fetchYouTrackTicket(env: Bindings, ticketId: string | null) {
  if (!ticketId || !env.YOUTRACK_TOKEN || !env.YOUTRACK_BASE_URL) return null
  try {
    const res = await fetch(`${env.YOUTRACK_BASE_URL}/api/issues/${ticketId}?fields=summary`, {
      headers: { 'Authorization': `Bearer ${env.YOUTRACK_TOKEN}` }
    })
    const data: any = await res.json()
    return data.summary || null
  } catch (e) {
    console.error(`YouTrack fetch failed for ${ticketId}:`, e)
    return null
  }
}

const isReleaseTarget = (branch: string) => /^release-\d{8}$/.test(branch) || branch === 'main'

// --- API Endpoints ---
app.get('/api/branches', async (c) => {
  const db = drizzle(c.env.DB)
  const repos = await db.select().from(repositories)
  
  let allBranches: any[] = []

  for (const repo of repos) {
    try {
      if (repo.provider === 'gitlab' && repo.remote_id) {
        const res = await fetch(`https://gitlab.com/api/v4/projects/${repo.remote_id}/repository/branches`, {
          headers: { 'PRIVATE-TOKEN': c.env.GITLAB_TOKEN }
        })
        const data: any = await res.json()
        if (Array.isArray(data)) {
          allBranches.push(...data.map((b: any) => ({
             id: `${repo.id}-${b.name}`,
             name: b.name,
             status: b.merged ? 'closed' : 'active',
             created_by: 'GitLab',
             created_at: b.commit?.created_at,
             repo_name: repo.name
          })))
        }
      } else if (repo.provider === 'github' && repo.remote_id) {
        const res = await fetch(`https://api.github.com/repos/${repo.remote_id}/branches`, {
          headers: { 
            'Authorization': `token ${c.env.GITHUB_TOKEN}`,
            'User-Agent': 'Nimbus-Worker'
          }
        })
        const data: any = await res.json()
        if (Array.isArray(data)) {
          allBranches.push(...data.map((b: any) => ({
             id: `${repo.id}-${b.name}`,
             name: b.name,
             status: 'active', // GitHub branch API doesn't show merged status easily here
             created_by: 'GitHub',
             created_at: new Date().toISOString(),
             repo_name: repo.name
          })))
        }
      }
    } catch (e) {
      console.error(`Failed to fetch branches for ${repo.name}:`, e)
    }
  }

  // Filter for release branches or main
  const filtered = allBranches.filter(b => isReleaseTarget(b.name))
  return c.json(filtered)
})

app.get('/api/hotfixes', async (c) => {
  const db = drizzle(c.env.DB)
  const results = await db.select().from(hotfixes).orderBy(desc(hotfixes.merged_at))
  return c.json(results)
})

app.get('/api/repositories', async (c) => {
  const db = drizzle(c.env.DB)
  const results = await db.select().from(repositories)
  return c.json(results)
})

app.post('/api/repositories', async (c) => {
  const payload = await c.req.json()
  const db = drizzle(c.env.DB)
  const id = crypto.randomUUID()
  await db.insert(repositories).values({
    id,
    name: payload.name,
    url: payload.url,
    provider: payload.provider || 'gitlab',
    remote_id: payload.remote_id
  })
  return c.json({ success: true, id })
})

app.delete('/api/repositories/:id', async (c) => {
  const id = c.req.param('id')
  const db = drizzle(c.env.DB)
  await db.delete(repositories).where(eq(repositories.id, id))
  return c.json({ success: true })
})

// --- Auth Endpoints ---

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json()
  const db = drizzle(c.env.DB)
  const [user] = await db.select().from(users).where(eq(users.email, email))

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const payload: JWTPayload = {
    id: user.id,
    email: user.email,
    role: user.role || 'user',
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 // 24h
  }

  // Import sign from hono/jwt
  const { sign } = await import('hono/jwt')
  const token = await sign(payload, c.env.JWT_SECRET)

  return c.json({ 
    token, 
    user: { 
      email: user.email, 
      role: user.role, 
      mustReset: user.must_reset_password === 1 
    } 
  })
})

app.post('/api/auth/invite', async (c) => {
  const admin = c.get('jwtPayload') as JWTPayload
  if (admin.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const { email, role } = await c.req.json()
  const tempPass = Math.random().toString(36).slice(-8)
  const hash = await hashPassword(tempPass)

  const db = drizzle(c.env.DB)
  await db.insert(users).values({
    id: crypto.randomUUID(),
    email,
    password_hash: hash,
    role: role || 'user',
    must_reset_password: 1,
    created_at: new Date().toISOString()
  })

  await sendInvitationEmail(c.env, email, tempPass)
  return c.json({ success: true })
})

app.post('/api/auth/reset-password', async (c) => {
  const payload = await c.req.json()
  const { newPassword } = payload
  const user = c.get('jwtPayload') as JWTPayload
  
  const hash = await hashPassword(newPassword)
  const db = drizzle(c.env.DB)
  
  await db.update(users)
    .set({ password_hash: hash, must_reset_password: 0 })
    .where(eq(users.id, user.id))

  return c.json({ success: true })
})

// --- Settings Endpoints ---

app.get('/api/settings', async (c) => {
  const db = drizzle(c.env.DB)
  const results = await db.select().from(systemSettings)
  const settingsMap = results.reduce((acc: any, curr: { key: string, value: string | null }) => {
    acc[curr.key] = curr.value
    return acc
  }, {})
  return c.json(settingsMap)
})

app.post('/api/settings', async (c) => {
  const payload = await c.req.json()
  const db = drizzle(c.env.DB)
  
  for (const [key, value] of Object.entries(payload)) {
    await db.insert(systemSettings)
      .values({ key, value: String(value) })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: String(value) } })
  }
  return c.json({ success: true })
})

// --- Webhooks ---
app.post('/webhook/gitlab', async (c) => {
  try {
    const payload = await c.req.json()
    const db = drizzle(c.env.DB)

    // Handle Merge Requests
    if (payload.object_kind === 'merge_request') {
      const attrs = payload.object_attributes
      const targetBranch = attrs.target_branch
      const sourceBranch = attrs.source_branch
      const realAuthor = payload.user?.name || payload.user?.username || 'Unknown Developer'

      if (attrs.state === 'merged' && isReleaseTarget(targetBranch)) {
        const { ticket } = parseBranchName(sourceBranch)
        const summary = await fetchYouTrackTicket(c.env, ticket)
        
        await db.insert(hotfixes).values({
          id: crypto.randomUUID(),
          branch_id: targetBranch,
          pr_url: attrs.url,
          author: realAuthor,
          developer: realAuthor,
          ticket_id: ticket,
          ticket_summary: summary, // Assuming schema update or using existing field
          merged_at: new Date().toISOString()
        })
      }
    }

    // Handle Branch Creation/Deletion via Push
    if (payload.object_kind === 'push') {
      const branchName = payload.ref.replace('refs/heads/', '')
      const isDeletion = payload.after === '0000000000000000000000000000000000000000'
      const isCreation = payload.before === '0000000000000000000000000000000000000000'

      if (isCreation) {
        await db.insert(branches).values({
          id: crypto.randomUUID(),
          name: branchName,
          status: 'active',
          created_by: payload.user_name || 'System',
          created_at: new Date().toISOString()
        })
      } else if (isDeletion) {
        // Mark as closed instead of deleting maybe?
        await db.update(branches)
          .set({ status: 'closed' })
          .where(eq(branches.name, branchName))
      }
    }

    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/webhook/github', async (c) => {
  try {
    const payload = await c.req.json()
    const db = drizzle(c.env.DB)

    // GitHub Pull Request event
    if (payload.action === 'closed' && payload.pull_request?.merged) {
      const pr = payload.pull_request
      const targetBranch = pr.base.ref
      const sourceBranch = pr.head.ref
      const realAuthor = pr.user?.login || payload.sender?.login || 'Unknown Developer'

      if (isReleaseTarget(targetBranch)) {
        const { ticket } = parseBranchName(sourceBranch)
        const summary = await fetchYouTrackTicket(c.env, ticket)

        await db.insert(hotfixes).values({
          id: crypto.randomUUID(),
          branch_id: targetBranch,
          pr_url: pr.html_url,
          author: realAuthor,
          developer: realAuthor,
          ticket_id: ticket,
          ticket_summary: summary,
          merged_at: new Date().toISOString()
        })
      }
    }

    // Branch Creation
    if (c.req.header('x-github-event') === 'create' && payload.ref_type === 'branch') {
      await db.insert(branches).values({
        id: crypto.randomUUID(),
        name: payload.ref,
        status: 'active',
        created_by: payload.sender?.login || 'System',
        created_at: new Date().toISOString()
      })
    }

    // Branch Deletion
    if (c.req.header('x-github-event') === 'delete' && payload.ref_type === 'branch') {
      await db.update(branches)
        .set({ status: 'closed' })
        .where(eq(branches.name, payload.ref))
    }

    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// --- Scheduled Cron Job ---
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    console.log("Cron event trigger:", event.cron)
    const cleanupEnabled = await env.KV.get('CLEANUP_ENABLED')
    if (cleanupEnabled === 'true') {
      console.log("Running branch cleanup...")
    }
  }
}
