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
  | { kind: 'canvas'; name: string }
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
    if (name !== null) return { kind: 'canvas', name };
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
export interface MainWindow {
  /** Canvas name; null = the canvas list. */
  canvas: string | null;
  bounds?: Bounds;
}
export interface State {
  backend: string;
  main: MainWindow;
  recent: string[];
}

export const RECENT_MAX = 10;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function cleanBounds(b: any): Bounds | undefined {
  if (!b || !num(b.width) || !num(b.height) || b.width < 200 || b.height < 150) return undefined;
  return { width: Math.round(b.width), height: Math.round(b.height), ...(num(b.x) && num(b.y) ? { x: Math.round(b.x), y: Math.round(b.y) } : {}) };
}

const cleanName = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && v ? v : undefined);

/** Read a state file's JSON, keeping only what is valid. `backend` is the fallback when none (or a bad one) is saved.
 *  0.2.x kept a list of windows (`windows`); the first one becomes the main window. */
export function sanitizeState(raw: unknown, backend: string): State {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const saved = typeof r.backend === 'string' ? normalizeBackend(r.backend) : null;
  const m = r.main && typeof r.main === 'object' ? r.main : Array.isArray(r.windows) ? r.windows.find((w: any) => w && cleanName(w.canvas ?? w.board) !== undefined) : undefined;
  const canvas = cleanName(m?.canvas ?? m?.board) ?? null;
  const recent = (Array.isArray(r.recent) ? r.recent : []).filter((x): x is string => typeof x === 'string' && !!x).slice(0, RECENT_MAX);
  return { backend: saved ?? backend, main: { canvas, bounds: cleanBounds(m?.bounds) }, recent };
}

/** `name` first, no repeats, at most RECENT_MAX. */
export const pushRecent = (recent: string[], name: string): string[] => [name, ...recent.filter((n) => n !== name)].slice(0, RECENT_MAX);

// ---------------------------------------------------------------- pop-outs

/** The arguments of a launch: `--canvas=<name>` makes a pop-out instance, `--open-canvas=<name>` asks the main app to show one. */
export function parseArgs(argv: string[]): { popout?: string; open?: string } {
  const val = (flag: string) => {
    const a = argv.find((x) => x.startsWith(`--${flag}=`));
    return a ? a.slice(flag.length + 3) || undefined : undefined;
  };
  return { popout: val('canvas'), open: val('open-canvas') };
}

/** A short stable hash (FNV-1a, 32 bit, hex) of a name: the key of its pop-out's folder and socket. */
export function nameHash(name: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(name)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** The folder name of a pop-out instance: readable slug plus the hash (two names may share a slug). */
export const popoutId = (name: string): string => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'canvas'}-${nameHash(name)}`;

/** What a pop-out's Dock icon shows: the canvas' first letter on a color that stays the same for that name. */
export function iconSpec(name: string): { letter: string; hue: number } {
  const letter = Array.from(name.trim()).find((c) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(c)) ?? '#';
  return { letter: letter.toUpperCase(), hue: parseInt(nameHash(name).slice(0, 4), 16) % 360 };
}

export const pageTitle = (canvas: string | null): string => canvas ?? 'Canvases';
