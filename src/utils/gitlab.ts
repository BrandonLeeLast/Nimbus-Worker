export const fetchGitLab = async (path: string, token: string, method = 'GET', body?: any) => {
  const options: RequestInit = {
    method,
    headers: { 'PRIVATE-TOKEN': token }
  };
  if (body) {
    options.headers = { ...options.headers, 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`https://gitlab.com/api/v4${path}`, options);
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText })) as any
    throw new Error(error.message || `GitLab API error: ${res.status}`);
  }
  return res.json();
};

export const checkBranchExists = async (projectId: string, branch: string, token: string) => {
  try {
    await fetchGitLab(`/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`, token);
    return true;
  } catch (e: any) {
    if (e.message.includes('404')) return false;
    throw e;
  }
};

export const createBranch = async (projectId: string, branch: string, ref: string, token: string) => {
  return fetchGitLab(`/projects/${projectId}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${ref}`, token, 'POST');
};

export const compareBranches = async (projectId: string, from: string, to: string, token: string) => {
  return fetchGitLab(`/projects/${projectId}/repository/compare?from=${from}&to=${to}`, token);
};
