import type { App, Presence } from '../../core';
import { flyTo, stopFlight } from './camera';
import { frameTitle, slides } from './model';

// Present mode: the frames that are slides, in order, full screen, with a smooth camera move
// between them. While presenting, my awareness carries `present` (which frame), so peers can follow
// the presenter's camera. Ephemeral: nothing about a presentation is written to the doc.

export interface PresentState {
  frame: string;
  index: number;
  count: number;
  title: string;
}

const NEXT = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter']);
const PREV = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']);

export class Presenter {
  /** Frame shown now, or null when not presenting. */
  current: string | null = null;
  /** Slide index of `current` (where to fall back if its frame goes away). */
  private index = 0;
  private bar: HTMLElement | null = null;
  private listeners = new Set<() => void>();
  private offDoc: (() => void) | null = null;

  constructor(private app: App) {}

  get active() {
    return this.current !== null;
  }

  start(fromId?: string) {
    const list = slides(this.app.doc);
    if (!list.length) {
      this.app.notify('Nothing to present: add a frame first (⇧F), or put one back in the slides');
      return;
    }
    const i = Math.max(0, fromId ? list.findIndex((f) => f.id === fromId) : 0);
    if (typeof document !== 'undefined') {
      document.body.classList.add('fr-presenting');
      this.mountBar();
      window.addEventListener('keydown', this.onKey, true);
      window.addEventListener('resize', this.onResize);
      document.addEventListener('fullscreenchange', this.onFullscreen);
      // full screen needs a user gesture (key, click); without it we still present in the window
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
    this.app.store.select([]);
    // a deleted or skipped frame mid-talk: stay on the nearest slide
    this.offDoc = this.app.store.subscribe(() => {
      if (this.current && !slides(this.app.doc).some((f) => f.id === this.current)) this.go(this.index, false);
      else this.paint();
    });
    this.show(list[i].id);
  }

  stop() {
    if (!this.active) return;
    this.current = null;
    this.offDoc?.();
    this.offDoc = null;
    if (typeof document !== 'undefined') {
      document.body.classList.remove('fr-presenting');
      window.removeEventListener('keydown', this.onKey, true);
      window.removeEventListener('resize', this.onResize);
      document.removeEventListener('fullscreenchange', this.onFullscreen);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      this.bar?.remove();
      this.bar = null;
    }
    this.app.presence?.awareness.setLocalStateField('present', null);
    this.emit();
  }

  /** Step `d` slides (wraps at neither end). `relative: false` = go to index `d`. */
  go(d: number, relative = true) {
    const list = slides(this.app.doc);
    if (!list.length) return this.stop();
    const at = list.findIndex((f) => f.id === this.current);
    const i = Math.max(0, Math.min(list.length - 1, relative ? at + d : d));
    if (list[i].id !== this.current || !relative) this.show(list[i].id);
  }

  state(): PresentState | null {
    const list = slides(this.app.doc);
    const i = list.findIndex((f) => f.id === this.current);
    if (i < 0) return null;
    return { frame: list[i].id, index: i, count: list.length, title: frameTitle(list[i], i) };
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private show(id: string, ms = 650) {
    this.current = id;
    this.index = Math.max(0, slides(this.app.doc).findIndex((x) => x.id === id));
    const f = this.app.node(id);
    if (f) void flyTo(this.app, f, { pad: 24, maxZoom: 4, ms });
    this.app.presence?.awareness.setLocalStateField('present', this.state());
    this.paint();
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private onKey = (e: KeyboardEvent) => {
    const t = e.target;
    if (t instanceof Element && t.closest('input, textarea, select')) return;
    let handled = true;
    if (e.key === 'Escape') this.stop();
    else if (NEXT.has(e.key)) this.go(1);
    else if (PREV.has(e.key)) this.go(-1);
    else if (e.key === 'Home') this.go(0, false);
    else if (e.key === 'End') this.go(slides(this.app.doc).length - 1, false);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  private onResize = () => {
    const f = this.current && this.app.node(this.current);
    if (f) void flyTo(this.app, f, { pad: 24, maxZoom: 4, ms: 0 });
  };

  private onFullscreen = () => {
    // leaving full screen with the browser's own Esc ends the presentation too
    if (!document.fullscreenElement && this.active) this.stop();
  };

  private mountBar() {
    this.bar?.remove();
    const bar = document.createElement('div');
    bar.className = 'fr-present-bar';
    bar.innerHTML = `<button data-go="-1" title="Previous (←)">‹</button><span class="fr-present-where"></span><button data-go="1" title="Next (→, Space)">›</button><button data-stop title="End (Esc)">✕</button>`;
    bar.addEventListener('click', (e) => {
      const b = (e.target as Element).closest('button');
      if (!b) return;
      if (b.hasAttribute('data-stop')) this.stop();
      else this.go(Number(b.dataset.go));
    });
    document.body.append(bar);
    this.bar = bar;
  }

  private paint() {
    const s = this.state();
    const where = this.bar?.querySelector('.fr-present-where');
    if (where && s) where.textContent = `${s.index + 1} / ${s.count} · ${s.title}`;
  }
}

/** A peer who is presenting right now. */
export interface PresenterPeer {
  clientId: number;
  name: string;
  color: string;
  present: PresentState;
}

/** Peers presenting, from raw awareness states (validated: a peer's state is untrusted input). */
export function presentersIn(states: Map<number, Record<string, unknown>>, me: number): PresenterPeer[] {
  const out: PresenterPeer[] = [];
  for (const [clientId, s] of states) {
    if (clientId === me) continue;
    const p = s?.present as PresentState | null | undefined;
    const u = s?.user as { name?: unknown; color?: unknown } | undefined;
    if (!p || typeof p.frame !== 'string' || typeof u?.name !== 'string') continue;
    out.push({
      clientId,
      name: u.name.slice(0, 40),
      color: typeof u.color === 'string' && /^#[0-9a-f]{6}$/i.test(u.color) ? u.color : '#888',
      present: { frame: p.frame, index: Number(p.index) || 0, count: Number(p.count) || 0, title: String(p.title ?? '').slice(0, 80) },
    });
  }
  return out;
}

/**
 * Follow the presenter: a banner when someone presents ("Follow"); following flies my camera to
 * their frame on every change. Taking the camera (drag, wheel) stops following.
 */
export function attachFollow(app: App, presence: Presence, presenter: Presenter) {
  const banner = document.createElement('div');
  banner.className = 'fr-follow';
  banner.hidden = true;
  document.body.append(banner);
  let following: number | null = null;
  let lastFrame: string | null = null;
  let dismissed: number | null = null;

  const draw = () => {
    const list = presentersIn(presence.awareness.getStates() as Map<number, Record<string, unknown>>, presence.awareness.clientID);
    const p = list.find((x) => x.clientId === following) ?? list[0];
    if (following !== null && !list.some((x) => x.clientId === following)) {
      following = null;
      lastFrame = null;
    }
    if (!p || presenter.active || dismissed === p.clientId) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    const where = `${p.present.index + 1}/${p.present.count} · ${p.present.title}`;
    const isOn = following === p.clientId;
    const key = JSON.stringify([p.clientId, p.name, p.color, where, isOn]);
    if (banner.dataset.key !== key) {
      banner.dataset.key = key;
      paintBanner(p, where, isOn);
    }
    if (isOn && p.present.frame !== lastFrame) {
      lastFrame = p.present.frame;
      const f = app.node(p.present.frame);
      if (f) void flyTo(app, f, { pad: 24, maxZoom: 4 });
    }
  };
  const paintBanner = (p: PresenterPeer, where: string, isOn: boolean) => {
    banner.style.setProperty('--fr-peer', p.color);
    banner.innerHTML = `<i></i><span></span><button data-act="${isOn ? 'stop' : 'follow'}"></button>${isOn ? '' : '<button data-act="dismiss" title="Hide">✕</button>'}`;
    banner.querySelector('span')!.textContent = isOn ? `Following ${p.name} · ${where}` : `${p.name} is presenting · ${where}`;
    banner.querySelector('button')!.textContent = isOn ? 'Stop following' : 'Follow';
    banner.dataset.client = String(p.clientId);
  };
  banner.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    const id = Number(banner.dataset.client);
    if (!b) return;
    if (b.dataset.act === 'follow') {
      following = id;
      lastFrame = null;
    } else if (b.dataset.act === 'stop') following = null;
    else if (b.dataset.act === 'dismiss') dismissed = id;
    draw();
  });
  // taking the camera stops following
  const takeOver = () => {
    if (following === null) return;
    following = null;
    stopFlight(app);
    draw();
  };
  app.view.root.addEventListener('pointerdown', takeOver, true);
  app.view.root.addEventListener('wheel', takeOver, { capture: true, passive: true });
  presence.onChange(draw);
  presenter.onChange(() => {
    // a presentation I start goes out with my state (Presenter sets it), the banner hides
    draw();
  });
  app.store.subscribe(draw);
  draw();
  return {
    follow: (clientId: number) => {
      following = clientId;
      lastFrame = null;
      draw();
    },
    following: () => following,
  };
}
