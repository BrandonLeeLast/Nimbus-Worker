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
  DEBUG: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Middleware
app.use('*', cors())

// Public Routes
app.route('/api/auth', auth)
app.route('/webhook', webhooks)

// Protected Routes (JWT required for mutations and private data)
app.use('/api/*', (c, next) => {
  // Allow public GET for dashboard and releases
  if (c.req.method === 'GET' && (c.req.path === '/api/repositories' || c.req.path === '/api/releases' || c.req.path === '/api/release-docs/compare')) {
    return next()
  }
  const jwtMiddleware = jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' })
  return jwtMiddleware(c, next)
})

app.route('/api/repositories', repos)
app.route('/api/releases', releaseCtrl)
app.route('/api/release-docs', releaseCtrl)

// Global Error Handler
app.onError((err, c) => {
  console.error(`Error Logic: ${err.message}`, err.stack)
  return c.json({ 
    error: err.message, 
    stack: c.env.DEBUG === 'true' ? err.stack : undefined 
  }, 500)
})

app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404)
})

// --- Scheduled Cron Job ---
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    console.log("Cron event trigger: Cleanup logic is currently disabled for safety.")
  }
}
