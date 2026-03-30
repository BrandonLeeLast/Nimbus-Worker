import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { drizzle } from 'drizzle-orm/d1'
import { desc } from 'drizzle-orm'
import { branches, hotfixes, repositories } from './db/schema'

type Bindings = {
  DB: D1Database
  KV: KVNamespace
  RESEND_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

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

const isReleaseTarget = (branch: string) => /^release-\d{8}$/.test(branch) || branch === 'main'

// --- API Endpoints ---
app.get('/api/branches', async (c) => {
  const db = drizzle(c.env.DB)
  const results = await db.select().from(branches).orderBy(desc(branches.created_at))
  return c.json(results)
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

// --- Webhooks ---
app.post('/webhook/gitlab', async (c) => {
  try {
    const payload = await c.req.json()
    if (payload.object_kind === 'merge_request') {
      const attrs = payload.object_attributes
      const targetBranch = attrs.target_branch
      const sourceBranch = attrs.source_branch
      const realAuthor = payload.user?.name || payload.user?.username || 'Unknown Developer'

      if (attrs.state === 'merged' && isReleaseTarget(targetBranch)) {
        const { ticket } = parseBranchName(sourceBranch)
        const db = drizzle(c.env.DB)
        await db.insert(hotfixes).values({
          id: crypto.randomUUID(),
          branch_id: targetBranch,
          pr_url: attrs.url,
          author: realAuthor,
          developer: realAuthor,
          ticket_id: ticket
        })
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
    // GitHub Pull Request event
    if (payload.action === 'closed' && payload.pull_request?.merged) {
      const pr = payload.pull_request
      const targetBranch = pr.base.ref
      const sourceBranch = pr.head.ref
      const realAuthor = pr.user?.login || payload.sender?.login || 'Unknown Developer'

      if (isReleaseTarget(targetBranch)) {
        const { ticket } = parseBranchName(sourceBranch)
        const db = drizzle(c.env.DB)
        await db.insert(hotfixes).values({
          id: crypto.randomUUID(),
          branch_id: targetBranch,
          pr_url: pr.html_url,
          author: realAuthor,
          developer: realAuthor,
          ticket_id: ticket
        })
      }
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
