import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  KV: KVNamespace
  RESEND_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

app.get('/', (c) => c.text('Release Tracker API is running!'))

app.get('/api/branches', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM branches ORDER BY created_at DESC').all()
  return c.json(results)
})

app.get('/api/hotfixes', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM hotfixes ORDER BY merged_at DESC').all()
  return c.json(results)
})

app.get('/api/repositories', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM repositories').all()
  return c.json(results)
})

app.post('/webhook/gitlab', async (c) => {
  try {
    const payload = await c.req.json()
    if (payload.object_kind === 'merge_request') {
      const attrs = payload.object_attributes
      const targetBranch = attrs.target_branch
      const isHotfix = targetBranch.startsWith('release/') || targetBranch === 'main'

      if (attrs.state === 'merged' && isHotfix) {
        const id = crypto.randomUUID()
        await c.env.DB.prepare(
          'INSERT INTO hotfixes (id, branch_id, pr_url, author) VALUES (?, ?, ?, ?)'
        ).bind(id, targetBranch, attrs.url, attrs.author_id?.toString() || 'Unknown').run()
      }
    }
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/webhook/youtrack', async (c) => {
  return c.json({ success: true, message: "Acknowledged Youtrack webhook" })
})

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
