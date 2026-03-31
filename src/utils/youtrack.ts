export type YouTrackResult =
  | { ok: true; data: any }
  | { ok: false; status: number; error: string }

export const fetchYouTrack = async (ticketId: string, baseUrl: string, token: string): Promise<YouTrackResult> => {
  const fields = 'summary,assignee(name,login),customFields(id,name,value(name,login))';
  const url = `${baseUrl}/api/issues/${ticketId}?fields=${fields}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  } catch (e: any) {
    return { ok: false, status: 0, error: `Network error: ${e.message}` };
  }

  if (res.status === 401) return { ok: false, status: 401, error: 'YouTrack: Unauthorized — check YOUTRACK_TOKEN' };
  if (res.status === 403) return { ok: false, status: 403, error: 'YouTrack: Forbidden — token lacks permissions' };
  if (res.status === 404) return { ok: false, status: 404, error: `YouTrack: Ticket ${ticketId} not found` };
  if (!res.ok) return { ok: false, status: res.status, error: `YouTrack: HTTP ${res.status}` };

  const data = await res.json();
  return { ok: true, data };
};
