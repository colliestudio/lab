import type { CanvasEdge } from './doc';
import { canvasColor } from './colors';

// Edges (JSON Canvas): geometry and the SVG layer that draws them under the nodes.
// Two looks. A plain edge (no `x-edge`; what the board and prototype plugins make) is a straight
// line between the two box centers, clipped to the borders, with an SVG marker. A styled edge
// (`x-edge` present, i.e. made by `core.connect`) leaves from a side's midpoint, can be dashed or
// curved, has an HTML label and can be picked and edited.

const SVG = 'http://www.w3.org/2000/svg';

export type Pt = { x: number; y: number };
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Side = 'top' | 'right' | 'bottom' | 'left';
export const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];
export const isSide = (v: unknown): v is Side => SIDES.includes(v as Side);

/** Core-owned style of an edge, kept in `x-edge` (JSON Canvas has no dash or curve). */
export interface EdgeStyle {
  dashed?: boolean;
  curve?: boolean;
}
export const edgeStyle = (e: CanvasEdge): EdgeStyle => (e['x-edge'] as EdgeStyle | undefined) ?? {};

/** Styled edges are anchored to box sides; plain ones are center-to-center lines. */
export const isStyled = (e: CanvasEdge) => !!e['x-edge'];

export const NORMAL: Record<Side, Pt> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

export function anchor(b: Box, s: Side): Pt {
  switch (s) {
    case 'top':
      return { x: b.x + b.w / 2, y: b.y };
    case 'bottom':
      return { x: b.x + b.w / 2, y: b.y + b.h };
    case 'left':
      return { x: b.x, y: b.y + b.h / 2 };
    case 'right':
      return { x: b.x + b.w, y: b.y + b.h / 2 };
  }
}

/** The side of `b` that faces point `p`. */
export function sideToward(b: Box, p: Pt): Side {
  const dx = (p.x - (b.x + b.w / 2)) / (b.w / 2 || 1);
  const dy = (p.y - (b.y + b.h / 2)) / (b.h / 2 || 1);
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
}

/** Sides an edge uses: the ones it names, the missing ones facing the other end. */
export function edgeSides(a: Box, b: Box, fromSide?: Side, toSide?: Side): [Side, Side] {
  const center = (x: Box) => ({ x: x.x + x.w / 2, y: x.y + x.h / 2 });
  let f = fromSide;
  let t = toSide;
  if (!f && !t) {
    f = sideToward(a, center(b));
    t = sideToward(b, center(a));
  } else if (!f) f = sideToward(a, anchor(b, t!));
  else if (!t) t = sideToward(b, anchor(a, f));
  return [f!, t!];
}

export interface EdgeGeometry {
  d: string;
  from: Pt;
  to: Pt;
  mid: Pt;
  /** Direction of travel arriving at `to` (radians), and leaving `from` backwards (for an arrow at the start). */
  angleTo: number;
  angleFrom: number;
}

const bez = (p0: Pt, c0: Pt, c1: Pt, p1: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
  };
};

/** Path of a styled edge between two boxes. */
export function edgeGeometry(e: CanvasEdge, a: Box, b: Box): EdgeGeometry {
  const [fs, ts] = edgeSides(a, b, isSide(e.fromSide) ? e.fromSide : undefined, isSide(e.toSide) ? e.toSide : undefined);
  const p0 = anchor(a, fs);
  const p1 = anchor(b, ts);
  if (!edgeStyle(e).curve) {
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    return { d: `M${p0.x},${p0.y} L${p1.x},${p1.y}`, from: p0, to: p1, mid: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, angleTo: ang, angleFrom: ang + Math.PI };
  }
  const k = Math.max(40, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 3);
  const c0 = { x: p0.x + NORMAL[fs].x * k, y: p0.y + NORMAL[fs].y * k };
  const c1 = { x: p1.x + NORMAL[ts].x * k, y: p1.y + NORMAL[ts].y * k };
  return {
    d: `M${p0.x},${p0.y} C${c0.x},${c0.y} ${c1.x},${c1.y} ${p1.x},${p1.y}`,
    from: p0,
    to: p1,
    mid: bez(p0, c0, c1, p1, 0.5),
    angleTo: Math.atan2(p1.y - c1.y, p1.x - c1.x),
    angleFrom: Math.atan2(p0.y - c0.y, p0.x - c0.x),
  };
}

/** Where the segment from `from` toward the center `to` of `box` crosses the box's border. */
export function clipToBox(from: Pt, to: Pt, box: Box): Pt {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  if (!dx && !dy) return to;
  const sx = dx ? box.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? box.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(1, sx, sy);
  return { x: to.x + dx * s, y: to.y + dy * s };
}

const HEAD = 13;
/** Arrowhead with its tip at `p`, pointing along `angle`. */
export function arrowHead(p: Pt, angle: number): string {
  const l = { x: p.x - HEAD * Math.cos(angle - 0.42), y: p.y - HEAD * Math.sin(angle - 0.42) };
  const r = { x: p.x - HEAD * Math.cos(angle + 0.42), y: p.y - HEAD * Math.sin(angle + 0.42) };
  return `M${l.x},${l.y} L${p.x},${p.y} L${r.x},${r.y} Z`;
}

export const hasArrow = (end: string | undefined, dflt: boolean) => (end === undefined ? dflt : end === 'arrow');

export interface DrawnEdge {
  e: CanvasEdge;
  a: Box;
  b: Box;
}

/** The edge layer: an SVG under the nodes plus an HTML layer for the labels of styled edges. */
export class EdgeLayer {
  readonly svg: SVGSVGElement;
  readonly labels: HTMLElement;
  private g: SVGGElement;
  private key = '';
  private labelEls = new Map<string, HTMLElement>();
  /** The label being typed into: kept as is across redraws. */
  editing: string | undefined;

  constructor(world: HTMLElement) {
    this.svg = document.createElementNS(SVG, 'svg');
    this.svg.classList.add('cv-edges');
    this.svg.innerHTML = `<defs><marker id="cv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker></defs><g></g>`;
    this.g = this.svg.querySelector('g')!;
    this.labels = document.createElement('div');
    this.labels.className = 'cv-edge-labels';
    world.prepend(this.svg, this.labels);
  }

  labelEl(id: string) {
    return this.labelEls.get(id);
  }

  render(edges: DrawnEdge[], selected: ReadonlySet<string>) {
    const key = JSON.stringify([edges, [...selected], this.editing]);
    if (key === this.key) return;
    this.key = key;
    this.g.replaceChildren();
    const live = new Set<string>();
    for (const { e, a, b } of edges) {
      if (!isStyled(e)) this.drawPlain(e, a, b);
      else this.drawStyled(e, a, b, selected.has(e.id), live);
    }
    for (const [id, el] of this.labelEls) {
      if (live.has(id)) continue;
      el.remove();
      this.labelEls.delete(id);
    }
  }

  private drawPlain(e: CanvasEdge, a: Box, b: Box) {
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const p = clipToBox(cb, ca, a);
    const q = clipToBox(ca, cb, b);
    const line = document.createElementNS(SVG, 'line');
    line.setAttribute('x1', String(p.x));
    line.setAttribute('y1', String(p.y));
    line.setAttribute('x2', String(q.x));
    line.setAttribute('y2', String(q.y));
    const color = canvasColor(e.color);
    if (color) line.style.stroke = color;
    if (hasArrow(e.toEnd, true)) line.setAttribute('marker-end', 'url(#cv-arrow)');
    if (e.fromEnd === 'arrow') line.setAttribute('marker-start', 'url(#cv-arrow)');
    line.dataset.edgeId = e.id;
    this.g.append(line);
    if (e.label) {
      const t = document.createElementNS(SVG, 'text');
      t.setAttribute('x', String((p.x + q.x) / 2));
      t.setAttribute('y', String((p.y + q.y) / 2 - 6));
      t.textContent = e.label;
      this.g.append(t);
    }
  }

  private drawStyled(e: CanvasEdge, a: Box, b: Box, selected: boolean, live: Set<string>) {
    const geo = edgeGeometry(e, a, b);
    const color = canvasColor(e.color) ?? '#1e1e1e';
    const style = edgeStyle(e);
    const grp = document.createElementNS(SVG, 'g');
    grp.setAttribute('class', 'cv-edge' + (selected ? ' cv-edge-sel' : ''));
    grp.dataset.edgeId = e.id;
    const hit = document.createElementNS(SVG, 'path');
    hit.setAttribute('d', geo.d);
    hit.setAttribute('class', 'cv-edge-hit');
    const vis = document.createElementNS(SVG, 'path');
    vis.setAttribute('d', geo.d);
    vis.setAttribute('class', 'cv-edge-line');
    vis.style.stroke = color;
    if (style.dashed) vis.setAttribute('stroke-dasharray', '9 7');
    grp.append(hit, vis);
    // stop the line short of the tip so a wide stroke doesn't poke through the arrowhead
    for (const [on, pt, ang] of [
      [hasArrow(e.toEnd, true), geo.to, geo.angleTo],
      [hasArrow(e.fromEnd, false), geo.from, geo.angleFrom],
    ] as const) {
      if (!on) continue;
      const h = document.createElementNS(SVG, 'path');
      h.setAttribute('d', arrowHead(pt, ang));
      h.setAttribute('class', 'cv-edge-head');
      h.style.fill = color;
      h.style.stroke = color;
      grp.append(h);
    }
    this.g.append(grp);
    if (!e.label && this.editing !== e.id) return;
    live.add(e.id);
    let el = this.labelEls.get(e.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'cv-edge-label';
      el.dataset.edgeId = e.id;
      this.labels.append(el);
      this.labelEls.set(e.id, el);
    }
    if (this.editing !== e.id) el.textContent = e.label ?? '';
    el.style.transform = `translate(${geo.mid.x}px, ${geo.mid.y}px) translate(-50%, -50%)`;
    el.classList.toggle('cv-edge-label-sel', selected);
  }
}
