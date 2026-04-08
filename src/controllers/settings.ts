import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { systemSettings, releases as releasesTable } from '../db/schema';
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

// Clear all KV caches
settingsCtrl.post('/clear-cache', async (c) => {
  const db = drizzle(c.env.DB);
  const allReleases = await db.select({ id: releasesTable.id }).from(releasesTable);

  const keys: string[] = [];

  // Per-release cache keys
  for (const { id } of allReleases) {
    keys.push(`pipeline:${id}`, `hotfixes:${id}`, `branch_status:${id}`);
  }

  // Active repos scan keys (delete today's and yesterday's to be safe)
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dates = [today, yesterday].map(d => d.toISOString().slice(0, 10));
  for (const date of dates) {
    for (const days of [90, 30, 60, 120, 180, 365]) {
      keys.push(`active_repos:${date}:${days}`);
    }
  }

  // GitLab search cache — list and delete
  const searchList = await c.env.NIMBUS_KV.list({ prefix: 'gitlab_search:' });
  for (const key of searchList.keys) keys.push(key.name);

  await Promise.all(keys.map(k => c.env.NIMBUS_KV.delete(k).catch(() => null)));

  return c.json({ success: true, cleared: keys.length });
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
