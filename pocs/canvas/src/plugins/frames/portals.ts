import { IndexeddbPersistence } from 'y-indexeddb';
import { WebrtcProvider } from 'y-webrtc';
import { Store, roomDbName, signalingUrl, type App, type CanvasNode, type DocView, type RenderCtx } from '../../core';
import { visibleWorld } from './camera';
import { isFrame, isPortal, portalRoom, portalTitle } from './model';

// Portals: a node that shows another room live. Each room a portal shows gets one Y.Doc here
// (shared by every portal into it), loaded from this device's copy of the room (IndexedDB) and kept
// live by its own provider: a second y-webrtc room next to the app's own (same signaling; tabs in
// one browser reach each other over BroadcastChannel with no server at all). The doc is read with
// a Store that borrows the app's view rules (adoptViewRules), and drawn with the app's own
// renderers, read-only: nothing here ever dispatches into the other room.
//
// Budget: a portal smaller than LIVE_MIN_PX on screen, or beyond the first MAX_LIVE (largest on
// screen first), shows a cheap snapshot (one SVG rect per object); off-screen portals draw nothing.
// The docs stay synced either way (that's cheap); only DOM work is skipped.

export const LIVE_MIN_PX = 220;
export const MAX_LIVE = 3;
/** A room that shows nothing after this long reads as "empty or not yours". */
const EMPTY_AFTER_MS = 4000;

export type Connect = (room: string, doc: import('yjs').Doc) => { destroy(): void } | undefined;

/** Default transport: a y-webrtc room, invisible (no awareness state: we're not a player there). */
export const webrtcConnect: Connect = (room, ydoc) => {
  const base = signalingUrl().replace(/\/+$/, '');
  const provider = new WebrtcProvider(`canvas-poc:${room}`, ydoc, {
    signaling: [`${base}/r/${encodeURIComponent(room)}`],
    peerOpts: { config: { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] } },
  });
  provider.awareness.setLocalState(null);
  return provider;
};

export interface PortalDoc {
  room: string;
  store: Store;
  /** Stored state loaded (or no storage): an empty doc after this is really empty. */
  loaded: boolean;
  /** Bumps on every change (snapshot cache key). */
  version: number;
  since: number;
}

interface Entry extends PortalDoc {
  refs: number;
  stop: () => void;
  listeners: Set<() => void>;
}

/** One live read-only doc per room, refcounted across portals. */
export class PortalRooms {
  private rooms = new Map<string, Entry>();
  constructor(
    private rules: Store,
    private opts: { connect?: Connect | null; persist?: boolean } = {},
  ) {}

  open(room: string, onChange: () => void): { doc: PortalDoc; close: () => void } {
    let e = this.rooms.get(room);
    if (!e) {
      const store = new Store();
      store.adoptViewRules(this.rules);
      const entry: Entry = { room, store, loaded: false, version: 0, since: Date.now(), refs: 0, stop: () => {}, listeners: new Set() };
      const persist = this.opts.persist !== false && typeof indexedDB !== 'undefined' ? new IndexeddbPersistence(roomDbName(room), store.ydoc) : null;
      const conn = this.opts.connect === null ? undefined : (this.opts.connect ?? webrtcConnect)(room, store.ydoc);
      if (persist)
        persist.whenSynced.then(() => {
          entry.loaded = true;
          entry.version++;
          for (const fn of entry.listeners) fn();
        });
      else entry.loaded = true;
      store.subscribe(() => {
        entry.version++;
        for (const fn of entry.listeners) fn();
      });
      entry.stop = () => {
        conn?.destroy();
        void persist?.destroy();
        store.ydoc.destroy();
      };
      this.rooms.set(room, (e = entry));
    }
    const entry = e;
    entry.refs++;
    entry.listeners.add(onChange);
    let closed = false;
    return {
      doc: entry,
      close: () => {
        if (closed) return;
        closed = true;
        entry.listeners.delete(onChange);
        if (--entry.refs > 0) return;
        // keep it a moment: a re-render closes and reopens the same room right away
        setTimeout(() => {
          if (entry.refs > 0 || this.rooms.get(room) !== entry) return;
          this.rooms.delete(room);
          entry.stop();
        }, 2000);
      },
    };
  }

  /** Rooms open right now (for tests and the outline). */
  openRooms(): string[] {
    return [...this.rooms.keys()];
  }
}

/** Bounds of what a room shows (its visible nodes), or undefined if nothing. */
export function contentBounds(doc: DocView, hidden: (n: CanvasNode) => boolean = () => false) {
  const ns = doc.visible.filter((n) => !hidden(n));
  if (!ns.length) return undefined;
  const x = Math.min(...ns.map((n) => n.x));
  const y = Math.min(...ns.map((n) => n.y));
  return { x, y, width: Math.max(...ns.map((n) => n.x + n.width)) - x, height: Math.max(...ns.map((n) => n.y + n.height)) - y };
}

/** Scale + offset that fits `b` into a w x h box with `pad`. */
export function fitInto(b: { x: number; y: number; width: number; height: number }, w: number, h: number, pad = 16) {
  const s = Math.min((w - 2 * pad) / b.width, (h - 2 * pad) / b.height, 1.5);
  return { s, tx: (w - b.width * s) / 2 - b.x * s, ty: (h - b.height * s) / 2 - b.y * s };
}

type Mode = 'off' | 'snap' | 'live' | 'self' | 'bad';

interface Mounted {
  id: string;
  room: string | undefined;
  body: HTMLElement;
  status: HTMLElement;
  handle?: { doc: PortalDoc; close: () => void };
  mode?: Mode;
  drawn?: string;
  /** Live render cache: node id → its box and content key. */
  boxes: Map<string, { el: HTMLElement; key: string; geo: string }>;
  world?: HTMLElement;
}

/**
 * Draws every portal box the main view has rendered: decides live / snapshot / nothing per portal
 * on each camera move or change in either doc (batched to one animation frame).
 */
export class PortalViews {
  readonly rooms: PortalRooms;
  private mounted = new Map<string, Mounted>();
  private queued = false;

  constructor(
    private app: App,
    private opts: { currentRoom: string | null; connect?: Connect | null; persist?: boolean },
  ) {
    this.rooms = new PortalRooms(app.store, { connect: opts.connect, persist: opts.persist });
    app.viewport.onChange(() => this.schedule());
    app.store.subscribe(() => this.schedule());
  }

  /** Called by the portal type's render: (re)attach the box for node `n`. */
  mount(n: CanvasNode, body: HTMLElement, status: HTMLElement) {
    const old = this.mounted.get(n.id);
    old?.handle?.close();
    const room = portalRoom(n);
    const m: Mounted = { id: n.id, room, body, status, boxes: new Map() };
    if (room && room !== this.opts.currentRoom) m.handle = this.rooms.open(room, () => this.schedule());
    this.mounted.set(n.id, m);
    this.schedule();
  }

  schedule() {
    if (this.queued) return;
    this.queued = true;
    const run = () => {
      this.queued = false;
      this.draw();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else queueMicrotask(run);
  }

  /** The decision for each portal (exported for tests via `modes`). */
  modes(): Map<string, Mode> {
    const out = new Map<string, Mode>();
    const vp = this.app.viewport;
    const root = this.app.view.root;
    const seen = visibleWorld(vp, root.clientWidth || 1, root.clientHeight || 1);
    const live: { id: string; px: number }[] = [];
    for (const m of this.mounted.values()) {
      const n = this.app.node(m.id);
      if (!n) continue;
      if (!m.room) {
        out.set(m.id, 'bad');
        continue;
      }
      if (m.room === this.opts.currentRoom) {
        out.set(m.id, 'self');
        continue;
      }
      const onScreen = n.x < seen.x + seen.width && n.x + n.width > seen.x && n.y < seen.y + seen.height && n.y + n.height > seen.y;
      if (!onScreen) {
        out.set(m.id, 'off');
        continue;
      }
      const px = n.width * vp.zoom;
      if (px < LIVE_MIN_PX) out.set(m.id, 'snap');
      else live.push({ id: m.id, px });
    }
    live.sort((a, b) => b.px - a.px);
    live.forEach((l, i) => out.set(l.id, i < MAX_LIVE ? 'live' : 'snap'));
    return out;
  }

  draw() {
    // forget boxes the main view dropped (node deleted, or re-rendered into a new box)
    for (const [id, m] of this.mounted) {
      if (!m.body.isConnected || !this.app.node(id)) {
        m.handle?.close();
        this.mounted.delete(id);
      }
    }
    const modes = this.modes();
    for (const m of this.mounted.values()) {
      const mode = modes.get(m.id) ?? 'off';
      const n = this.app.node(m.id)!;
      const doc = m.handle?.doc;
      const key = `${mode}:${doc?.version ?? 0}:${n.width}x${n.height}:${doc?.loaded}`;
      if (m.drawn === key) continue;
      m.drawn = key;
      if (mode !== m.mode) {
        m.body.replaceChildren();
        m.boxes.clear();
        m.world = undefined;
        m.mode = mode;
        m.body.dataset.mode = mode;
      }
      this.drawOne(m, mode, n);
    }
  }

  private drawOne(m: Mounted, mode: Mode, n: CanvasNode) {
    const say = (t: string) => (m.status.textContent = t);
    if (mode === 'bad') return say('no room: set one in the menu');
    if (mode === 'self') return say('this room (a portal can’t show the room it’s in)');
    if (mode === 'off') return;
    const doc = m.handle!.doc;
    const view = doc.store.doc;
    const ctx: RenderCtx = { doc: view, viewer: this.app.viewer };
    const hidden = (x: CanvasNode) => !!this.app.typeOf(x)?.concealed?.(x, ctx);
    const b = contentBounds(view, hidden);
    if (!b) {
      const waited = Date.now() - doc.since > EMPTY_AFTER_MS;
      say(!doc.loaded ? 'loading…' : waited ? 'nothing here, or not a room you can see' : 'waiting for the room…');
      if (doc.loaded && !waited) setTimeout(() => this.schedule(), EMPTY_AFTER_MS);
      m.body.replaceChildren();
      m.boxes.clear();
      m.world = undefined;
      return;
    }
    say(`${view.visible.filter((x) => !hidden(x)).length} objects · live`);
    const w = n.width;
    const h = m.body.clientHeight || n.height - 30;
    const fit = fitInto(b, w, h);
    if (mode === 'snap') return this.drawSnapshot(m, view, hidden, fit, w, h);
    this.drawLive(m, view, ctx, hidden, fit);
  }

  /** Cheap: one rect per object, frames as outlines. */
  private drawSnapshot(m: Mounted, view: DocView, hidden: (n: CanvasNode) => boolean, fit: ReturnType<typeof fitInto>, w: number, h: number) {
    const ns = view.visible.filter((x) => !hidden(x));
    const rects = ns
      .map((x) => {
        const rx = x.x * fit.s + fit.tx;
        const ry = x.y * fit.s + fit.ty;
        const cls = isFrame(x) ? 'fr-snap-frame' : isPortal(x) ? 'fr-snap-portal' : 'fr-snap-node';
        return `<rect class="${cls}" x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${Math.max(1, x.width * fit.s).toFixed(1)}" height="${Math.max(1, x.height * fit.s).toFixed(1)}" rx="2"/>`;
      })
      .join('');
    m.body.innerHTML = `<svg class="fr-snap" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${rects}</svg>`;
  }

  /** The other room drawn with this app's renderers, scaled to fit. Only changed boxes are touched. */
  private drawLive(m: Mounted, view: DocView, ctx: RenderCtx, hidden: (n: CanvasNode) => boolean, fit: ReturnType<typeof fitInto>) {
    if (!m.world) {
      m.world = document.createElement('div');
      m.world.className = 'fr-portal-world';
      m.body.replaceChildren(m.world);
    }
    m.world.style.transform = `translate(${fit.tx}px, ${fit.ty}px) scale(${fit.s})`;
    const alive = new Set<string>();
    let z = 0;
    for (const n of view.visible) {
      if (hidden(n)) continue;
      z++;
      alive.add(n.id);
      let rec = m.boxes.get(n.id);
      if (!rec) {
        const el = document.createElement('div');
        el.className = 'cv-node';
        el.dataset.portalNode = n.id;
        m.world.append(el);
        m.boxes.set(n.id, (rec = { el, key: '', geo: '' }));
      }
      const angle = view.styleOf(n.id)?.angle;
      const geo = `${n.x},${n.y},${n.width},${n.height},${angle ?? 0},${z}`;
      if (rec.geo !== geo) {
        rec.geo = geo;
        rec.el.style.transform = `translate(${n.x}px, ${n.y}px)` + (angle ? ` rotate(${angle}deg)` : '');
        rec.el.style.width = `${n.width}px`;
        rec.el.style.height = `${n.height}px`;
        rec.el.style.zIndex = String(z);
      }
      const type = this.app.typeOf(n);
      // a portal inside a portal: a label only (one level deep; no rooms opening rooms)
      const nested: boolean = isPortal(n as CanvasNode | undefined);
      const key = nested ? `portal:${portalTitle(n)}` : (type?.id ?? '') + '\n' + (type?.renderKey?.(n, ctx) ?? contentKeyOf(n));
      if (rec.key === key) continue;
      rec.key = key;
      rec.el.dataset.kind = nested ? 'portal-nested' : (type?.id ?? n.type);
      rec.el.replaceChildren();
      if (nested) {
        const d = document.createElement('div');
        d.className = 'fr-portal-nested';
        d.textContent = `⧉ ${portalTitle(n)}`;
        rec.el.append(d);
      } else if (type) type.render(n, rec.el, ctx);
      else {
        const d = document.createElement('div');
        d.className = 'cv-text';
        d.textContent = n.text ?? n.file ?? n.url ?? n.label ?? n.type;
        rec.el.append(d);
      }
    }
    for (const [id, rec] of m.boxes) {
      if (alive.has(id)) continue;
      rec.el.remove();
      m.boxes.delete(id);
    }
  }
}

function contentKeyOf(n: CanvasNode) {
  const { x: _x, y: _y, z: _z, ...rest } = n;
  return JSON.stringify(rest);
}
