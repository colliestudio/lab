/** Screen = world * zoom + (x, y). Screen coords are relative to the table element. */
export class Viewport {
  x = 0;
  y = 0;
  zoom = 1;
  static MIN = 0.1;
  static MAX = 4;
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

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.x) / this.zoom, (sy - this.y) / this.zoom];
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
