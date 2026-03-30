export function normalizeTicket(ticketId: string): string {
  // Extract just the numeric part
  const match = ticketId.match(/\d+/);
  if (!match) return ticketId.toUpperCase();
  return `INDEV-${match[0]}`;
}

export function extractTickets(text: string): string[] {
  if (!text) return [];

  const tickets = new Set<string>();
  
  // Patterns from legacy scripts:
  // OPENBET-1234, OPENBET1234, OPENBET_1234, OB1234, OB_1234, INDEV-1234, INDEV1234, INDEV_1234, /1234
  const patterns = [
    /OPENBET-(\d{4}(?:-\d{4})*)/gi,
    /OPENBET(?!-)(\d{4})/gi,
    /OPENBET_(\d{4})/gi,
    /\bOB(\d{4})\b/gi,
    /\bOB_(\d{4})\b/gi,
    /INDEV-(\d{4}(?:-\d{4})*)/gi,
    /INDEV(?!-)(\d{4})/gi,
    /INDEV_(\d{4})/gi,
    /(?<!\d)\/(\d{4})\b/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      // If it's a range like 1234-5678, split it
      const rawValue = match[1];
      if (rawValue.includes('-')) {
        rawValue.split('-').forEach(part => {
          if (part.trim()) tickets.add(normalizeTicket(part.trim()));
        });
      } else {
        tickets.add(normalizeTicket(rawValue));
      }
    }
  }

  return Array.from(tickets);
}
