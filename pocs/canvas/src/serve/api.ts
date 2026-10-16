// The board list's calls to the service (same origin). POSTs say they are JSON: the service refuses others.

/** A row of GET /api/boards (server/core/directory.ts BoardEntry). */
export interface BoardEntry {
  name: string;
  loaded: boolean;
  browsers: number;
  modified?: number;
  error?: string;
}

/** A refused or failed call: the service's own message when it sent one. */
export class ServeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The service's reason for a conflict: 'newer' (format) or 'invalid'; none = the name exists. */
    readonly kind?: string,
  ) {
    super(message);
    this.name = 'ServeError';
  }
}

async function call<T>(fetchFn: typeof fetch, path: string, body?: unknown): Promise<T> {
  const r = await fetchFn(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new ServeError(r.status, typeof json?.error === 'string' ? json.error : `HTTP ${r.status}${text ? ': ' + text.slice(0, 200) : ''}`, typeof json?.kind === 'string' ? json.kind : undefined);
  if (json === undefined) throw new ServeError(r.status, 'the answer is not JSON (is this a canvas service?)');
  return json;
}

const board = (name: string) => `/api/boards/${encodeURIComponent(name)}`;

export const listBoards = (f: typeof fetch = fetch) => call<BoardEntry[]>(f, '/api/boards');
export const createBoard = (name: string, f: typeof fetch = fetch) => call<{ name: string }>(f, '/api/boards', { name });
/** A new board holding `text` (a canvas file). */
export const importBoard = (name: string, text: string, f: typeof fetch = fetch) => call<{ name: string }>(f, '/api/boards', { name, text });
export const renameBoard = (name: string, to: string, f: typeof fetch = fetch) => call<{ name: string }>(f, `${board(name)}/rename`, { to });
export const deleteBoard = (name: string, f: typeof fetch = fetch) => call<unknown>(f, `${board(name)}/delete`, {});
