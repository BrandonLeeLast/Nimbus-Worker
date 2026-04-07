const GITLAB_BASE = 'https://gitlab.worldsportsbetting.co.za/api/v4';

async function gitlabFetch(path: string, token: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${GITLAB_BASE}${path}`, {
    ...options,
    headers: {
      'PRIVATE-TOKEN': token,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (res.status === 401) throw new Error('GitLab: Unauthorized — token is invalid or expired');
  if (res.status === 403) throw new Error('GitLab: Forbidden — token lacks required scopes');
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After') ?? '?';
    throw new Error(`GitLab: Rate limited — retry after ${retryAfter}s`);
  }
  return res;
}

export interface GitLabCommit {
  id: string;
  short_id: string;
  title: string;
  author_name: string;
  author_email: string;
  created_at: string;
  web_url: string;
}

export interface GitLabMR {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: string;
  author: { name: string; username: string };
  merged_at: string | null;
  web_url: string;
  target_branch: string;
  source_branch: string;
}

export interface CompareResult {
  commits: GitLabCommit[];
  web_url: string;
}

// Compare two refs — used to find commits on `from` not yet on `to`
export async function compareRefs(
  projectId: string,
  from: string,
  to: string,
  token: string
): Promise<CompareResult> {
  const res = await gitlabFetch(
    `/projects/${encodeURIComponent(projectId)}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=true`,
    token
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitLab compare failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<CompareResult>;
}

// Get merged MRs targeting a branch
export async function getMergedMRs(projectId: string, targetBranch: string, token: string): Promise<GitLabMR[]> {
  const res = await gitlabFetch(
    `/projects/${encodeURIComponent(projectId)}/merge_requests?state=merged&target_branch=${encodeURIComponent(targetBranch)}&per_page=100`,
    token
  );
  if (!res.ok) return [];
  return res.json() as Promise<GitLabMR[]>;
}

// Create a branch from a source ref
export async function createBranch(
  projectId: string,
  branchName: string,
  ref: string,
  token: string
): Promise<{ created: boolean; branch: string; error?: string }> {
  const res = await fetch(`${GITLAB_BASE}/projects/${encodeURIComponent(projectId)}/repository/branches`, {
    method: 'POST',
    headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: branchName, ref }),
  });

  if (res.status === 409) return { created: false, branch: branchName, error: 'already exists' };
  if (res.status === 401) throw new Error('GitLab: Unauthorized — token is invalid or expired');
  if (res.status === 403) throw new Error('GitLab: Forbidden — token lacks required scopes');
  if (!res.ok) {
    const body = await res.text();
    return { created: false, branch: branchName, error: `${res.status}: ${body}` };
  }

  return { created: true, branch: branchName };
}

// Check if a branch exists on a project (returns true/false, no throw)
export async function branchExists(projectId: string, branchName: string, token: string): Promise<boolean> {
  const res = await gitlabFetch(
    `/projects/${encodeURIComponent(projectId)}/repository/branches/${encodeURIComponent(branchName)}`,
    token
  );
  return res.status === 200;
}

export interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
}

// Fetch all projects with activity after a given ISO date string.
// Pages through GitLab (up to maxPages) — each page is 100 projects.
export async function getRecentlyActiveProjects(
  since: string,
  token: string,
  maxPages = 5
): Promise<GitLabProject[]> {
  const results: GitLabProject[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await gitlabFetch(
      `/projects?last_activity_after=${encodeURIComponent(since)}&order_by=last_activity_at&sort=desc&per_page=100&simple=true&page=${page}`,
      token
    );
    if (!res.ok) break;
    const batch = await res.json() as GitLabProject[];
    results.push(...batch);
    // If we got fewer than 100 we've hit the last page
    if (batch.length < 100) break;
  }
  return results;
}

// Search projects by name
export async function searchProjects(query: string, token: string): Promise<{ id: number; name: string; path_with_namespace: string }[]> {
  const res = await gitlabFetch(`/projects?search=${encodeURIComponent(query)}&per_page=20&simple=true`, token);
  if (!res.ok) return [];
  return res.json() as Promise<{ id: number; name: string; path_with_namespace: string }[]>;
}

// Get a single project by path or ID
export async function getProject(projectPath: string, token: string): Promise<{ id: number; name: string; path_with_namespace: string } | null> {
  const res = await gitlabFetch(`/projects/${encodeURIComponent(projectPath)}`, token);
  if (!res.ok) return null;
  return res.json() as Promise<{ id: number; name: string; path_with_namespace: string }>;
}

// Extract ticket IDs from text using pattern OPENBET-123, INDEV-456, etc.
export function extractTicketIds(text: string): string[] {
  const matches = text.match(/\b([A-Z]{2,}-\d+)\b/g);
  return matches ? [...new Set(matches)] : [];
}

// Lightweight check: how many commits does `to` have that `from` does not?
// Returns commit count only — use for "has changes" detection without pulling full data.
export async function countAheadCommits(
  projectId: string,
  from: string,
  to: string,
  token: string
): Promise<number> {
  try {
    const res = await gitlabFetch(
      `/projects/${encodeURIComponent(projectId)}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=true`,
      token
    );
    if (!res.ok) return 0;
    const data = await res.json() as { commits?: unknown[] };
    return data.commits?.length ?? 0;
  } catch {
    return 0; // don't fail the whole scan if one repo errors
  }
}

// Classify commits as feature / hotfix / backmerge
export interface ClassifiedCommits {
  total: number;
  featureCount: number;
  hotfixCount: number;
  backmergeCount: number;
}

const BACKMERGE_PATTERNS = [
  /^Merge branch 'main'/i,
  /^Merge branch 'master'/i,
  /^Merge remote-tracking branch 'origin\/main'/i,
  /^Merge remote-tracking branch 'origin\/master'/i,
];

const HOTFIX_PATTERNS = [
  /hotfix\//i,
  /^\[hotfix\]/i,
];

function classifyCommit(title: string): 'feature' | 'hotfix' | 'backmerge' {
  if (BACKMERGE_PATTERNS.some(p => p.test(title))) return 'backmerge';
  if (HOTFIX_PATTERNS.some(p => p.test(title))) return 'hotfix';
  return 'feature';
}

// Compare two refs and classify the ahead commits by type
export async function getClassifiedAheadCommits(
  projectId: string,
  from: string,
  to: string,
  token: string
): Promise<ClassifiedCommits> {
  try {
    const res = await gitlabFetch(
      `/projects/${encodeURIComponent(projectId)}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=true`,
      token
    );
    if (!res.ok) return { total: 0, featureCount: 0, hotfixCount: 0, backmergeCount: 0 };
    const data = await res.json() as { commits?: { title: string }[] };
    const commits = data.commits ?? [];

    let featureCount = 0;
    let hotfixCount = 0;
    let backmergeCount = 0;
    for (const c of commits) {
      const type = classifyCommit(c.title);
      if (type === 'backmerge') backmergeCount++;
      else if (type === 'hotfix') hotfixCount++;
      else featureCount++;
    }

    return { total: commits.length, featureCount, hotfixCount, backmergeCount };
  } catch {
    return { total: 0, featureCount: 0, hotfixCount: 0, backmergeCount: 0 };
  }
}

// Run items in batches with delay to avoid rate limits
export async function batchSequential<T, R>(
  items: T[],
  batchSize: number,
  delayMs: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}
