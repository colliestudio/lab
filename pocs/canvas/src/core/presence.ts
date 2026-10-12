import type { Awareness } from 'y-protocols/awareness';
import type { App } from './app';

// Presence: who is here, where their pointer is, what they selected and what they are holding.
// Built on a y-protocols Awareness, so it works with any Yjs provider (WebRTC now, a Durable
// Object WebSocket later). Ephemeral: never part of the document.

export interface PlayerInfo {
  /** Stable per-browser player id (also the future fog-of-war `owner`/`viewer` id). */
  id: string;
  name: string;
  color: string;
}

interface PeerState {
  user?: PlayerInfo;
  /** Pointer in world coordinates, or null when outside the table. */
  cursor?: { x: number; y: number } | null;
  sel?: string[];
  /** Nodes this player is dragging right now (others can't grab them). */
  held?: string[];
}

export interface Peer extends PlayerInfo {
  clientId: number;
  cursor: { x: number; y: number } | null;
  sel: string[];
  held: string[];
}

const CURSOR_MS = 50;

export class Presence {
  private lastCursor = 0;
  private pendingCursor: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  constructor(
    readonly awareness: Awareness,
    public me: PlayerInfo,
  ) {
    awareness.setLocalState({ user: me, cursor: null, sel: [], held: [] } satisfies PeerState);
    awareness.on('change', () => this.emit());
  }

  /** Change my name/color; goes out to everyone right away. */
  setMe(me: PlayerInfo) {
    this.me = me;
    this.awareness.setLocalStateField('user', me);
  }

  /** Everyone else currently in the room. */
  peers(): Peer[] {
    const out: Peer[] = [];
    for (const [clientId, s] of this.awareness.getStates() as Map<number, PeerState>) {
      if (clientId === this.awareness.clientID || !s.user) continue;
      out.push({ ...s.user, clientId, cursor: s.cursor ?? null, sel: s.sel ?? [], held: s.held ?? [] });
    }
    return out;
  }

  /** The other player holding node `id`, if any. */
  heldBy(id: string): Peer | undefined {
    return this.peers().find((p) => p.held.includes(id));
  }

  /** Throttled: at most one cursor update per 50 ms (the last position always goes out). */
  setCursor(p: { x: number; y: number } | null) {
    clearTimeout(this.pendingCursor);
    const now = performance.now();
    const send = () => {
      this.lastCursor = performance.now();
      this.awareness.setLocalStateField('cursor', p && { x: Math.round(p.x), y: Math.round(p.y) });
    };
    if (p === null || now - this.lastCursor >= CURSOR_MS) send();
    else this.pendingCursor = setTimeout(send, CURSOR_MS - (now - this.lastCursor));
  }

  setSelection(ids: Iterable<string>) {
    this.awareness.setLocalStateField('sel', [...ids]);
  }

  setHeld(ids: Iterable<string>) {
    this.awareness.setLocalStateField('held', [...ids]);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

/** Remote cursors with name labels and remote selection outlines, drawn over the table. */
export function mountPresenceView(app: App, presence: Presence) {
  const root = app.view.root;
  const layer = document.createElement('div');
  layer.className = 'cv-cursors';
  root.append(layer);
  const cursors = new Map<number, HTMLElement>();
  let decorated = new Set<string>();

  const draw = () => {
    const vp = app.viewport;
    const peers = presence.peers();
    const alive = new Set<number>();
    for (const p of peers) {
      if (!p.cursor) continue;
      alive.add(p.clientId);
      let el = cursors.get(p.clientId);
      if (!el) {
        el = document.createElement('div');
        el.className = 'cv-cursor';
        el.dataset.client = String(p.clientId);
        el.innerHTML =
          `<svg width="18" height="20" viewBox="0 0 18 20"><path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" stroke="#fff" stroke-width="1.5"/></svg>` +
          `<span></span>`;
        layer.append(el);
        cursors.set(p.clientId, el);
      }
      el.style.transform = `translate(${p.cursor.x * vp.zoom + vp.x}px, ${p.cursor.y * vp.zoom + vp.y}px)`;
      (el.querySelector('path') as SVGPathElement).setAttribute('fill', p.color);
      const label = el.querySelector('span')!;
      label.textContent = p.held.length ? `${p.name} ✋` : p.name;
      label.style.background = p.color;
    }
    for (const [id, el] of cursors) {
      if (!alive.has(id)) {
        el.remove();
        cursors.delete(id);
      }
    }
    // remote selection / held outlines on node boxes
    const next = new Set<string>();
    for (const p of peers) {
      for (const id of [...p.sel, ...p.held]) {
        const box = app.view.boxOf(id);
        const node = app.node(id);
        // never mark what's hidden from me (which of their private cards they touch is information)
        if (!box || next.has(id) || (node && app.hiddenFrom(node))) continue;
        next.add(id);
        box.classList.add('cv-remote-sel');
        box.style.setProperty('--cv-remote', p.color);
        box.dataset.remoteName = p.name;
      }
    }
    for (const id of decorated) {
      if (next.has(id)) continue;
      const box = app.view.boxOf(id);
      if (!box) continue;
      box.classList.remove('cv-remote-sel');
      box.style.removeProperty('--cv-remote');
      delete box.dataset.remoteName;
    }
    decorated = next;
  };

  presence.onChange(draw);
  app.viewport.onChange(draw);
  app.store.subscribe(draw); // node boxes may have been (re)created
  app.store.subscribe(() => presence.setSelection(app.publicIds(app.store.selection)));
  draw();
}
