export interface YouTrackTicket {
  id: string;
  summary: string;
  description?: string;
  assignee?: string;
  state?: string;
  priority?: string;
  sprints?: string[];  // sprint names this ticket belongs to
  updated?: number;    // epoch ms
  resolved?: number;   // epoch ms
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
      `${baseUrl}/api/issues/${encodeURIComponent(ticketId)}?fields=id,summary,description,updated,resolved,customFields(name,value(name,login,fullName),values(name))`,
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
      updated?: number;
      resolved?: number;
      customFields?: {
        name: string;
        value: { name?: string; login?: string; fullName?: string } | null;
        values?: { name?: string }[];
      }[];
    };

    const assigneeField = data.customFields?.find(f => f.name === 'Assignee');
    const stateField = data.customFields?.find(f => f.name === 'State');
    const priorityField = data.customFields?.find(f => f.name === 'Priority');
    const sprintField = data.customFields?.find(f => f.name === 'Sprint');
    const sprintNames = sprintField?.values?.map(v => v.name).filter((n): n is string => !!n) ?? [];

    const ticket: YouTrackTicket = {
      id: data.id,
      summary: data.summary,
      description: data.description,
      assignee: assigneeField?.value?.fullName ?? assigneeField?.value?.name,
      state: stateField?.value?.name,
      priority: priorityField?.value?.name,
      sprints: sprintNames,
      updated: data.updated,
      resolved: data.resolved,
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

export interface YouTrackSprint {
  id: string;
  name: string;
  board: string; // agile board name
  start?: number;
  finish?: number;
  archived: boolean;
}

export async function getSprints(baseUrl: string, token: string): Promise<YouTrackSprint[]> {
  const res = await fetch(`${baseUrl}/api/agiles?fields=id,name,sprints(id,name,start,finish,archived)&$top=50`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) return [];

  const boards = await res.json() as {
    id: string;
    name: string;
    sprints?: { id: string; name: string; start?: number; finish?: number; archived: boolean }[];
  }[];

  const results: YouTrackSprint[] = [];
  for (const board of boards) {
    for (const sprint of board.sprints ?? []) {
      results.push({ id: sprint.id, name: sprint.name, board: board.name, start: sprint.start, finish: sprint.finish, archived: sprint.archived });
    }
  }

  // Deduplicate by sprint name (same sprint can appear across multiple boards)
  const seen = new Set<string>();
  const unique = results.filter(s => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });

  // Sort: non-archived first, then by finish date desc
  return unique.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return (b.finish ?? 0) - (a.finish ?? 0);
  });
}

// Query YouTrack for all tickets matching a state query, paginated
export async function getTicketsByQuery(
  query: string,
  baseUrl: string,
  token: string,
  maxTickets = 500,
): Promise<YouTrackTicket[]> {
  const fields = 'id,idReadable,summary,customFields(name,value(name,login,fullName))';
  const perPage = 100;
  const results: YouTrackTicket[] = [];

  for (let skip = 0; skip < maxTickets; skip += perPage) {
    const url = `${baseUrl}/api/issues?query=${encodeURIComponent(query)}&fields=${fields}&$top=${perPage}&$skip=${skip}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) break;
    const batch = await res.json() as {
      id: string;
      idReadable: string;
      summary: string;
      customFields?: { name: string; value: { name?: string; login?: string; fullName?: string } | null }[];
    }[];
    if (!batch.length) break;

    for (const data of batch) {
      const assigneeField = data.customFields?.find(f => f.name === 'Assignee');
      const stateField = data.customFields?.find(f => f.name === 'State');
      const priorityField = data.customFields?.find(f => f.name === 'Priority');
      results.push({
        id: data.idReadable ?? data.id,
        summary: data.summary,
        assignee: assigneeField?.value?.fullName ?? assigneeField?.value?.name,
        state: stateField?.value?.name,
        priority: priorityField?.value?.name,
      });
    }

    if (batch.length < perPage) break;
  }

  return results;
}
