import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { repositories, systemSettings } from '../db/schema';
import { searchProjects, getProject, getClassifiedAheadCommits, batchSequential, getRecentlyActiveProjects } from '../utils/gitlab';
import type { Env } from '../index';

export const reposCtrl = new Hono<{ Bindings: Env }>();

reposCtrl.get('/', async (c) => {
  const db = drizzle(c.env.DB);
  const all = await db.select().from(repositories).orderBy(repositories.name);
  return c.json(all);
});

reposCtrl.post('/', async (c) => {
  const { name, gitlab_path, project_id } = await c.req.json<{
    name: string;
    gitlab_path: string;
    project_id?: string;
  }>();
  if (!name || !gitlab_path) return c.json({ error: 'name and gitlab_path required' }, 400);

  const db = drizzle(c.env.DB);

  // If already registered, return existing record
  const existing = await db.select().from(repositories).where(eq(repositories.gitlab_path, gitlab_path)).limit(1);
  if (existing[0]) {
    // Update project_id if we now have it
    if (project_id && !existing[0].project_id) {
      await db.update(repositories).set({ project_id }).where(eq(repositories.id, existing[0].id));
    }
    return c.json({ success: true, id: existing[0].id });
  }

  const id = crypto.randomUUID();
  await db.insert(repositories).values({ id, name, gitlab_path, project_id: project_id ?? null, enabled: 1, added_at: new Date().toISOString() });
  return c.json({ success: true, id });
});

reposCtrl.put('/:id', async (c) => {
  const repoId = c.req.param('id');
  const updates = await c.req.json<{ name?: string; gitlab_path?: string; project_id?: string; enabled?: number }>();
  const db = drizzle(c.env.DB);
  await db.update(repositories).set(updates).where(eq(repositories.id, repoId));
  return c.json({ success: true });
});

reposCtrl.delete('/:id', async (c) => {
  const repoId = c.req.param('id');
  const db = drizzle(c.env.DB);
  await db.delete(repositories).where(eq(repositories.id, repoId));
  return c.json({ success: true });
});

// Live GitLab project search for the picker
reposCtrl.get('/gitlab-search', async (c) => {
  const query = c.req.query('q') ?? '';
  if (!query || query.length < 2) return c.json([]);
  const results = await searchProjects(query, c.env.GITLAB_TOKEN);
  return c.json(results);
});

// Scan ALL GitLab projects with recent activity — no registry dependency.
// Cached in KV for 5 minutes so rapid re-opens don't re-scan.
reposCtrl.get('/active', async (c) => {
  // Read scan window from settings (default 90 days)
  const db = drizzle(c.env.DB);
  let windowDays = 90;
  try {
    const row = await db.select().from(systemSettings).where(eq(systemSettings.key, 'SCAN_WINDOW_DAYS')).get();
    if (row?.value) windowDays = Math.max(1, parseInt(row.value, 10) || 90);
  } catch { /* use default */ }

  const since = c.req.query('since') ?? (() => {
    const d = new Date();
    d.setDate(d.getDate() - windowDays);
    return d.toISOString();
  })();

  const cacheKey = `active_repos:${since.slice(0, 10)}:${windowDays}`; // key by date + window

  // Return cached result if fresh
  const cached = await c.env.NIMBUS_KV.get(cacheKey, 'json');
  if (cached) return c.json(cached);

  const projects = await getRecentlyActiveProjects(since, c.env.GITLAB_TOKEN, 5);

  const results = await batchSequential(
    projects,
    10,
    0,
    async (project) => {
      const classified = await getClassifiedAheadCommits(String(project.id), 'main', 'stage', c.env.GITLAB_TOKEN);
      return {
        id: project.id,
        name: project.name,
        gitlab_path: project.path_with_namespace,
        commitCount: classified.featureCount + classified.hotfixCount, // excludes back-merges
        featureCount: classified.featureCount,
        hotfixCount: classified.hotfixCount,
        backmergeCount: classified.backmergeCount,
      };
    }
  );

  // Filter out repos with ONLY back-merges (no features or hotfixes)
  const filtered = results
    .filter(r => r.commitCount > 0)
    .sort((a, b) => b.commitCount - a.commitCount);

  // Cache for 5 minutes
  await c.env.NIMBUS_KV.put(cacheKey, JSON.stringify(filtered), { expirationTtl: 300 });

  return c.json(filtered);
});

// Resolve project by path to get numeric project_id
reposCtrl.get('/gitlab-resolve', async (c) => {
  const path = c.req.query('path') ?? '';
  if (!path) return c.json({ error: 'path required' }, 400);
  const project = await getProject(path, c.env.GITLAB_TOKEN);
  if (!project) return c.json({ error: 'Project not found' }, 404);
  return c.json(project);
});
