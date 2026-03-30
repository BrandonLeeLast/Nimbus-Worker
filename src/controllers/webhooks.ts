import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
}

const webhooks = new Hono<{ Bindings: Bindings }>()

webhooks.post('/gitlab', async (c) => {
  // We no longer track branches in D1. 
  // This endpoint can be used for future automations (like email alerts).
  return c.json({ success: true })
})

webhooks.post('/github', async (c) => {
  return c.json({ success: true })
})

export default webhooks
