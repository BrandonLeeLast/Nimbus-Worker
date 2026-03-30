import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { jwt } from 'hono/jwt'
import auth from './controllers/auth'
import repos from './controllers/repositories'
import releaseCtrl from './controllers/releases'
import webhooks from './controllers/webhooks'

type Bindings = {
  DB: D1Database
  KV: KVNamespace
  GITLAB_TOKEN: string
  YOUTRACK_TOKEN: string
  YOUTRACK_BASE_URL: string
  RESEND_API_KEY: string
  JWT_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Middleware
app.use('*', cors())

// Public Routes
app.route('/api/auth', auth)
app.route('/webhook', webhooks)

// Protected Routes (JWT required for all below)
app.use('/api/*', (c, next) => {
  const jwtMiddleware = jwt({ secret: c.env.JWT_SECRET })
  return jwtMiddleware(c, next)
})

app.route('/api/repositories', repos)
app.route('/api/releases', releaseCtrl)
app.route('/api/release-docs', releaseCtrl)

// --- Scheduled Cron Job ---
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    console.log("Cron event trigger: Cleanup logic is currently disabled for safety.")
    /*
    console.log("Cron event trigger:", event.cron)
    const cleanupEnabled = await env.KV.get('CLEANUP_ENABLED')
    if (cleanupEnabled === 'true') {
      console.log("Running branch cleanup...")
    }
    */
  }
}
