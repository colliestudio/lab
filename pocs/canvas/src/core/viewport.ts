/** Screen = world * zoom + (x, y). Screen coords are relative to the table element. */
export class Viewport {
  x = 0;
  y = 0;
  zoom = 1;
  static MIN = 0.1;
  static MAX = 4;
  /** Zoom levels for buttons/keys. */
  static STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
  private listeners = new Set<() => void>();

  set(x: number, y: number, zoom: number) {
    this.x = x;
    this.y = y;
    this.zoom = Math.min(Viewport.MAX, Math.max(Viewport.MIN, zoom));
    for (const fn of this.listeners) fn();
  }

  panBy(dx: number, dy: number) {
    this.set(this.x + dx, this.y + dy, this.zoom);
  }

  /** Zoom by `factor`, keeping the screen point (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number) {
    const z = Math.min(Viewport.MAX, Math.max(Viewport.MIN, this.zoom * factor));
    const [wx, wy] = this.toWorld(sx, sy);
    this.set(sx - wx * z, sy - wy * z, z);
  }

  /** Set an absolute zoom, keeping the screen point (sx, sy) fixed. */
  zoomTo(sx: number, sy: number, zoom: number) {
    this.zoomAt(sx, sy, zoom / this.zoom);
  }

  /** Next fixed step in or out from the current zoom, around (sx, sy). */
  zoomStep(dir: 1 | -1, sx: number, sy: number) {
    this.zoomTo(sx, sy, nextStep(this.zoom, dir));
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.x) / this.zoom, (sy - this.y) / this.zoom];
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function nextStep(zoom: number, dir: 1 | -1): number {
  const eps = 0.001;
  const steps = Viewport.STEPS;
  if (dir > 0) return steps.find((z) => z > zoom + eps) ?? Viewport.MAX;
  return [...steps].reverse().find((z) => z < zoom - eps) ?? Viewport.MIN;
}

/**
 * Zoom factor for one wheel event (⌘/Ctrl+wheel, trackpad pinch). Line/page deltas are converted to
 * pixels; the factor is clamped per event so a notched wheel steps ~25% and smooth deltas glide.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY;
  return Math.min(1.25, Math.max(0.8, Math.exp(-px * 0.01)));
}
