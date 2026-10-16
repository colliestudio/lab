import type { BoardEntry } from './api';
import { boardHref } from './route';

export interface Row {
  name: string;
  href: string;
  modified: string;
  modifiedTitle: string;
  /** '' = idle, 'open · 2 browsers', 'open · 1 browser', 'loaded' (held by an agent or until the idle timer). */
  state: string;
  error?: string;
}

export const emptyText = 'No boards yet. Name one above to start.';

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} d ago` : new Date(ms).toLocaleDateString();
}

/** The list's rows, in the server's order. */
export function toRows(entries: BoardEntry[], now = Date.now()): Row[] {
  return entries.map((e) => ({
    name: e.name,
    href: boardHref(e.name),
    modified: e.modified ? ago(e.modified, now) : '',
    modifiedTitle: e.modified ? new Date(e.modified).toLocaleString() : '',
    state: e.browsers > 0 ? `open · ${e.browsers} browser${e.browsers === 1 ? '' : 's'}` : e.loaded ? 'loaded' : '',
    ...(e.error ? { error: e.error } : {}),
  }));
}
