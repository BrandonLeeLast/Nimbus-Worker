import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { systemSettings, releaseRepos, repositories } from '../db/schema';
import type { Env } from '../index';

export const webhooksCtrl = new Hono<{ Bindings: Env }>();

// GitLab MR webhook — auto-marks repo as active when MR merges to stage
webhooksCtrl.post('/gitlab', async (c) => {
  const payload = await c.req.json<{
    object_kind: string;
    object_attributes: {
      action: string;
      target_branch: string;
      source_branch: string;
      title: string;
      url: string;
    };
    project: { id: number; path_with_namespace: string; name: string };
  }>();

  if (payload.object_kind !== 'merge_request') return c.json({ ok: true });
  if (payload.object_attributes.action !== 'merge') return c.json({ ok: true });
  if (payload.object_attributes.target_branch !== 'stage') return c.json({ ok: true });

  const db = drizzle(c.env.DB);

  // Get active release
  const [setting] = await db.select().from(systemSettings).where(eq(systemSettings.key, 'ACTIVE_RELEASE')).limit(1);
  if (!setting?.value) return c.json({ ok: true, skipped: 'no active release' });

  const releaseId = setting.value;
  const projectId = String(payload.project.id);

  // Find repo by project_id
  const [repo] = await db.select().from(repositories).where(eq(repositories.project_id, projectId)).limit(1);
  if (!repo) return c.json({ ok: true, skipped: 'repo not in registry' });

  // Upsert into release_repos
  await db.insert(releaseRepos).values({
    id: crypto.randomUUID(),
    release_id: releaseId,
    repo_id: repo.id,
    deploy_status: 'deploy',
    risk_level: 'low',
    notes: null,
  }).onConflictDoNothing();

  return c.json({ ok: true, added: repo.name });
});
