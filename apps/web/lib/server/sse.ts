export function frameFor(body: string | null, last: string): string {
  if (body === null) return "event: stale\ndata: {}\n\n";
  return body === last ? ": ping\n\n" : `data: ${body}\n\n`;
}
