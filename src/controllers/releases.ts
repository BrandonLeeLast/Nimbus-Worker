import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { releases, releaseRepos, releaseDocuments, repositories, systemSettings, executiveDocuments } from '../db/schema';
import { compareRefs, createBranch, branchExists, extractTicketIds, getMergedMRs, batchSequential, isCommitOnMain, createMergeRequest } from '../utils/gitlab';
import { getTickets, getTicketsByQuery, getSprints } from '../utils/youtrack';
import type { Env } from '../index';

export const releasesCtrl = new Hono<{ Bindings: Env }>();

// ─── List all releases ───────────────────────────────────────────────────────
releasesCtrl.get('/', async (c) => {
  const db = drizzle(c.env.DB);
  const all = await db.select().from(releases).orderBy(releases.created_at);
  return c.json(all);
});

// ─── Active release ──────────────────────────────────────────────────────────
releasesCtrl.get('/active', async (c) => {
  const db = drizzle(c.env.DB);
  const setting = await db.select().from(systemSettings).where(eq(systemSettings.key, 'ACTIVE_RELEASE')).limit(1);
  if (!setting[0]) return c.json(null);

  const [release] = await db.select().from(releases).where(eq(releases.id, setting[0].value!)).limit(1);
  if (!release) return c.json(null);

  const rRepos = await db
    .select({ rr: releaseRepos, repo: repositories })
    .from(releaseRepos)
    .innerJoin(repositories, eq(releaseRepos.repo_id, repositories.id))
    .where(eq(releaseRepos.release_id, release.id));

  return c.json({ ...release, repos: rRepos });
});

// ─── YouTrack sprints ─────────────────────────────────────────────────────────
releasesCtrl.get('/youtrack-sprints', async (c) => {
  const cacheKey = 'youtrack_sprints';
  const cached = await c.env.NIMBUS_KV.get(cacheKey, 'json');
  if (cached) return c.json(cached);
  const sprints = await getSprints(c.env.YOUTRACK_BASE_URL, c.env.YOUTRACK_TOKEN);
  await c.env.NIMBUS_KV.put(cacheKey, JSON.stringify(sprints), { expirationTtl: 300 });
  return c.json(sprints);
});

// ─── Get single release ───────────────────────────────────────────────────────
releasesCtrl.get('/:id', async (c) => {
  const db = drizzle(c.env.DB);
  const [release] = await db.select().from(releases).where(eq(releases.id, c.req.param('id'))).limit(1);
  if (!release) return c.json({ error: 'Not found' }, 404);
  return c.json(release);
});

// ─── Create release ───────────────────────────────────────────────────────────
// Creates D1 record, creates the release branch on selected repos in GitLab
releasesCtrl.post('/', async (c) => {
  const { name, repo_ids, create_branches } = await c.req.json<{ name: string; repo_ids: string[]; create_branches: boolean }>();
  if (!name) return c.json({ error: 'Release name required' }, 400);

  // branch name is the release name, e.g. release-20260407
  const branch_name = name.startsWith('release-') ? name : `release-${name}`;

  const db = drizzle(c.env.DB);

  // Complete any existing active release
  const activeSetting = await db.select().from(systemSettings).where(eq(systemSettings.key, 'ACTIVE_RELEASE')).limit(1);
  if (activeSetting[0]) {
    await db.update(releases)
      .set({ status: 'completed', completed_at: new Date().toISOString() })
      .where(eq(releases.id, activeSetting[0].value!));
  }

  const id = crypto.randomUUID();
  await db.insert(releases).values({ id, name, branch_name, status: 'active', created_at: new Date().toISOString() });

  // Store as active
  await db.insert(systemSettings).values({ key: 'ACTIVE_RELEASE', value: id })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: id } });

  // Add repos to release and optionally create GitLab branches from stage
  const branchResults: { repo: string; result: string }[] = [];
  if (repo_ids?.length) {
    const allRepos = await db.select().from(repositories).where(eq(repositories.enabled, 1));
    const filtered = allRepos.filter(r => repo_ids.includes(r.id));

    for (const repo of filtered) {
      await db.insert(releaseRepos).values({
        id: crypto.randomUUID(),
        release_id: id,
        repo_id: repo.id,
        deploy_status: 'deploy',
        risk_level: 'low',
        notes: null,
      }).onConflictDoNothing();

      // Create branch from stage if requested by user at release creation time
      if (create_branches) {
        if (!repo.project_id) {
          branchResults.push({ repo: repo.name, result: 'no project_id — skipped' });
        } else {
          try {
            const result = await createBranch(repo.project_id, branch_name, 'stage', c.env.GITLAB_TOKEN);
            branchResults.push({ repo: repo.name, result: result.created ? 'created' : (result.error ?? 'already exists') });
          } catch (e) {
            branchResults.push({ repo: repo.name, result: `error: ${String(e)}` });
          }
        }
      }
    }
  }

  return c.json({ success: true, id, name, branch_name, branches: branchResults });
});

// ─── Delete release (and all associated data) ────────────────────────────────
releasesCtrl.delete('/:id', async (c) => {
  const releaseId = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [release] = await db.select().from(releases).where(eq(releases.id, releaseId)).limit(1);
  if (!release) return c.json({ error: 'Not found' }, 404);

  // Clear ACTIVE_RELEASE setting if this is the active one
  const setting = await db.select().from(systemSettings).where(eq(systemSettings.key, 'ACTIVE_RELEASE')).limit(1);
  if (setting[0]?.value === releaseId) {
    await db.delete(systemSettings).where(eq(systemSettings.key, 'ACTIVE_RELEASE'));
  }

  // Delete all associated data
  await db.delete(releaseDocuments).where(eq(releaseDocuments.release_id, releaseId));
  await db.delete(releaseRepos).where(eq(releaseRepos.release_id, releaseId));
  await db.delete(releases).where(eq(releases.id, releaseId));

  return c.json({ success: true });
});

// ─── Complete / deploy release ────────────────────────────────────────────────
releasesCtrl.post('/:id/complete', async (c) => {
  const releaseId = c.req.param('id');
  const db = drizzle(c.env.DB);
  await db.update(releases).set({ status: 'completed', completed_at: new Date().toISOString() }).where(eq(releases.id, releaseId));
  // Clear active setting if this was it
  const setting = await db.select().from(systemSettings).where(eq(systemSettings.key, 'ACTIVE_RELEASE')).limit(1);
  if (setting[0]?.value === releaseId) {
    await db.delete(systemSettings).where(eq(systemSettings.key, 'ACTIVE_RELEASE'));
  }
  return c.json({ success: true });
});

// ─── Get repos for a release ──────────────────────────────────────────────────
releasesCtrl.get('/:id/repos', async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select({ rr: releaseRepos, repo: repositories })
    .from(releaseRepos)
    .innerJoin(repositories, eq(releaseRepos.repo_id, repositories.id))
    .where(eq(releaseRepos.release_id, c.req.param('id')));
  return c.json(rows);
});

// ─── Add repo to release ──────────────────────────────────────────────────────
releasesCtrl.post('/:id/repos', async (c) => {
  const releaseId = c.req.param('id');
  const { repo_id, deploy_status, risk_level, notes } = await c.req.json<{
    repo_id: string;
    deploy_status?: string;
    risk_level?: string;
    notes?: string;
  }>();
  if (!repo_id) return c.json({ error: 'repo_id required' }, 400);

  const db = drizzle(c.env.DB);
  const rrId = crypto.randomUUID();
  await db.insert(releaseRepos).values({
    id: rrId,
    release_id: releaseId,
    repo_id,
    deploy_status: deploy_status ?? 'deploy',
    risk_level: risk_level ?? 'low',
    notes: notes ?? null,
  }).onConflictDoNothing();

  await c.env.NIMBUS_KV.delete(`branch_status:${releaseId}`);
  return c.json({ success: true, id: rrId });
});

// ─── Update repo in release (risk, deploy status, notes) ─────────────────────
releasesCtrl.put('/:id/repos/:repoId', async (c) => {
  const db = drizzle(c.env.DB);
  const { deploy_status, risk_level, notes } = await c.req.json<{ deploy_status?: string; risk_level?: string; notes?: string }>();
  await db.update(releaseRepos)
    .set({ deploy_status, risk_level, notes })
    .where(and(eq(releaseRepos.release_id, c.req.param('id')), eq(releaseRepos.id, c.req.param('repoId'))));
  return c.json({ success: true });
});

// ─── Remove repo from release ─────────────────────────────────────────────────
releasesCtrl.delete('/:id/repos/:repoId', async (c) => {
  const db = drizzle(c.env.DB);
  const releaseId = c.req.param('id');
  await db.delete(releaseRepos)
    .where(and(eq(releaseRepos.release_id, releaseId), eq(releaseRepos.id, c.req.param('repoId'))));
  await c.env.NIMBUS_KV.delete(`branch_status:${releaseId}`);
  return c.json({ success: true });
});

// ─── Branch status check ──────────────────────────────────────────────────────
// Returns per-repo whether the release branch exists on GitLab
releasesCtrl.get('/:id/branch-status', async (c) => {
  const releaseId = c.req.param('id');
  const cacheKey = `branch_status:${releaseId}`;
  const cached = await c.env.NIMBUS_KV.get(cacheKey, 'json');
  if (cached) return c.json(cached);

  const db = drizzle(c.env.DB);

  const [release] = await db.select().from(releases).where(eq(releases.id, releaseId)).limit(1);
  if (!release) return c.json({ error: 'Not found' }, 404);

  const rows = await db
    .select({ rr: releaseRepos, repo: repositories })
    .from(releaseRepos)
    .innerJoin(repositories, eq(releaseRepos.repo_id, repositories.id))
    .where(eq(releaseRepos.release_id, releaseId));

  const results = await batchSequential(rows, 5, 100, async ({ repo }) => {
    if (!repo.project_id) return { repoId: repo.id, name: repo.name, exists: null as boolean | null, error: 'no project_id' };
    const exists = await branchExists(repo.project_id, release.branch_name, c.env.GITLAB_TOKEN);
    return { repoId: repo.id, name: repo.name, exists, error: null as string | null };
  });

  const payload = { branch: release.branch_name, repos: results };
  await c.env.NIMBUS_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 });
  return c.json(payload);
});

// ─── Create branches for existing release ────────────────────────────────────
releasesCtrl.post('/:id/create-branches', async (c) => {
  const releaseId = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [release] = await db.select().from(releases).where(eq(releases.id, releaseId)).limit(1);
  if (!release) return c.json({ error: 'Not found' }, 404);

  const rows = await db
    .select({ rr: releaseRepos, repo: repositories })
    .from(releaseRepos)
    .innerJoin(repositories, eq(releaseRepos.repo_id, repositories.id))
    .where(eq(releaseRepos.release_id, releaseId));

  const results = await batchSequential(rows, 3, 300, async ({ repo }) => {
    if (!repo.project_id) return { repo: repo.name, result: 'no project_id — skipped' };
    try {
      const r = await createBranch(repo.project_id, release.branch_name, 'stage', c.env.GITLAB_TOKEN);
      return { repo: repo.name, result: r.created ? 'created' : (r.error ?? 'already exists') };
    } catch (e) {
      return { repo: repo.name, result: `error: ${String(e)}` };
    }
  });

  await c.env.NIMBUS_KV.delete(`branch_status:${releaseId}`);
  return c.json({ branch: release.branch_name, results });
});

// ─── Generate document ────────────────────────────────────────────────────────
// Calls GitLab compare (release branch → stage) + YouTrack enrichment
releasesCtrl.post('/:id/generate', async (c) => {
  const releaseId = c.req.param('id');
  const db = drizzle(c.env.DB);

  // Accept optional filter overrides from the request body
  type GenBody = { hideMergeCommits?: boolean; excludedTicketIds?: string[] };
  const body: GenBody = await c.req.json<GenBody>().catch(() => ({})) as GenBody;

  const hideMergeCommits = body.hideMergeCommits ?? true;
  const MERGE_RE = /^merge branch|^merge remote|^merged? .* into /i;

  const [release] = await db.select().from(releases).where(eq(releases.id, releaseId)).limit(1);
  if (!release) return c.json({ error: 'Release not found' }, 404);

  const rows = await db
    .select({ rr: releaseRepos, repo: repositories })
    .from(releaseRepos)
    .innerJoin(repositories, eq(releaseRepos.repo_id, repositories.id))
    .where(eq(releaseRepos.release_id, releaseId));

  if (!rows.length) return c.json({ error: 'No repos in this release' }, 400);

  // Merge global excluded patterns + per-generate exclusions
  const excludedSetting = await db.select().from(systemSettings).where(eq(systemSettings.key, 'EXCLUDED_TICKET_PATTERNS')).limit(1);
  const globalExcluded = excludedSetting[0]?.value?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
  const extraExcluded = body.excludedTicketIds ?? [];
  const excludedPatterns = [...new Set([...globalExcluded, ...extraExcluded])];

  const allTicketIds = new Set<string>();
  const repoData: {
    repoId: string;
    name: string;
    path: string;
    commitCount: number;
    deployStatus: string;
    riskLevel: string;
    notes: string;
    commits: { id: string; short_id: string; title: string; author_name: string; created_at: string; web_url: string }[];
    ticketIds: string[];
    tickets: { id: string; title: string; assignee: string; priority: string; risk: string; notes: string; excluded: boolean }[];
    sections: { title: string; body: string }[];
    error?: string;
  }[] = [];

  // Process repos in batches to avoid rate limits
  await batchSequential(rows, 3, 300, async ({ rr, repo }) => {
    if (!repo.project_id) {
      repoData.push({
        repoId: repo.id, name: repo.name, path: repo.gitlab_path,
        commitCount: 0, deployStatus: rr.deploy_status ?? 'deploy',
        riskLevel: rr.risk_level ?? 'low', notes: rr.notes ?? '',
        commits: [], ticketIds: [], tickets: [], sections: [],
        error: 'No GitLab project_id configured',
      });
      return;
    }

    try {
      // Compare main → release branch to find what's in this release
      const [compare, mergedMRs] = await Promise.all([
        compareRefs(repo.project_id, 'main', release.branch_name, c.env.GITLAB_TOKEN),
        getMergedMRs(repo.project_id, release.branch_name, c.env.GITLAB_TOKEN),
      ]);
      const allCommits = compare.commits ?? [];

      // Filter out commits that are actually already on main.
      // Only merge commits can have SHA mismatches (same code, different SHA) —
      // regular commits don't have this problem so skip the API check for them.
      // Step 1: pattern-match obvious backmerges (free)
      // Step 2: verify remaining unchecked merge commits via refs API
      const mapped = allCommits.map(cm => ({
        ...cm,
        isMerge: MERGE_RE.test(cm.title),
        onMain: detectOnMainByPattern(cm.title) !== null,
      }));

      const uncheckedMerges = mapped.filter(cm => cm.isMerge && !cm.onMain);
      if (uncheckedMerges.length > 0) {
        await Promise.all(uncheckedMerges.map(async (cm) => {
          const onMain = await isCommitOnMain(repo.project_id!, cm.id, c.env.GITLAB_TOKEN);
          if (onMain) cm.onMain = true;
        }));
      }

      const trueCommits = mapped.filter(cm => !cm.onMain);

      const ticketIds: string[] = [];

      // 1. Extract from commit titles of commits genuinely not on main
      for (const commit of trueCommits) {
        extractTicketIds(commit.title).forEach(t => ticketIds.push(t));
      }

      // 2. Extract from MR source branch names + titles merged into this release branch.
      //    Catches commits with no ticket ID in title but on a branch like Michalis/INDEV-3833_...
      for (const mr of mergedMRs) {
        extractTicketIds(mr.source_branch).forEach(t => ticketIds.push(t));
        extractTicketIds(mr.title).forEach(t => ticketIds.push(t));
      }

      // Filter merge commits from the visible list only (display/count)
      const commits = hideMergeCommits
        ? trueCommits.filter(cm => !cm.isMerge)
        : trueCommits;

      const uniqueTicketIds = [...new Set(ticketIds)];
      uniqueTicketIds.forEach(t => allTicketIds.add(t));

      repoData.push({
        repoId: repo.id, name: repo.name, path: repo.gitlab_path,
        commitCount: commits.length,
        deployStatus: rr.deploy_status ?? 'deploy',
        riskLevel: rr.risk_level ?? 'low',
        notes: rr.notes ?? '',
        commits: commits.slice(0, 50).map(c => ({ id: c.id, short_id: c.short_id, title: c.title, author_name: c.author_name, created_at: c.created_at, web_url: c.web_url })),
        ticketIds: uniqueTicketIds,
        tickets: [],
        sections: [],
      });
    } catch (e) {
      repoData.push({
        repoId: repo.id, name: repo.name, path: repo.gitlab_path,
        commitCount: 0, deployStatus: rr.deploy_status ?? 'deploy',
        riskLevel: rr.risk_level ?? 'low', notes: rr.notes ?? '',
        commits: [], ticketIds: [], tickets: [{ id: 'ERROR', title: String(e), assignee: '', priority: '', risk: '', notes: '', excluded: false }], sections: [],
      });
    }
  });

  // Enrich with YouTrack
  const ticketMap = await getTickets([...allTicketIds], c.env.YOUTRACK_BASE_URL, c.env.YOUTRACK_TOKEN);

  let totalTickets = 0;
  for (const repo of repoData) {
    repo.tickets = repo.ticketIds.map(tid => {
      const yt = ticketMap.get(tid);
      const excluded = excludedPatterns.some(p => tid.includes(p));
      // Map YouTrack priority field to P1-P5 label
      const priority = yt?.priority ?? '';
      return {
        id: tid,
        title: yt?.summary ?? tid,
        assignee: yt?.assignee ?? '',
        priority,
        risk: '',    // filled in manually by user in the doc editor
        notes: '',   // filled in manually by user in the doc editor
        excluded,
      };
    });
    totalTickets += repo.tickets.filter(t => !t.excluded).length;
  }

  const totalCommits = repoData.reduce((sum, r) => sum + r.commitCount, 0);
  const reposModified = repoData.filter(r => r.commitCount > 0).length;

  // If a doc already exists, preserve all manual fields (risk notes, library versions, etc.)
  const existingDoc = await db.select().from(releaseDocuments).where(eq(releaseDocuments.release_id, releaseId)).limit(1);
  const existing = existingDoc[0] ? JSON.parse(existingDoc[0].content) : {};

  const releaseDate = release.created_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const doc = {
    // Preserve all manually-edited fields from existing doc
    releaseLead: existing.releaseLead ?? '',
    releaseBackup: existing.releaseBackup ?? '',
    overallRisk: existing.overallRisk ?? 'Medium',
    riskFactors: existing.riskFactors ?? { dbMigrations: false, breakingApiChanges: false, infrastructureChanges: false, thirdPartyDeps: false, securityPatches: false, featureFlags: false, rollbackPlan: false },
    riskNotes: existing.riskNotes ?? [],
    libraryVersions: existing.libraryVersions ?? [],
    externalDependencies: existing.externalDependencies ?? [],
    dbMigrations: existing.dbMigrations ?? [],
    envVarUpdates: existing.envVarUpdates ?? [],
    deploymentOrder: existing.deploymentOrder ?? repoData.filter(r => r.deployStatus !== 'no-deploy').map(r => r.name),
    preDeployChecklist: existing.preDeployChecklist ?? [
      { item: 'All tests passing (unit, integration, e2e)', checked: false },
      { item: 'Code reviews completed and approved', checked: false },
      { item: 'Configuration files reviewed', checked: false },
      { item: 'Environment variables verified', checked: false },
      { item: 'Rollback plan documented', checked: false },
      { item: 'Stakeholders notified', checked: false },
    ],
    postDeployChecklist: existing.postDeployChecklist ?? [
      { item: 'All services healthy', checked: false },
      { item: 'Error rates normal', checked: false },
      { item: 'Response times within SLA', checked: false },
      { item: 'No critical alerts', checked: false },
      { item: 'User reports monitored', checked: false },
    ],
    rollbackTriggers: existing.rollbackTriggers ?? ['Critical functionality broken', 'Data corruption detected', 'Security vulnerability exposed', 'Performance degradation > 50%'],
    rollbackSteps: existing.rollbackSteps ?? ['Stop new deployments immediately', 'Restore previous Docker images/artifacts', 'Rollback database migrations (if applicable)', 'Verify system stability', 'Notify stakeholders'],
    rollbackTime: existing.rollbackTime ?? '',
    knownIssues: existing.knownIssues ?? [],
    stakeholders: existing.stakeholders ?? [
      { item: 'Development team notified', checked: false },
      { item: 'QA team notified', checked: false },
      { item: 'Product team notified', checked: false },
      { item: 'Operations team notified', checked: false },
      { item: 'Customer support notified', checked: false },
    ],
    deploymentWindow: existing.deploymentWindow ?? { start: '', end: '', estimatedDowntime: '' },
    signOff: existing.signOff ?? { releaseLead: '', technicalLead: '', qaLead: '' },
    highlights: existing.highlights ?? [],
    overview: existing.overview ?? '',
    // Always regenerated from GitLab
    release: { name: release.name, date: releaseDate, branch: release.branch_name },
    summary: { totalCommits, totalTickets, reposModified, reposTotal: repoData.length },
    repos: repoData.map(r => {
      // Preserve per-ticket risk/notes from existing doc if ticket still present
      const existingRepo = (existing.repos ?? []).find((er: { name: string }) => er.name === r.name);
      const ticketMap = new Map((existingRepo?.tickets ?? []).map((t: { id: string }) => [t.id, t]));
      return {
        repoId: r.repoId,
        name: r.name,
        path: r.path,
        commitCount: r.commitCount,
        ticketCount: r.tickets.filter(t => !t.excluded).length,
        deployStatus: existingRepo?.deployStatus ?? r.deployStatus,
        riskLevel: existingRepo?.riskLevel ?? r.riskLevel,
        notes: existingRepo?.notes ?? r.notes,
        sections: existingRepo?.sections ?? r.sections,
        tickets: r.tickets.map(t => {
          const prev = ticketMap.get(t.id) as { risk?: string; notes?: string; excluded?: boolean } | undefined;
          return { ...t, risk: prev?.risk ?? t.risk, notes: prev?.notes ?? t.notes, excluded: prev?.excluded ?? t.excluded };
        }),
      };
    }),
    excludedTickets: existing.excludedTickets ?? [],
  };

  const now = new Date().toISOString();
  await db.insert(releaseDocuments).values({
    id: crypto.randomUUID(),
    release_id: releaseId,
    content: JSON.stringify(doc),
    generated_at: now,
    updated_at: now,
  }).onConflictDoUpdate({
    target: releaseDocuments.release_id,
    set: { content: JSON.stringify(doc), generated_at: now, updated_at: now },
  });

  return c.json({ success: true, summary: doc.summary });
});

// ─── Get document ─────────────────────────────────────────────────────────────
releasesCtrl.get('/:id/document', async (c) => {
  const db = drizzle(c.env.DB);
  const [doc] = await db.select().from(releaseDocuments).where(eq(releaseDocuments.release_id, c.req.param('id'))).limit(1);
  if (!doc) return c.json(null);
  return c.json({ ...doc, content: JSON.parse(doc.content) });
});

// ─── Save edited document ─────────────────────────────────────────────────────
releasesCtrl.put('/:id/document', async (c) => {
  const releaseId = c.req.param('id');
  const body = await c.req.json();
  const db = drizzle(c.env.DB);
  const now = new Date().toISOString();
  await db.update(releaseDocuments)
    .set({ content: JSON.stringify(body), updated_at: now })
    .where(eq(releaseDocuments.release_id, releaseId));
  return c.json({ success: true });
});

// ─── Staging pipeline: commits on stage not yet on main ───────────────────────
// Hybrid approach:
// 1. Pattern matching catches obvious cases (backmerges, hotfix merges, release merges) — zero API cost
// 2. Remaining merge commits get checked via refs API (is commit reachable from main?) — a few calls
// 3. Regular (non-merge) commits are always shown as pending — they don't have the "different SHA" problem

// Patterns for merge commits where code IS on main (via workflow)
const BACKMERGE_MAIN_RE = /^Merge branch ['"]?main['"]? into/i;
const BACKMERGE_MASTER_RE = /^Merge branch ['"]?master['"]? into/i;
const BACKMERGE_STAGE_RE = /^Merge branch ['"]?stage['"]? into/i;
const HOTFIX_MERGE_RE = /^Merge branch ['"]?hotfix\//i;
const RELEASE_MERGE_RE = /^Merge branch ['"]?release-/i;
const ANY_MERGE_RE = /^Merge branch /i;

function detectOnMainByPattern(title: string): string | null {
  if (BACKMERGE_MAIN_RE.test(title) || BACKMERGE_MASTER_RE.test(title)) return 'backmerge';
  if (BACKMERGE_STAGE_RE.test(title)) return 'stage sync';
  if (HOTFIX_MERGE_RE.test(title)) return 'hotfix→release→main';
  if (RELEASE_MERGE_RE.test(title)) return 'release backmerge';
  return null;
}

releasesCtrl.get('/:id/pipeline', async (c) => {
  const releaseId = c.req.param('id');
  const cacheKey = `pipeline:${releaseId}`;
  const cached = await c.env.NIMBUS_KV.get(cacheKey, 'json');
  if (cached) return c.json(cached);

  const db = drizzle(c.env.DB);

  const rows = await db
    .select({ rr: releaseRepos, repo: repositories })
    .from(releaseRepos)
    .innerJoin(repositories, eq(releaseRepos.repo_id, repositories.id))
    .where(eq(releaseRepos.release_id, releaseId));

  const results = await batchSequential(rows, 3, 300, async ({ repo }) => {
    if (!repo.project_id) return { repo: repo.name, path: repo.gitlab_path, commits: [], error: 'no project_id' };
    try {
      const compare = await compareRefs(repo.project_id, 'main', 'stage', c.env.GITLAB_TOKEN);
      const rawCommits = compare.commits ?? [];

      // Step 1: Pattern match all commits
      const mapped = rawCommits.map(cm => ({
        id: cm.short_id,
        fullSha: cm.id,
        title: cm.title,
        author: cm.author_name,
        date: cm.created_at,
        url: cm.web_url,
        tickets: extractTicketIds(cm.title),
        onMainVia: detectOnMainByPattern(cm.title),
        isMerge: ANY_MERGE_RE.test(cm.title),
      }));

      // Step 2: For merge commits NOT caught by patterns, check via refs API
      const uncheckedMerges = mapped.filter(cm => cm.isMerge && !cm.onMainVia);
      if (uncheckedMerges.length > 0) {
        // Check in parallel, these are typically only a few
        await Promise.all(uncheckedMerges.map(async (cm) => {
          const onMain = await isCommitOnMain(repo.project_id!, cm.fullSha, c.env.GITLAB_TOKEN);
          if (onMain) cm.onMainVia = 'verified on main';
        }));
      }

      // Build final output (drop fullSha and isMerge from response)
      const commits = mapped.map(({ fullSha: _, isMerge: __, ...rest }) => rest);

      // Sort by date desc
      commits.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return { repo: repo.name, path: repo.gitlab_path, commits };
    } catch (e) {
      return { repo: repo.name, path: repo.gitlab_path, commits: [], error: String(e) };
    }
  });

  await c.env.NIMBUS_KV.put(cacheKey, JSON.stringify(results), { expirationTtl: 300 });
  return c.json(results);
});

// ─── Create merge requests: release branch → main ─────────────────────────────
releasesCtrl.post('/:id/create-mrs', async (c) => {
  const releaseId = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [release] = await db.select().from(releases).where(eq(releases.id, releaseId)).limit(1);
  if (!release) return c.json({ error: 'Not found' }, 404);

  const rows = await db
    .select({ rr: releaseRepos, repo: repositories })
    .from(releaseRepos)
    .innerJoin(repositories, eq(releaseRepos.repo_id, repositories.id))
    .where(eq(releaseRepos.release_id, releaseId));

  const mrTitle = `Deploy: Merge ${release.branch_name} into main`;

  const results = await batchSequential(rows, 3, 300, async ({ repo }) => {
    if (!repo.project_id) return { repo: repo.name, result: 'skipped', error: 'no project_id' };
    try {
      const mr = await createMergeRequest(
        repo.project_id,
        release.branch_name,
        'main',
        mrTitle,
        c.env.GITLAB_TOKEN
      );
      return {
        repo: repo.name,
        result: mr.created ? 'created' : (mr.error ?? 'already exists'),
        url: mr.url ?? null,
        iid: mr.iid ?? null,
      };
    } catch (e) {
      return { repo: repo.name, result: 'error', error: String(e) };
    }
  });

  return c.json({ branch: release.branch_name, results });
});

// ─── Hotfixes: MRs merged to main ────────────────────────────────────────────
releasesCtrl.get('/:id/hotfixes', async (c) => {
  const releaseId = c.req.param('id');
  const cacheKey = `hotfixes:${releaseId}`;
  const cached = await c.env.NIMBUS_KV.get(cacheKey, 'json');
  if (cached) return c.json(cached);

  const db = drizzle(c.env.DB);

  const rows = await db
    .select({ rr: releaseRepos, repo: repositories })
    .from(releaseRepos)
    .innerJoin(repositories, eq(releaseRepos.repo_id, repositories.id))
    .where(eq(releaseRepos.release_id, releaseId));

  const results = await batchSequential(rows, 3, 300, async ({ repo }) => {
    if (!repo.project_id) return { repo: repo.name, mrs: [], error: 'no project_id' };
    try {
      const mrs = await getMergedMRs(repo.project_id, 'main', c.env.GITLAB_TOKEN);
      return {
        repo: repo.name,
        path: repo.gitlab_path,
        mrs: mrs.map(mr => ({
          iid: mr.iid,
          title: mr.title,
          author: mr.author.name,
          merged_at: mr.merged_at,
          url: mr.web_url,
          source_branch: mr.source_branch,
          tickets: extractTicketIds(mr.title + ' ' + mr.description),
        })),
      };
    } catch (e) {
      return { repo: repo.name, mrs: [], error: String(e) };
    }
  });

  await c.env.NIMBUS_KV.put(cacheKey, JSON.stringify(results), { expirationTtl: 300 });
  return c.json(results);
});

// ─── Recon ────────────────────────────────────────────────────────────────────
// Cross-references tickets found in release commits against YouTrack board state.
// Returns:
//   - releaseTickets: every ticket found in commits, with current YT state + repo(s)
//   - stageOnlyTickets: tickets on YT board in stage states but NOT in this release
releasesCtrl.get('/:id/recon', async (c) => {
  const releaseId = c.req.param('id');
  const sprintName = c.req.query('sprint') ?? '';
  const cacheKey = `recon:${releaseId}:${sprintName}`;
  const cached = await c.env.NIMBUS_KV.get(cacheKey, 'json');
  if (cached) return c.json(cached);

  const db = drizzle(c.env.DB);

  // Load saved doc to get ticket IDs we already know about from commits
  const [docRow] = await db.select().from(releaseDocuments).where(eq(releaseDocuments.release_id, releaseId)).limit(1);
  if (!docRow) return c.json({ error: 'No generated document found — generate the release doc first' }, 400);

  const doc = JSON.parse(docRow.content) as {
    repos: { name: string; path: string; tickets: { id: string; title: string; assignee: string; excluded: boolean }[] }[];
  };

  // Build map of ticketId -> repos it appears in
  const ticketRepoMap = new Map<string, string[]>();
  for (const repo of doc.repos) {
    for (const t of repo.tickets) {
      if (!ticketRepoMap.has(t.id)) ticketRepoMap.set(t.id, []);
      ticketRepoMap.get(t.id)!.push(repo.name);
    }
  }

  const releaseTicketIds = [...ticketRepoMap.keys()];

  // Fetch fresh current state for all release tickets from YouTrack
  const ytMap = await getTickets(releaseTicketIds, c.env.YOUTRACK_BASE_URL, c.env.YOUTRACK_TOKEN);

  const releaseTickets = releaseTicketIds.map(id => {
    const yt = ytMap.get(id);
    const repoTicket = doc.repos.flatMap(r => r.tickets).find(t => t.id === id);
    return {
      id,
      title: yt?.summary ?? repoTicket?.title ?? id,
      assignee: yt?.assignee ?? repoTicket?.assignee ?? '',
      state: yt?.state ?? 'Unknown',
      priority: yt?.priority ?? '',
      repos: ticketRepoMap.get(id) ?? [],
      excluded: repoTicket?.excluded ?? false,
    };
  });

  // Get configured YouTrack project (falls back to prefixes derived from release tickets)
  const projectSetting = await db.select().from(systemSettings).where(eq(systemSettings.key, 'YOUTRACK_PROJECT')).limit(1);
  let projectPrefixes: string[];
  if (projectSetting[0]?.value) {
    projectPrefixes = projectSetting[0].value.split(',').map((p: string) => p.trim()).filter(Boolean);
  } else {
    projectPrefixes = [...new Set(releaseTicketIds.map(id => id.split('-')[0]).filter(Boolean))];
  }
  const projectFilter = projectPrefixes.map(p => `project: ${p}`).join(' OR ');
  const stateFilter = 'State: {Staging} OR State: {Stage Testing} OR State: {Stage Approved}';
  const sprintFilter = sprintName ? ` AND Sprint: {${sprintName}}` : '';
  const stageQuery = projectPrefixes.length
    ? `(${projectFilter}) AND (${stateFilter})${sprintFilter}`
    : `${stateFilter}${sprintFilter}`;

  // Fetch all tickets currently in stage states from YouTrack board (optionally filtered by sprint)
  const stageTickets = await getTicketsByQuery(stageQuery, c.env.YOUTRACK_BASE_URL, c.env.YOUTRACK_TOKEN);

  // Stage-only = on board in stage state but not in this release
  const releaseIdSet = new Set(releaseTicketIds);
  const stageOnlyTickets = stageTickets
    .filter(t => !releaseIdSet.has(t.id))
    .map(t => ({
      id: t.id,
      title: t.summary,
      assignee: t.assignee ?? '',
      state: t.state ?? 'Unknown',
      priority: t.priority ?? '',
    }));

  const payload = { releaseTickets, stageOnlyTickets };
  await c.env.NIMBUS_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 });
  return c.json(payload);
});

// ─── Executive Documents ─────────────────────────────────────────────────────

// GET saved executive doc
releasesCtrl.get('/:id/executive', async (c) => {
  const db = drizzle(c.env.DB);
  const [row] = await db.select().from(executiveDocuments).where(eq(executiveDocuments.release_id, c.req.param('id'))).limit(1);
  if (!row) return c.json(null);
  return c.json({ ...row, content: JSON.parse(row.content) });
});

// PUT save/update executive doc (manual edits)
releasesCtrl.put('/:id/executive', async (c) => {
  const releaseId = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const db = drizzle(c.env.DB);
  const now = new Date().toISOString();
  const content = JSON.stringify(body);

  const [existing] = await db.select().from(executiveDocuments).where(eq(executiveDocuments.release_id, releaseId)).limit(1);
  if (existing) {
    await db.update(executiveDocuments).set({ content, updated_at: now }).where(eq(executiveDocuments.release_id, releaseId));
  } else {
    await db.insert(executiveDocuments).values({ id: crypto.randomUUID(), release_id: releaseId, content, generated_at: now, updated_at: now });
  }
  return c.json({ ok: true });
});

// POST generate executive doc with Workers AI
releasesCtrl.post('/:id/executive/generate', async (c) => {
  const releaseId = c.req.param('id');
  const db = drizzle(c.env.DB);

  // Load the release doc (source data)
  const [docRow] = await db.select().from(releaseDocuments).where(eq(releaseDocuments.release_id, releaseId)).limit(1);
  if (!docRow) return c.json({ error: 'Generate the release document first' }, 400);

  const [release] = await db.select().from(releases).where(eq(releases.id, releaseId)).limit(1);
  if (!release) return c.json({ error: 'Release not found' }, 404);

  const releaseDoc = JSON.parse(docRow.content) as {
    releaseLead: string;
    releaseBackup: string;
    overallRisk: string;
    riskFactors: Record<string, boolean>;
    riskNotes: string[];
    overview: string;
    summary: { totalCommits: number; totalTickets: number; reposModified: number; reposTotal: number };
    repos: { name: string; path: string; commitCount: number; tickets: { id: string; title: string; assignee: string; notes: string; excluded: boolean }[] }[];
  };

  // Collect all non-excluded tickets
  const allTickets: { id: string; title: string; assignee: string; repo: string; notes: string }[] = [];
  for (const repo of releaseDoc.repos) {
    for (const t of repo.tickets) {
      if (!t.excluded) allTickets.push({ id: t.id, title: t.title, assignee: t.assignee, repo: repo.name, notes: t.notes });
    }
  }

  const repoNames = releaseDoc.repos.map(r => r.name);
  const activeRiskFactors = Object.entries(releaseDoc.riskFactors ?? {}).filter(([, v]) => v).map(([k]) => k.replace(/([A-Z])/g, ' $1').trim());

  // Build the prompt for Workers AI
  const ticketList = allTickets.map(t => `- ${t.id}: ${t.title}${t.notes ? ` (Note: ${t.notes})` : ''} [Repo: ${t.repo}]`).join('\n');

  const prompt = `You are a technical writer creating executive-level release documentation. Write for non-technical stakeholders (executives, product managers, customer support).

RELEASE INFO:
- Name: ${release.name}
- Date: ${release.created_at ?? 'TBD'}
- Release Lead: ${releaseDoc.releaseLead || 'TBD'}
- Overall Risk: ${releaseDoc.overallRisk || 'Low'}
- Active Risk Factors: ${activeRiskFactors.join(', ') || 'None'}
- Risk Notes: ${(releaseDoc.riskNotes ?? []).join('; ') || 'None'}
- Total Commits: ${releaseDoc.summary.totalCommits}
- Projects: ${repoNames.join(', ')} (${repoNames.length} total)

TICKETS IN THIS RELEASE (${allTickets.length} total):
${ticketList}

INSTRUCTIONS:
Generate a JSON response with this EXACT structure (no markdown, just raw JSON):
{
  "executiveSummary": "2-3 paragraphs summarizing the release in business terms. Focus on customer impact, business value. No technical jargon.",
  "features": [{"name": "Feature Name", "description": "1-2 sentence business description"}],
  "improvements": [{"name": "Improvement Name", "description": "1-2 sentence description"}],
  "fixes": [{"name": "Fix Name", "description": "1-2 sentence customer impact description"}],
  "customerExperience": "1-2 paragraphs on customer impact",
  "operationalEfficiency": "1-2 paragraphs on operational improvements",
  "revenueGrowth": "1-2 paragraphs on revenue/growth implications",
  "riskMitigation": "1-2 paragraphs on risk reduction",
  "totalChanges": "${allTickets.length} tickets across ${repoNames.length} systems",
  "projectsUpdated": "description of backend/frontend split",
  "keyIntegrations": "list any third-party integrations mentioned",
  "riskFactors": ["plain language risk factor 1", "risk factor 2"],
  "mitigationStrategies": ["mitigation strategy 1", "strategy 2"],
  "ticketSummaries": [{"id": "TICKET-ID", "summary": "Plain-language 1-sentence summary of what this change means for users/business"}]
}

RULES:
- Every ticket from the list MUST appear in ticketSummaries
- Categorize tickets into features (new functionality), improvements (enhancements), and fixes (bug fixes)
- Write in active voice: "Enables X" not "X is enabled"
- No technical jargon: "login security" not "auth token validation"
- Focus on business impact and customer value
- Return ONLY valid JSON, no markdown wrapping`;

  try {
    const aiResult = await c.env.AI.run('@cf/meta/llama-3.1-70b-instruct' as any, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    }) as { response?: string };

    const raw = aiResult.response ?? '';

    // Try to extract JSON from the response
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return c.json({ error: 'AI returned invalid response', raw }, 500);
      parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
    }

    // Build the executive doc
    const execDoc = {
      releaseName: release.name,
      releaseDate: release.created_at ?? '',
      releaseLead: releaseDoc.releaseLead ?? '',
      executiveSummary: parsed.executiveSummary ?? '',
      features: parsed.features ?? [],
      improvements: parsed.improvements ?? [],
      fixes: parsed.fixes ?? [],
      customerExperience: parsed.customerExperience ?? '',
      operationalEfficiency: parsed.operationalEfficiency ?? '',
      revenueGrowth: parsed.revenueGrowth ?? '',
      riskMitigation: parsed.riskMitigation ?? '',
      totalChanges: parsed.totalChanges ?? `${allTickets.length} tickets`,
      projectsUpdated: parsed.projectsUpdated ?? `${repoNames.length} projects`,
      keyIntegrations: parsed.keyIntegrations ?? '',
      overallRisk: releaseDoc.overallRisk ?? 'Low',
      riskFactors: parsed.riskFactors ?? [],
      mitigationStrategies: parsed.mitigationStrategies ?? [],
      ticketSummaries: parsed.ticketSummaries ?? allTickets.map(t => ({ id: t.id, summary: t.title })),
    };

    // Save to DB
    const now = new Date().toISOString();
    const content = JSON.stringify(execDoc);
    const [existing] = await db.select().from(executiveDocuments).where(eq(executiveDocuments.release_id, releaseId)).limit(1);
    if (existing) {
      await db.update(executiveDocuments).set({ content, updated_at: now }).where(eq(executiveDocuments.release_id, releaseId));
    } else {
      await db.insert(executiveDocuments).values({ id: crypto.randomUUID(), release_id: releaseId, content, generated_at: now, updated_at: now });
    }

    return c.json(execDoc);
  } catch (e) {
    return c.json({ error: `AI generation failed: ${e}` }, 500);
  }
});

// ─── Export executive overview as markdown ─────────────────────────────────
releasesCtrl.get('/:id/executive/overview-markdown', async (c) => {
  const db = drizzle(c.env.DB);
  const [row] = await db.select().from(executiveDocuments).where(eq(executiveDocuments.release_id, c.req.param('id'))).limit(1);
  if (!row) return c.json({ error: 'Executive document not found' }, 404);

  const doc = JSON.parse(row.content) as Record<string, unknown>;
  const features = (doc.features as Array<{ name: string; description: string }> | undefined) ?? [];
  const improvements = (doc.improvements as Array<{ name: string; description: string }> | undefined) ?? [];
  const fixes = (doc.fixes as Array<{ name: string; description: string }> | undefined) ?? [];
  const riskFactors = (doc.riskFactors as string[] | undefined) ?? [];
  const mitigationStrategies = (doc.mitigationStrategies as string[] | undefined) ?? [];

  const markdown = `# Executive Release Overview

**Release Name:** ${doc.releaseName ?? 'TBD'}  
**Release Date:** ${doc.releaseDate ? new Date(doc.releaseDate as string).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD'}  
**Release Lead:** ${doc.releaseLead ?? 'TBD'}

---

## Executive Summary

${doc.executiveSummary ?? 'No summary available.'}

---

## Key Deliverables

### New Features & Capabilities

${features.map(f => `- **${f.name}**: ${f.description}`).join('\n')}

### Platform Improvements

${improvements.map(i => `- **${i.name}**: ${i.description}`).join('\n')}

### Critical Fixes

${fixes.map(f => `- **${f.name}**: ${f.description}`).join('\n')}

---

## Business Impact

### Customer Experience

${doc.customerExperience ?? 'No customer experience data.'}

### Operational Efficiency

${doc.operationalEfficiency ?? 'No operational efficiency data.'}

### Revenue & Growth

${doc.revenueGrowth ?? 'No revenue growth data.'}

### Risk Mitigation

${doc.riskMitigation ?? 'No risk mitigation data.'}

---

## Release Scope

**Total Changes:** ${doc.totalChanges ?? 'N/A'}  
**Projects Updated:** ${doc.projectsUpdated ?? 'N/A'}  
**Key Integrations:** ${doc.keyIntegrations ?? 'None'}

---

## Risk Assessment

**Overall Risk Level:** ${doc.overallRisk ?? 'Low'}

### Key Risk Factors:
${riskFactors.map(rf => `- ${rf}`).join('\n')}

### Mitigation Strategies:
${mitigationStrategies.map(ms => `- ${ms}`).join('\n')}

---

**Document Version:** 1.0  
**Last Updated:** ${row.updated_at ? new Date(row.updated_at).toLocaleDateString() : 'N/A'}`;

  return c.text(markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="Release-${String(doc.releaseName ?? 'Executive').replace(/\s+/g, '-')}-ExecutiveOverview.md"` });
});

// ─── Export executive ticket summaries as markdown ────────────────────────
releasesCtrl.get('/:id/executive/summaries-markdown', async (c) => {
  const db = drizzle(c.env.DB);
  const [row] = await db.select().from(executiveDocuments).where(eq(executiveDocuments.release_id, c.req.param('id'))).limit(1);
  if (!row) return c.json({ error: 'Executive document not found' }, 404);

  const doc = JSON.parse(row.content) as Record<string, unknown>;
  const ticketSummaries = (doc.ticketSummaries as Array<{ id: string; summary: string }> | undefined) ?? [];

  const markdown = `# Executive Ticket Summaries

**Release:** ${doc.releaseName ?? 'TBD'}  
**Release Date:** ${doc.releaseDate ? new Date(doc.releaseDate as string).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD'}

This document provides plain-language summaries of each ticket included in the release.

---

${ticketSummaries.map((t: { id: string; summary: string }) => `[${t.id}] - ${t.summary}`).join('\n\n')}

---

**Document Version:** 1.0  
**Last Updated:** ${row.updated_at ? new Date(row.updated_at).toLocaleDateString() : 'N/A'}`;

  return c.text(markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="Release-${String(doc.releaseName ?? 'Executive').replace(/\s+/g, '-')}-ExecutiveTicketSummaries.md"` });
});

// ─── Preview executive overview as HTML ───────────────────────────────────
releasesCtrl.get('/:id/executive/overview-preview', async (c) => {
  const db = drizzle(c.env.DB);
  const [row] = await db.select().from(executiveDocuments).where(eq(executiveDocuments.release_id, c.req.param('id'))).limit(1);
  if (!row) return c.json({ error: 'Executive document not found' }, 404);

  const doc = JSON.parse(row.content) as Record<string, unknown>;
  const features = (doc.features as Array<{ name: string; description: string }> | undefined) ?? [];
  const improvements = (doc.improvements as Array<{ name: string; description: string }> | undefined) ?? [];
  const fixes = (doc.fixes as Array<{ name: string; description: string }> | undefined) ?? [];
  const riskFactors = (doc.riskFactors as string[] | undefined) ?? [];
  const mitigationStrategies = (doc.mitigationStrategies as string[] | undefined) ?? [];

  const releaseDate = doc.releaseDate ? new Date(doc.releaseDate as string).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Executive Release Overview - ${doc.releaseName ?? 'Release'}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; background: #f5f5f5; padding: 40px 20px; }
    .container { max-width: 900px; margin: 0 auto; background: white; padding: 60px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { font-size: 32px; margin: 0 0 30px 0; padding-bottom: 15px; border-bottom: 3px solid #d84a36; }
    h2 { font-size: 20px; margin: 30px 0 15px 0; padding-bottom: 10px; border-bottom: 1px solid #ddd; }
    h3 { font-size: 16px; margin: 20px 0 10px 0; color: #555; }
    .section { margin-bottom: 40px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; padding: 15px; background: #f9f9f9; border-radius: 6px; }
    .info-item { }
    .info-label { font-weight: 600; color: #666; font-size: 12px; text-transform: uppercase; margin-bottom: 5px; }
    .info-value { font-size: 16px; color: #333; }
    ul { margin: 15px 0; padding-left: 20px; }
    li { margin: 8px 0; }
    li strong { color: #d84a36; }
    .subsection-title { font-weight: 600; margin: 15px 0 10px 0; font-size: 14px; }
    p { margin: 10px 0; }
    .risk-high { color: #d32f2f; }
    .risk-medium { color: #f57c00; }
    .risk-low { color: #388e3c; }
    @media (max-width: 768px) {
      .container { padding: 30px; }
      h1 { font-size: 24px; }
      .info-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Executive Release Overview</h1>
    
    <div class="section">
      <h2>Release Information</h2>
      <div class="info-grid">
        <div class="info-item">
          <div class="info-label">Release Name</div>
          <div class="info-value">${doc.releaseName ?? 'TBD'}</div>
        </div>
        <div class="info-item">
          <div class="info-label">Release Date</div>
          <div class="info-value">${releaseDate}</div>
        </div>
        <div class="info-item">
          <div class="info-label">Release Lead</div>
          <div class="info-value">${doc.releaseLead ?? 'TBD'}</div>
        </div>
        <div class="info-item">
          <div class="info-label">Overall Risk Level</div>
          <div class="info-value risk-${(doc.overallRisk ?? 'low').toLowerCase()}">${doc.overallRisk ?? 'Low'}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Executive Summary</h2>
      <p>${String(doc.executiveSummary ?? 'No summary available.').replace(/\n/g, '</p><p>')}</p>
    </div>

    <div class="section">
      <h2>Key Deliverables</h2>
      
      <div class="subsection-title">New Features & Capabilities</div>
      <ul>
        ${features.map((f: { name: string; description: string }) => `<li><strong>${f.name}:</strong> ${f.description}</li>`).join('\n')}
      </ul>

      <div class="subsection-title">Platform Improvements</div>
      <ul>
        ${improvements.map((i: { name: string; description: string }) => `<li><strong>${i.name}:</strong> ${i.description}</li>`).join('\n')}
      </ul>

      <div class="subsection-title">Critical Fixes</div>
      <ul>
        ${fixes.map((f: { name: string; description: string }) => `<li><strong>${f.name}:</strong> ${f.description}</li>`).join('\n')}
      </ul>
    </div>

    <div class="section">
      <h2>Business Impact</h2>
      
      <div class="subsection-title">Customer Experience</div>
      <p>${String(doc.customerExperience ?? 'No data').replace(/\n/g, '</p><p>')}</p>

      <div class="subsection-title">Operational Efficiency</div>
      <p>${String(doc.operationalEfficiency ?? 'No data').replace(/\n/g, '</p><p>')}</p>

      <div class="subsection-title">Revenue & Growth</div>
      <p>${String(doc.revenueGrowth ?? 'No data').replace(/\n/g, '</p><p>')}</p>

      <div class="subsection-title">Risk Mitigation</div>
      <p>${String(doc.riskMitigation ?? 'No data').replace(/\n/g, '</p><p>')}</p>
    </div>

    <div class="section">
      <h2>Release Scope</h2>
      <div class="info-grid">
        <div class="info-item">
          <div class="info-label">Total Changes</div>
          <div class="info-value">${doc.totalChanges ?? 'N/A'}</div>
        </div>
        <div class="info-item">
          <div class="info-label">Projects Updated</div>
          <div class="info-value">${doc.projectsUpdated ?? 'N/A'}</div>
        </div>
      </div>
      <div class="info-item" style="margin-top: 15px;">
        <div class="info-label">Key Integrations</div>
        <div class="info-value">${doc.keyIntegrations ?? 'None'}</div>
      </div>
    </div>

    <div class="section">
      <h2>Risk Assessment</h2>
      <h3>Key Risk Factors:</h3>
      <ul>
        ${riskFactors.map((rf: string) => `<li>${rf}</li>`).join('\n')}
      </ul>
      <h3>Mitigation Strategies:</h3>
      <ul>
        ${mitigationStrategies.map((ms: string) => `<li>${ms}</li>`).join('\n')}
      </ul>
    </div>

    <div style="margin-top: 60px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #999;">
      <p>Document Version: 1.0<br>Last Updated: ${row.updated_at ? new Date(row.updated_at).toLocaleDateString() : 'N/A'}</p>
    </div>
  </div>
</body>
</html>`;

  return c.html(html);
});

// ─── Preview executive ticket summaries as HTML ────────────────────────────
releasesCtrl.get('/:id/executive/summaries-preview', async (c) => {
  const db = drizzle(c.env.DB);
  const [row] = await db.select().from(executiveDocuments).where(eq(executiveDocuments.release_id, c.req.param('id'))).limit(1);
  if (!row) return c.json({ error: 'Executive document not found' }, 404);

  const doc = JSON.parse(row.content) as Record<string, unknown>;
  const ticketSummaries = (doc.ticketSummaries as Array<{ id: string; summary: string }> | undefined) ?? [];
  const releaseDate = doc.releaseDate ? new Date(doc.releaseDate as string).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Executive Ticket Summaries - ${doc.releaseName ?? 'Release'}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; background: #f5f5f5; padding: 40px 20px; }
    .container { max-width: 900px; margin: 0 auto; background: white; padding: 60px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { font-size: 32px; margin: 0 0 30px 0; padding-bottom: 15px; border-bottom: 3px solid #d84a36; }
    h2 { font-size: 18px; margin: 0 0 20px 0; color: #666; font-weight: 600; }
    .ticket { margin: 20px 0; padding: 15px; background: #f9f9f9; border-left: 4px solid #d84a36; border-radius: 4px; }
    .ticket-id { font-weight: 600; color: #d84a36; font-size: 14px; }
    .ticket-summary { margin-top: 8px; color: #333; }
    @media (max-width: 768px) {
      .container { padding: 30px; }
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Executive Ticket Summaries</h1>
    
    <h2>Release: ${doc.releaseName ?? 'TBD'}</h2>
    <h2>Release Date: ${releaseDate}</h2>
    
    <p style="margin: 30px 0; color: #666;">This document provides plain-language summaries of each ticket included in the release.</p>

    <div style="margin-top: 40px;">
      ${ticketSummaries.map((t: { id: string; summary: string }) => `
        <div class="ticket">
          <div class="ticket-id">[${t.id}]</div>
          <div class="ticket-summary">${t.summary}</div>
        </div>
      `).join('\n')}
    </div>

    <div style="margin-top: 60px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #999;">
      <p>Document Version: 1.0<br>Last Updated: ${row.updated_at ? new Date(row.updated_at).toLocaleDateString() : 'N/A'}</p>
    </div>
  </div>
</body>
</html>`;

  return c.html(html);
});

// ─── Export executive overview as PDF (printable HTML) ──────────────────────
releasesCtrl.get('/:id/executive/overview-pdf', async (c) => {
  const db = drizzle(c.env.DB);
  const [row] = await db.select().from(executiveDocuments).where(eq(executiveDocuments.release_id, c.req.param('id'))).limit(1);
  if (!row) return c.json({ error: 'Executive document not found' }, 404);

  const doc = JSON.parse(row.content) as Record<string, unknown>;
  const features = (doc.features as Array<{ name: string; description: string }> | undefined) ?? [];
  const improvements = (doc.improvements as Array<{ name: string; description: string }> | undefined) ?? [];
  const fixes = (doc.fixes as Array<{ name: string; description: string }> | undefined) ?? [];
  const riskFactors = (doc.riskFactors as string[] | undefined) ?? [];
  const mitigationStrategies = (doc.mitigationStrategies as string[] | undefined) ?? [];
  const releaseDate = doc.releaseDate ? new Date(doc.releaseDate as string).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';

  const pdfHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Executive Release Overview</title><style>body{font-family:'Segoe UI';line-height:1.6;color:#333;margin:0;padding:20px;}h1{font-size:28px;margin:0 0 20px;border-bottom:3px solid #d84a36;padding-bottom:10px;}h2{font-size:16px;margin:20px 0 10px;border-bottom:1px solid #ddd;padding-bottom:8px;}h3{font-size:14px;margin:15px 0 8px;}ul{margin:10px 0 10px 20px;}li{margin:6px 0;}strong{color:#d84a36;}p{margin:8px 0;}@media print{body{margin:0;padding:0;}}</style></head><body>
<h1>Executive Release Overview</h1>
<p><strong>Release Name:</strong> ${doc.releaseName ?? 'TBD'}</p>
<p><strong>Release Date:</strong> ${releaseDate}</p>
<p><strong>Release Lead:</strong> ${doc.releaseLead ?? 'TBD'}</p>
<h2>Executive Summary</h2>
<p>${String(doc.executiveSummary ?? 'No summary available.').replace(/\n/g, '</p><p>')}</p>
<h2>Key Deliverables</h2>
<h3>New Features & Capabilities</h3>
<ul>${features.map((f: { name: string; description: string }) => `<li><strong>${f.name}:</strong> ${f.description}</li>`).join('')}</ul>
<h3>Platform Improvements</h3>
<ul>${improvements.map((i: { name: string; description: string }) => `<li><strong>${i.name}:</strong> ${i.description}</li>`).join('')}</ul>
<h3>Critical Fixes</h3>
<ul>${fixes.map((f: { name: string; description: string }) => `<li><strong>${f.name}:</strong> ${f.description}</li>`).join('')}</ul>
<h2>Business Impact</h2>
<h3>Customer Experience</h3>
<p>${String(doc.customerExperience ?? 'No data').replace(/\n/g, '</p><p>')}</p>
<h3>Operational Efficiency</h3>
<p>${String(doc.operationalEfficiency ?? 'No data').replace(/\n/g, '</p><p>')}</p>
<h3>Revenue & Growth</h3>
<p>${String(doc.revenueGrowth ?? 'No data').replace(/\n/g, '</p><p>')}</p>
<h3>Risk Mitigation</h3>
<p>${String(doc.riskMitigation ?? 'No data').replace(/\n/g, '</p><p>')}</p>
<h2>Release Scope</h2>
<p><strong>Total Changes:</strong> ${doc.totalChanges ?? 'N/A'}</p>
<p><strong>Projects Updated:</strong> ${doc.projectsUpdated ?? 'N/A'}</p>
<p><strong>Key Integrations:</strong> ${doc.keyIntegrations ?? 'None'}</p>
<h2>Risk Assessment</h2>
<p><strong>Overall Risk Level:</strong> ${doc.overallRisk ?? 'Low'}</p>
<h3>Key Risk Factors:</h3>
<ul>${riskFactors.map((rf: string) => `<li>${rf}</li>`).join('')}</ul>
<h3>Mitigation Strategies:</h3>
<ul>${mitigationStrategies.map((ms: string) => `<li>${ms}</li>`).join('')}</ul>
</body></html>`;

  return c.html(pdfHtml, 200, { 'Content-Disposition': `attachment; filename="Release-${String(doc.releaseName ?? 'Executive').replace(/\s+/g, '-')}-ExecutiveOverview.html"` });
});

// ─── Export executive ticket summaries as PDF (printable HTML) ──────────────
releasesCtrl.get('/:id/executive/summaries-pdf', async (c) => {
  const db = drizzle(c.env.DB);
  const [row] = await db.select().from(executiveDocuments).where(eq(executiveDocuments.release_id, c.req.param('id'))).limit(1);
  if (!row) return c.json({ error: 'Executive document not found' }, 404);

  const doc = JSON.parse(row.content) as Record<string, unknown>;
  const ticketSummaries = (doc.ticketSummaries as Array<{ id: string; summary: string }> | undefined) ?? [];
  const releaseDate = doc.releaseDate ? new Date(doc.releaseDate as string).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';

  const pdfHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Executive Ticket Summaries</title><style>body{font-family:'Segoe UI';line-height:1.6;color:#333;margin:0;padding:20px;}h1{font-size:28px;margin:0 0 20px;border-bottom:3px solid #d84a36;padding-bottom:10px;}.ticket{margin:12px 0;padding:10px;background:#f9f9f9;border-left:3px solid #d84a36;}.ticket-id{font-weight:600;color:#d84a36;font-size:11px;}.ticket-summary{margin-top:6px;color:#333;font-size:12px;}@media print{body{margin:0;padding:0;}}</style></head><body>
<h1>Executive Ticket Summaries</h1>
<p><strong>Release:</strong> ${doc.releaseName ?? 'TBD'}</p>
<p><strong>Release Date:</strong> ${releaseDate}</p>
<p style="margin:20px 0;color:#666;">This document provides plain-language summaries of each ticket included in the release.</p>
${ticketSummaries.map((t: { id: string; summary: string }) => `<div class="ticket"><div class="ticket-id">[${t.id}]</div><div class="ticket-summary">${t.summary}</div></div>`).join('\n')}
</body></html>`;

  return c.html(pdfHtml, 200, { 'Content-Disposition': `attachment; filename="Release-${String(doc.releaseName ?? 'Executive').replace(/\s+/g, '-')}-ExecutiveTicketSummaries.html"` });
});
