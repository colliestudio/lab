import type * as Y from 'yjs';
import type { App } from './app';
import type { CanvasNode } from './doc';
import { ago, textFor, type LogEvent } from './log';

// What players see of the event log: an in-place cue for each new entry (a label bubble in the
// actor's color near the object, a short animation on it) and a collapsible log panel. Everything
// shown is the viewer's own text (see log.ts textFor): never a card they can't see.

/** New entries older than this (another device's history arriving) get no cue. */
const CUE_FRESH_MS = 15_000;
/** At most this many cues per batch of new entries. */
const CUE_MAX = 4;
const BUBBLE_MS = 2600;
const OPEN_KEY = 'canvas-poc:log-open';
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
};

/** First target the local viewer can see (rendered, not hidden from them), if any. */
export function anchorOf(app: App, e: Pick<LogEvent, 'targets'>): CanvasNode | undefined {
  for (const id of e.targets ?? []) {
    const n = app.node(id);
    if (n && app.doc.isVisible(id) && !app.isConcealed(n) && !app.hiddenFrom(n)) return n;
  }
}

/** Replay an element's CSS animation class. */
function animate(box: HTMLElement, cls: string, ms = 700) {
  box.classList.remove(cls);
  void box.offsetWidth;
  box.classList.add(cls);
  setTimeout(() => box.classList.remove(cls), ms);
}

/** Cues + log panel. `parent`: where the panel goes (default: the page). */
export function mountLog(app: App, parent: HTMLElement = document.body) {
  const store = app.store;
  const vp = app.viewport;

  // ---- in-place cues
  const layer = el('div', 'cv-cues');
  app.view.root.append(layer);
  type Bubble = { el: HTMLElement; x: number; y: number; anchor: string };
  const bubbles = new Set<Bubble>();
  /** Above the object (clear of its tab), kept inside the table's visible area. */
  const place = (b: Bubble) => {
    const r = app.view.root;
    const label = b.el.firstElementChild as HTMLElement;
    const w = label.offsetWidth;
    const h = label.offsetHeight + 30; // the label sits 30px above the anchor point
    let sx = b.x * vp.zoom + vp.x;
    let sy = b.y * vp.zoom + vp.y;
    if (r.clientWidth) sx = Math.max(w / 2 + 8, Math.min(r.clientWidth - w / 2 - 8, sx));
    if (r.clientHeight) sy = Math.max(h + 64, Math.min(r.clientHeight - 8, sy));
    b.el.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px)`;
  };
  vp.onChange(() => bubbles.forEach(place));

  const cue = (e: LogEvent) => {
    const at = anchorOf(app, e);
    if (!at) return;
    for (const b of bubbles) if (b.anchor === at.id) b.el.remove(), bubbles.delete(b);
    const b: Bubble = { el: el('div', 'cv-bubble'), x: at.x + at.width / 2, y: at.y, anchor: at.id };
    const label = el('span', 'cv-bubble-text');
    label.textContent = line(e);
    if (e.actor) label.style.setProperty('--cv-actor', e.actor.color);
    b.el.append(label);
    layer.append(b.el);
    place(b);
    bubbles.add(b);
    setTimeout(() => b.el.classList.add('cv-bubble-out'), BUBBLE_MS - 400);
    setTimeout(() => {
      b.el.remove();
      bubbles.delete(b);
    }, BUBBLE_MS);
    // the animation on the object (only targets this viewer may see)
    const seen = (e.targets ?? []).filter((id) => {
      const n = app.node(id);
      return n && !app.isConcealed(n) && !app.hiddenFrom(n);
    });
    seen.slice(0, 12).forEach((id, i) => {
      const box = app.view.boxOf(id);
      if (box) animate(box, i === 0 && e.cue ? `cv-cue-${e.cue}` : 'cv-cue-pulse');
    });
  };

  // ---- panel
  const panel = el('div', 'cv-log');
  const list = el('ol', 'cv-log-list');
  const head = el('button', 'cv-log-head');
  head.title = 'Event log (⇧L)';
  const headText = el('span', '');
  headText.textContent = 'Log';
  const badge = el('span', 'cv-log-badge');
  head.append(headText, badge);
  panel.append(list, head);
  parent.append(panel);
  let open = false;
  try {
    open = localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    /* no storage */
  }
  /** Last entry the local player has seen (the panel was open when it came). */
  let seenId: string | undefined;

  const line = (e: LogEvent) => {
    const body = textFor(e, app.viewer);
    if (!e.actor) return body.charAt(0).toUpperCase() + body.slice(1);
    return `${e.actor.id === app.viewer ? 'You' : e.actor.name} ${body}`;
  };
  const entries = () => store.log.toArray();

  const renderBadge = () => {
    if (open) return (badge.hidden = true);
    const all = entries();
    const from = seenId ? all.findIndex((e) => e.id === seenId) + 1 : 0;
    const n = all.slice(from).filter((e) => e.actor?.id !== app.viewer).length;
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
  };

  const renderList = () => {
    if (!open) return;
    const pinned = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
    const now = Date.now();
    const all = entries();
    list.replaceChildren(
      ...all.map((e) => {
        const li = el('li', 'cv-log-entry');
        li.dataset.id = e.id;
        if (e.actor) {
          const who = el('span', 'cv-log-who');
          who.textContent = e.actor.id === app.viewer ? 'You' : e.actor.name;
          who.style.setProperty('--cv-actor', e.actor.color);
          li.append(who, ' ');
        }
        const body = textFor(e, app.viewer);
        li.append(e.actor ? body : body.charAt(0).toUpperCase() + body.slice(1));
        const t = el('time', 'cv-log-time');
        t.textContent = ago(now - e.time);
        t.title = new Date(e.time).toLocaleTimeString();
        li.append(t);
        if (anchorOf(app, e)) li.classList.add('cv-log-go');
        return li;
      }),
    );
    if (!all.length) {
      const li = el('li', 'cv-log-empty');
      li.textContent = 'Nothing yet: shuffles, draws, plays and claims show up here';
      list.append(li);
    }
    if (pinned) list.scrollTop = list.scrollHeight;
    seenId = all.at(-1)?.id;
  };

  const setOpen = (v: boolean) => {
    open = v;
    panel.classList.toggle('cv-log-open', open);
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      /* no storage */
    }
    if (open) {
      renderList();
      list.scrollTop = list.scrollHeight;
    }
    renderBadge();
  };
  const toggle = () => setOpen(!open);
  head.addEventListener('click', toggle);

  // click an entry: center the view on what it's about (zoom kept) and pulse it
  list.addEventListener('click', (ev) => {
    const li = (ev.target as Element).closest<HTMLElement>('.cv-log-entry');
    const e = li && entries().find((x) => x.id === li.dataset.id);
    const at = e && anchorOf(app, e);
    if (!at) return;
    const r = app.view.root;
    vp.set(r.clientWidth / 2 - (at.x + at.width / 2) * vp.zoom, r.clientHeight / 2 - (at.y + at.height / 2) * vp.zoom, vp.zoom);
    const box = app.view.boxOf(at.id);
    if (box) animate(box, 'cv-cue-pulse');
  });

  store.log.observe((ev: Y.YArrayEvent<LogEvent>) => {
    const added: LogEvent[] = [];
    for (const d of ev.changes.delta) if (d.insert) added.push(...(d.insert as LogEvent[]));
    const now = Date.now();
    added
      .filter((e) => Math.abs(now - e.time) < CUE_FRESH_MS)
      .slice(-CUE_MAX)
      .forEach(cue);
    renderList();
    renderBadge();
  });
  // relative times
  setInterval(() => open && renderList(), 15_000);
  app.registerKey({ key: 'shift+l', label: 'Event log', run: toggle });
  setOpen(open);
  return { toggle, setOpen, panel };
}
