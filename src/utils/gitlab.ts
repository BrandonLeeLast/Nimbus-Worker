export const fetchGitLab = async (path: string, token: string, method = 'GET', body?: any) => {
  if (!token) {
    throw new Error('GITLAB_TOKEN is missing from environment');
  }

  console.log(`[GitLab] ${method} ${path} (token: ${token.substring(0, 6)}...)`);

  const options: RequestInit = {
    method,
    headers: {
      'PRIVATE-TOKEN': token.trim(),
      'Accept': 'application/json',
      'User-Agent': 'Nimbus-Release-Tracker'
    }
  };
  if (body) {
    options.headers = { ...options.headers, 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`https://gitlab.com/api/v4${path}`, options);

  if (res.status === 401) throw new Error('GitLab: Unauthorized — GITLAB_TOKEN is invalid or expired');
  if (res.status === 403) throw new Error('GitLab: Forbidden — token lacks required scopes (needs api or read_api)');
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After') || 'unknown';
    throw new Error(`GitLab: Rate limited — retry after ${retryAfter}s`);
  }

  if (!res.ok) {
    const errorText = await res.text();
    let errorJson: any;
    try { errorJson = JSON.parse(errorText); } catch { errorJson = { message: errorText }; }
    console.error(`[GitLab] ${method} ${path} failed (${res.status}): ${JSON.stringify(errorJson)}`);
    throw new Error(errorJson.message || errorJson.error || `GitLab API error: ${res.status}`);
  }

  return res.json();
};

export const checkBranchExists = async (projectId: string, branch: string, token: string) => {
  try {
    await fetchGitLab(`/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`, token);
    return true;
  } catch (e: any) {
    if (e.message.includes('404') || e.message.includes('Branch Not Found')) return false;
    throw e;
  }
};

export const createBranch = async (projectId: string, branch: string, ref: string, token: string) => {
  return fetchGitLab(`/projects/${projectId}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${ref}`, token, 'POST');
};

export const compareBranches = async (projectId: string, from: string, to: string, token: string) => {
  return fetchGitLab(`/projects/${projectId}/repository/compare?from=${from}&to=${to}`, token);
};

/** Run async tasks sequentially in batches with a small delay between batches to avoid rate limits. */
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
    if (i + batchSize < items.length && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}
