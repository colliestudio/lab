import { Viewport, type App } from '../../core';

export type Rect = { x: number; y: number; width: number; height: number };
export type Cam = { x: number; y: number; zoom: number };

export type Insets = { top: number; right: number; bottom: number; left: number };
const NONE: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Viewport that fits `r` into a `vw` x `vh` screen with `pad` px around it (zoom clamped), inside
 * `insets` (screen edges covered by panels: toolbar, outline).
 */
export function cameraFor(r: Rect, vw: number, vh: number, pad = 40, maxZoom = Viewport.MAX, insets: Insets = NONE): Cam {
  const w = Math.max(1, vw - insets.left - insets.right - 2 * pad);
  const h = Math.max(1, vh - insets.top - insets.bottom - 2 * pad);
  const zoom = Math.min(maxZoom, Math.max(Viewport.MIN, Math.min(w / r.width, h / r.height)));
  const cx = insets.left + (vw - insets.left - insets.right) / 2;
  const cy = insets.top + (vh - insets.top - insets.bottom) / 2;
  return { x: cx - (r.x + r.width / 2) * zoom, y: cy - (r.y + r.height / 2) * zoom, zoom };
}

const insetsOf = new WeakMap<App, () => Insets>();
/** Tell camera moves which screen edges are covered (by panels that may come and go). */
export function setInsets(app: App, fn: () => Insets) {
  insetsOf.set(app, fn);
}

/** Rect of the world currently on screen. */
export function visibleWorld(cam: Cam, vw: number, vh: number): Rect {
  return { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, width: vw / cam.zoom, height: vh / cam.zoom };
}

/**
 * Camera between `a` (t=0) and `b` (t=1). Zoom moves geometrically and the world point at the
 * screen center moves so that the motion looks even at every zoom (no lurch when zooming far).
 */
export function lerpCam(a: Cam, b: Cam, t: number, vw: number, vh: number): Cam {
  const ca = { x: (vw / 2 - a.x) / a.zoom, y: (vh / 2 - a.y) / a.zoom };
  const cb = { x: (vw / 2 - b.x) / b.zoom, y: (vh / 2 - b.y) / b.zoom };
  const zoom = a.zoom * Math.pow(b.zoom / a.zoom, t);
  // weight the center by how far zoom has gone (pan happens "at" the zoom level we're passing)
  const za = 1 / a.zoom;
  const zb = 1 / b.zoom;
  const s = Math.abs(zb - za) < 1e-9 ? t : (1 / zoom - za) / (zb - za);
  const cx = ca.x + (cb.x - ca.x) * s;
  const cy = ca.y + (cb.y - ca.y) * s;
  return { x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom, zoom };
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const flights = new WeakMap<App, number>();

/** Fly the camera to show `r` (smooth; `ms` 0 = jump). A new flight cancels the one under way. */
export function flyTo(app: App, r: Rect, opts: { ms?: number; pad?: number; maxZoom?: number } = {}): Promise<void> {
  const root = app.view.root;
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const to = cameraFor(r, vw, vh, opts.pad ?? 40, opts.maxZoom ?? 2, insetsOf.get(app)?.() ?? NONE);
  const vp = app.viewport;
  const from = { x: vp.x, y: vp.y, zoom: vp.zoom };
  const ms = opts.ms ?? 550;
  const token = (flights.get(app) ?? 0) + 1;
  flights.set(app, token);
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!ms || reduce || typeof requestAnimationFrame !== 'function') {
    vp.set(to.x, to.y, to.zoom);
    return Promise.resolve();
  }
  const start = performance.now();
  return new Promise((done) => {
    const step = (now: number) => {
      if (flights.get(app) !== token) return done();
      const t = Math.min(1, (now - start) / ms);
      const c = t >= 1 ? to : lerpCam(from, to, ease(t), vw, vh);
      vp.set(c.x, c.y, c.zoom);
      if (t < 1) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });
}

/** Stop any flight under way (the user took the camera). */
export function stopFlight(app: App) {
  flights.set(app, (flights.get(app) ?? 0) + 1);
}
