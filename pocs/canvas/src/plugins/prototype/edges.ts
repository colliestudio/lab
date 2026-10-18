import type { App, CanvasEdge, CanvasNode, DocView } from '../../core';
import { isPage } from './model';

// Draws the links between pages (core skips them, see ownsEdge) under the nodes: an arrow from page
// to page with its action label. Forward links run right → left side; links back to an earlier column loop under
// the pages; stacked pages connect bottom → top.

const NS = 'http://www.w3.org/2000/svg';

type Pt = { x: number; y: number };

export function edgeGeometry(a: CanvasNode, b: CanvasNode): { d: string; mid: Pt; end: Pt; angle: number } {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  let p0: Pt, p1: Pt, c0: Pt, c1: Pt;
  if (b.x >= a.x + a.width + 20) {
    p0 = { x: a.x + a.width, y: ac.y };
    p1 = { x: b.x, y: bc.y };
    const k = Math.max(40, (p1.x - p0.x) / 2);
    c0 = { x: p0.x + k, y: p0.y };
    c1 = { x: p1.x - k, y: p1.y };
  } else if (Math.abs(bc.x - ac.x) < Math.max(a.width, b.width) / 2) {
    const down = bc.y > ac.y;
    p0 = { x: ac.x, y: down ? a.y + a.height : a.y };
    p1 = { x: bc.x, y: down ? b.y : b.y + b.height };
    const k = Math.max(40, Math.abs(p1.y - p0.y) / 2) * (down ? 1 : -1);
    c0 = { x: p0.x, y: p0.y + k };
    c1 = { x: p1.x, y: p1.y - k };
  } else {
    // backwards (or overlapping columns): loop under both pages, bottom to bottom
    p0 = { x: ac.x, y: a.y + a.height };
    p1 = { x: bc.x, y: b.y + b.height };
    const low = Math.max(p0.y, p1.y) + 90 + Math.abs(p1.x - p0.x) * 0.08;
    c0 = { x: p0.x, y: low };
    c1 = { x: p1.x, y: low };
  }
  const mid = bez(p0, c0, c1, p1, 0.5);
  const near = bez(p0, c0, c1, p1, 0.96);
  return { d: `M${p0.x},${p0.y} C${c0.x},${c0.y} ${c1.x},${c1.y} ${p1.x},${p1.y}`, mid, end: p1, angle: Math.atan2(p1.y - near.y, p1.x - near.x) };
}

function bez(p0: Pt, c0: Pt, c1: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
  };
}

/** A plain edge from one page to another is a link: drawn here, followed by Play. Core draws the rest. */
export const ownsEdge = (e: CanvasEdge, doc: DocView) => !e['x-edge'] && isPage(doc.get(e.fromNode)) && isPage(doc.get(e.toNode));

export interface EdgeLayer {
  /** Highlight an edge for a moment (a link was followed). */
  flash(id: string): void;
}

export function mountEdges(app: App): EdgeLayer {
  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('pg-edges');
  const labels = document.createElement('div');
  labels.className = 'pg-edge-labels';
  app.view.world.prepend(svg, labels);
  const flashing = new Map<string, ReturnType<typeof setTimeout>>();
  let lastKey = '';

  const draw = () => {
    const doc = app.store.doc;
    const shown = (n: CanvasNode | undefined) => !!n && doc.isVisible(n.id) && !app.isConcealed(n);
    const edges = doc.edges.filter((e) => ownsEdge(e, doc) && shown(doc.get(e.fromNode)) && shown(doc.get(e.toNode)));
    const key = JSON.stringify(edges.map((e) => [e.id, e.label, e.color, box(doc.get(e.fromNode)!), box(doc.get(e.toNode)!), flashing.has(e.id)]));
    if (key === lastKey) return;
    lastKey = key;
    svg.replaceChildren();
    labels.replaceChildren();
    for (const e of edges) drawEdge(e, doc.get(e.fromNode)!, doc.get(e.toNode)!);
  };
  const box = (n: CanvasNode) => [n.x, n.y, n.width, n.height];
  const drawEdge = (e: CanvasEdge, a: CanvasNode, b: CanvasNode) => {
    const g = edgeGeometry(a, b);
    const cls = 'pg-edge' + (isPage(a) && isPage(b) ? ' pg-nav' : '') + (flashing.has(e.id) ? ' pg-flash' : '');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', g.d);
    path.setAttribute('class', cls);
    const head = document.createElementNS(NS, 'path');
    const s = 12;
    const l = { x: g.end.x - s * Math.cos(g.angle - 0.45), y: g.end.y - s * Math.sin(g.angle - 0.45) };
    const r = { x: g.end.x - s * Math.cos(g.angle + 0.45), y: g.end.y - s * Math.sin(g.angle + 0.45) };
    head.setAttribute('d', `M${l.x},${l.y} L${g.end.x},${g.end.y} L${r.x},${r.y} Z`);
    head.setAttribute('class', cls + ' pg-head');
    svg.append(path, head);
    if (e.label) {
      const t = document.createElement('div');
      t.className = 'pg-edge-label' + (flashing.has(e.id) ? ' pg-flash' : '');
      t.textContent = e.label;
      t.style.transform = `translate(${g.mid.x}px, ${g.mid.y}px) translate(-50%, -50%)`;
      labels.append(t);
    }
  };

  app.store.subscribe(draw);
  draw();
  return {
    flash(id) {
      clearTimeout(flashing.get(id));
      flashing.set(
        id,
        setTimeout(() => {
          flashing.delete(id);
          draw();
        }, 1400),
      );
      draw();
    },
  };
}
