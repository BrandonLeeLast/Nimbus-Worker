export interface YouTrackTicket {
  id: string;
  summary: string;
  description?: string;
  assignee?: string;
  state?: string;
  priority?: string;
}

type YouTrackResult =
  | { ok: true; data: YouTrackTicket }
  | { ok: false; status: number; error: string };

export async function getTicket(
  ticketId: string,
  baseUrl: string,
  token: string
): Promise<YouTrackResult> {
  try {
    const res = await fetch(
      `${baseUrl}/api/issues/${encodeURIComponent(ticketId)}?fields=id,summary,description,customFields(name,value(name,login,fullName))`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      }
    );

    if (res.status === 401) return { ok: false, status: 401, error: 'Unauthorized' };
    if (res.status === 403) return { ok: false, status: 403, error: 'Forbidden' };
    if (res.status === 404) return { ok: false, status: 404, error: 'Not found' };
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };

    const data = await res.json() as {
      id: string;
      summary: string;
      description?: string;
      customFields?: { name: string; value: { name?: string; login?: string; fullName?: string } | null }[];
    };

    const assigneeField = data.customFields?.find(f => f.name === 'Assignee');
    const stateField = data.customFields?.find(f => f.name === 'State');
    const priorityField = data.customFields?.find(f => f.name === 'Priority');

    const ticket: YouTrackTicket = {
      id: data.id,
      summary: data.summary,
      description: data.description,
      assignee: assigneeField?.value?.fullName ?? assigneeField?.value?.name,
      state: stateField?.value?.name,
      priority: priorityField?.value?.name,
    };

    return { ok: true, data: ticket };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

export async function getTickets(
  ticketIds: string[],
  baseUrl: string,
  token: string
): Promise<Map<string, YouTrackTicket>> {
  const map = new Map<string, YouTrackTicket>();
  // Sequential to avoid rate limits
  for (const id of ticketIds) {
    const result = await getTicket(id, baseUrl, token);
    if (result.ok) map.set(id, result.data);
  }
  return map;
}
