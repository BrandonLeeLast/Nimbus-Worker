import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { releases, releaseRepos, releaseDocuments, repositories, systemSettings } from '../db/schema';
import { compareRefs, createBranch, branchExists, extractTicketIds, getMergedMRs, batchSequential, isCommitOnMain, createMergeRequest } from '../utils/gitlab';
import { getTickets } from '../utils/youtrack';
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
  await db.delete(releaseRepos)
    .where(and(eq(releaseRepos.release_id, c.req.param('id')), eq(releaseRepos.id, c.req.param('repoId'))));
  return c.json({ success: true });
});

// ─── Branch status check ──────────────────────────────────────────────────────
// Returns per-repo whether the release branch exists on GitLab
releasesCtrl.get('/:id/branch-status', async (c) => {
  const releaseId = c.req.param('id');
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

  return c.json({ branch: release.branch_name, repos: results });
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
      const compare = await compareRefs(repo.project_id, 'main', release.branch_name, c.env.GITLAB_TOKEN);
      const allCommits = compare.commits ?? [];
      // Apply same merge-commit filter as the pipeline view
      const commits = hideMergeCommits
        ? allCommits.filter(cm => !MERGE_RE.test(cm.title))
        : allCommits;
      const ticketIds: string[] = [];

      for (const commit of commits) {
        extractTicketIds(commit.title).forEach(t => ticketIds.push(t));
      }

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

  return c.json(results);
});
