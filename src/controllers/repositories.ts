import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { repositories, systemSettings } from '../db/schema'

type Bindings = {
  DB: D1Database
}

const repos = new Hono<{ Bindings: Bindings }>()

repos.get('/', async (c) => {
  const db = drizzle(c.env.DB)
  const results = await db.select().from(repositories)
  return c.json(results)
})

repos.post('/', async (c) => {
  const user = c.get('jwtPayload')
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
  
  const body = await c.req.json()
  const db = drizzle(c.env.DB)
  
  const id = crypto.randomUUID()
  await db.insert(repositories).values({
    id,
    ...body,
    created_at: new Date().toISOString()
  })
  return c.json({ id })
})

repos.delete('/:id', async (c) => {
  const user = c.get('jwtPayload')
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
  
  const db = drizzle(c.env.DB)
  await db.delete(repositories).where(eq(repositories.id, c.req.param('id')))
  return c.json({ success: true })
})

// Settings
repos.get('/settings', async (c) => {
  const db = drizzle(c.env.DB)
  const results = await db.select().from(systemSettings)
  return c.json(results)
})

repos.post('/settings', async (c) => {
  const user = c.get('jwtPayload')
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
  
  const { key, value } = await c.req.json()
  const db = drizzle(c.env.DB)
  
  await db.insert(systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value } })
    
  return c.json({ success: true })
})

export default repos
