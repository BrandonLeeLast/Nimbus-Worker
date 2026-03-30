export const fetchYouTrack = async (ticketId: string, baseUrl: string, token: string) => {
  const fields = 'summary,assignee(name,login),customFields(id,name,value(name,login))';
  const url = `${baseUrl}/api/issues/${ticketId}?fields=${fields}`;
  
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (!res.ok) return null;
  return res.json();
};
