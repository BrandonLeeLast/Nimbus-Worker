import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { systemSettings } from '../db/schema';
import type { Env } from '../index';

export const settingsCtrl = new Hono<{ Bindings: Env }>();

// Get all settings
settingsCtrl.get('/', async (c) => {
  const db = drizzle(c.env.DB);
  const all = await db.select().from(systemSettings);
  const map: Record<string, string> = {};
  for (const row of all) map[row.key] = row.value ?? '';
  // Expose env-level URLs so the frontend can build links
  if (c.env.YOUTRACK_BASE_URL) map['YOUTRACK_BASE_URL'] = c.env.YOUTRACK_BASE_URL;
  return c.json(map);
});

// Set a setting
settingsCtrl.put('/:key', async (c) => {
  const key = c.req.param('key');
  const { value } = await c.req.json<{ value: string }>();
  const db = drizzle(c.env.DB);
  await db.insert(systemSettings).values({ key, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value } });
  return c.json({ success: true });
});
