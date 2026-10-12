import { isRoomId } from './model';

// Going into a portal is going to its room (one room per page: its own doc, provider, players).
// The way back is a breadcrumb trail carried in the URL (`via=~,sprint-index`; `~` = the solo
// table), so a reload or a shared link keeps it and no state is stored anywhere.

export const SOLO = '~';

const valid = (r: string) => r === SOLO || isRoomId(r);

export function trailFromUrl(loc: Pick<Location, 'search'> = location): string[] {
  const v = new URLSearchParams(loc.search).get('via');
  return v ? v.split(',').filter(valid).slice(-12) : [];
}

/** URL of `room` (or the solo table for `~`), carrying `trail`. Keeps `?signal=` and `?portals=1`. */
export function roomUrl(room: string, trail: string[], loc: Pick<Location, 'href' | 'search'> = location): string {
  const u = new URL(loc.href);
  const q = new URLSearchParams(loc.search);
  const signal = q.get('signal');
  u.search = '';
  if (room !== SOLO) u.searchParams.set('room', room);
  if (signal) u.searchParams.set('signal', signal);
  if (q.get('portals') === '1') u.searchParams.set('portals', '1');
  if (trail.length) u.searchParams.set('via', trail.join(','));
  return u.toString();
}

/** Where a portal into `room` leads from here (`current` null = the solo table). */
export function enterUrl(room: string, current: string | null, trail: string[], loc?: Pick<Location, 'href' | 'search'>): string {
  const here = current ?? SOLO;
  // entering a room already on the trail goes back to it (no loops in the breadcrumb)
  const at = trail.indexOf(room);
  if (at >= 0) return roomUrl(room, trail.slice(0, at), loc);
  return roomUrl(room, [...trail, here], loc);
}

/** Breadcrumb in the toolbar: the rooms the portals came through, each a link back. */
export function mountBreadcrumb(bar: HTMLElement, current: string | null, trail: string[]) {
  if (!trail.length) return;
  const nav = document.createElement('span');
  nav.className = 'fr-crumbs';
  const name = (r: string) => (r === SOLO ? 'My table' : r);
  trail.forEach((r, i) => {
    const a = document.createElement('a');
    a.href = roomUrl(r, trail.slice(0, i));
    a.textContent = name(r);
    a.title = `Back to ${name(r)}`;
    nav.append(a, Object.assign(document.createElement('i'), { textContent: '›' }));
  });
  const here = document.createElement('b');
  here.textContent = name(current ?? SOLO);
  nav.append(here);
  bar.prepend(nav);
}
