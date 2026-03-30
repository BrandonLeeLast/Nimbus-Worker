import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { sign } from 'hono/jwt'
import { users } from '../db/schema'
import { hashPassword, verifyPassword } from '../utils/auth'
import { sendInvitationEmail } from '../utils/emails'

type Bindings = {
  DB: D1Database
  JWT_SECRET: string
  RESEND_API_KEY: string
}

const auth = new Hono<{ Bindings: Bindings }>()

auth.post('/login', async (c) => {
  const { email, password } = await c.req.json()
  const db = drizzle(c.env.DB)
  
  const user = await db.select().from(users).where(eq(users.email, email)).get()
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const token = await sign({ id: user.id, email: user.email, role: user.role, mustReset: user.must_reset_password }, c.env.JWT_SECRET)
  return c.json({ token, user: { id: user.id, email: user.email, role: user.role, mustReset: user.must_reset_password } })
})

auth.post('/reset-password', async (c) => {
  const payload = c.get('jwtPayload') as any
  const { newPassword } = await c.req.json()
  const db = drizzle(c.env.DB)
  
  const hashedPassword = await hashPassword(newPassword)
  await db.update(users)
    .set({ password_hash: hashedPassword, must_reset_password: 0 })
    .where(eq(users.id, payload.id))

  return c.json({ success: true })
})

auth.post('/invite', async (c) => {
  const admin = c.get('jwtPayload') as any
  if (admin.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const { email, role } = await c.req.json()
  const db = drizzle(c.env.DB)
  
  const tempPassword = Math.random().toString(36).slice(-10)
  const hashedPassword = await hashPassword(tempPassword)
  
  try {
    const userId = crypto.randomUUID()
    await db.insert(users).values({
      id: userId,
      email,
      password_hash: hashedPassword,
      role: role || 'user',
      must_reset_password: 1,
      created_at: new Date().toISOString()
    })

    await sendInvitationEmail(email, tempPassword, c.env.RESEND_API_KEY)
    return c.json({ success: true, userId })
  } catch (e: any) {
    return c.json({ error: 'User already exists or mail failed' }, 400)
  }
})

export default auth
