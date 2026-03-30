import { jwt } from 'hono/jwt'
import { createMiddleware } from 'hono/factory'

export const authMiddleware = (secret: string) => jwt({ secret })

export const adminOnly = createMiddleware(async (c, next) => {
  const payload = c.get('jwtPayload')
  if (payload?.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }
  await next()
})
