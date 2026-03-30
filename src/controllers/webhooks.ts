import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { branches } from '../db/schema'

type Bindings = {
  DB: D1Database
}

const webhooks = new Hono<{ Bindings: Bindings }>()

webhooks.post('/gitlab', async (c) => {
  try {
    const payload = await c.req.json()
    const db = drizzle(c.env.DB)
    
    // Branch creation/deletion logic
    const isCreation = payload.object_kind === 'push' && payload.before === '0000000000000000000000000000000000000000'
    const isDeletion = payload.object_kind === 'push' && payload.after === '0000000000000000000000000000000000000000'
    const branchName = payload.ref?.replace('refs/heads/', '')

    if (branchName) {
      if (isCreation) {
        await db.insert(branches).values({
          id: crypto.randomUUID(),
          name: branchName,
          status: 'active',
          created_by: payload.user_name || 'System',
          created_at: new Date().toISOString()
        })
      } 
      /* COMMENTED OUT FOR SAFETY
      else if (isDeletion) {
        await db.update(branches)
          .set({ status: 'closed' })
          .where(eq(branches.name, branchName))
      }
      */
    }
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

webhooks.post('/github', async (c) => {
  try {
    const payload = await c.req.json()
    const db = drizzle(c.env.DB)
    
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

    /* COMMENTED OUT FOR SAFETY
    if (c.req.header('x-github-event') === 'delete' && payload.ref_type === 'branch') {
      await db.update(branches)
        .set({ status: 'closed' })
        .where(eq(branches.name, payload.ref))
    }
    */

    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

export default webhooks
