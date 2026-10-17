import { servedBoardName } from '../../src/serve/route';

// Pure rules of the shell (no electron): where a URL goes, what the saved state may hold.

/** A backend URL as typed ("mini.internal:5310", "http://x:1/") to its origin, or null when it isn't an http(s) address. */
export function normalizeBackend(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export type Target =
  | { kind: 'board'; name: string }
  | { kind: 'home' }
  /** Same backend, some other page: stays in the window that asked. */
  | { kind: 'internal' }
  | { kind: 'external' }
  | { kind: 'deny' };

/** Where a link or window.open to `url` goes, given the backend's origin. */
export function classify(backend: string, url: string): Target {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'deny' };
  }
  if (u.origin === backend) {
    const name = servedBoardName(u.pathname);
    if (name !== null) return { kind: 'board', name };
    if (u.pathname === '/' || u.pathname === '') return { kind: 'home' };
    return { kind: 'internal' };
  }
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? { kind: 'external' } : { kind: 'deny' };
}

export interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}
export interface SavedWindow {
  /** Board name; null = the Boards window. */
  board: string | null;
  bounds?: Bounds;
}
export interface State {
  backend: string;
  windows: SavedWindow[];
  recent: string[];
}

export const RECENT_MAX = 10;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function cleanBounds(b: any): Bounds | undefined {
  if (!b || !num(b.width) || !num(b.height) || b.width < 200 || b.height < 150) return undefined;
  return { width: Math.round(b.width), height: Math.round(b.height), ...(num(b.x) && num(b.y) ? { x: Math.round(b.x), y: Math.round(b.y) } : {}) };
}

/** Read a state file's JSON, keeping only what is valid. `backend` is the fallback when none (or a bad one) is saved. */
export function sanitizeState(raw: unknown, backend: string): State {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const saved = typeof r.backend === 'string' ? normalizeBackend(r.backend) : null;
  const seen = new Set<string | null>();
  const windows: SavedWindow[] = [];
  for (const w of Array.isArray(r.windows) ? r.windows : []) {
    const board = w?.board === null ? null : typeof w?.board === 'string' && w.board ? w.board : undefined;
    if (board === undefined || seen.has(board)) continue;
    seen.add(board);
    windows.push({ board, bounds: cleanBounds(w.bounds) });
  }
  const recent = (Array.isArray(r.recent) ? r.recent : []).filter((x): x is string => typeof x === 'string' && !!x).slice(0, RECENT_MAX);
  return { backend: saved ?? backend, windows, recent };
}

/** `name` first, no repeats, at most RECENT_MAX. */
export const pushRecent = (recent: string[], name: string): string[] => [name, ...recent.filter((n) => n !== name)].slice(0, RECENT_MAX);
