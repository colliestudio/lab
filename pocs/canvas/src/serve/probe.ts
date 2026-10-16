// Before a page at /b/<name> joins the board, one request to the board's status says whether a canvas
// service answers and why a board might not open. Hosts without a service (canvas.lab, vite) answer a
// path like this with index.html or plain text, which counts as "no service": the page boots as before.

export type Probe =
  | { kind: 'ok'; name: string }
  | { kind: 'missing'; error: string }
  | { kind: 'newer'; error: string }
  | { kind: 'failed'; error: string }
  | { kind: 'none' };

export function classifyStatus(status: number, contentType: string | null, body: string): Probe {
  if (!/^application\/json\s*(;|$)/i.test(contentType ?? '')) return { kind: 'none' };
  let json: { name?: unknown; error?: unknown; kind?: unknown };
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: 'none' };
  }
  if (typeof json !== 'object' || json === null) return { kind: 'none' };
  if (status === 200 && typeof json.name === 'string') return { kind: 'ok', name: json.name };
  const error = typeof json.error === 'string' ? json.error : `HTTP ${status}`;
  if (status === 404) return { kind: 'missing', error };
  if ((status === 409 || status === 422) && json.kind === 'newer') return { kind: 'newer', error };
  return { kind: 'failed', error };
}

export async function probeBoard(name: string, fetchFn: typeof fetch = fetch, timeoutMs = 4000): Promise<Probe> {
  try {
    const r = await fetchFn(`/api/boards/${encodeURIComponent(name)}/status`, { signal: AbortSignal.timeout(timeoutMs) });
    return classifyStatus(r.status, r.headers.get('content-type'), await r.text());
  } catch {
    return { kind: 'failed', error: 'Could not reach the canvas service' };
  }
}
