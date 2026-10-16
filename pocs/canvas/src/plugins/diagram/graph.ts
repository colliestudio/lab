import type { CanvasNode, DocView } from '../../core/doc';
import { edgeStyle, hasArrow } from '../../core/edges';
import { titleOf } from '../../core/query';
import { DEFAULT_TEXT_SIZE, fillOf, isShape, shapeOf, DEFAULT_FILL, INK } from './model';

// The diagram as data and as text for agents: shapes with ids and boxes, arrows with labels, what
// overlaps. Node-safe (no DOM).

export interface GraphShape {
  id: string;
  kind: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Non-default look only. */
  style: { stroke?: string; fill?: string; dashed?: boolean; size?: number };
  /** Title of what carries it (a frame, usually). */
  in?: string;
}
export interface GraphEnd {
  id: string;
  title: string;
}
export interface GraphArrow {
  id: string;
  from: GraphEnd;
  to: GraphEnd;
  label?: string;
  ends: '→' | '←' | '↔' | '—';
  dashed?: boolean;
  curve?: boolean;
  color?: string;
}
export interface Graph {
  shapes: GraphShape[];
  arrows: GraphArrow[];
  overlaps: [string, string][];
  /** Set when filtered: what the filter named. */
  filter?: { title: string; isGroup: boolean };
}

const MAX_OVERLAPS = 10;

/** Whether `id` has `ancestor` among the nodes that carry it. */
function carriedBy(doc: DocView, id: string, ancestor: string): boolean {
  for (let cur = doc.carrierOf(id), i = 0; cur && i < 20; cur = doc.carrierOf(cur), i++) if (cur === ancestor) return true;
  return false;
}

export function graphOf(doc: DocView, inId?: string): Graph {
  const listed = doc.nodes.filter((n) => isShape(n) && (!inId || carriedBy(doc, n.id, inId)));
  const ids = new Set(listed.map((n) => n.id));
  const shapes = listed.map((n): GraphShape => {
    const s = shapeOf(n)!;
    const carrier = doc.carrierOf(n.id);
    const style: GraphShape['style'] = {};
    if (s.stroke && s.stroke !== INK) style.stroke = s.stroke;
    if (s.fill !== undefined && fillOf(s) !== DEFAULT_FILL[s.kind]) style.fill = s.fill;
    if (s.dashed) style.dashed = true;
    if (s.size && s.size !== DEFAULT_TEXT_SIZE) style.size = s.size;
    return { id: n.id, kind: s.kind, text: n.text ?? '', x: n.x, y: n.y, width: n.width, height: n.height, style, ...(carrier && doc.get(carrier) ? { in: titleOf(doc.get(carrier)!) } : {}) };
  });
  const end = (id: string): GraphEnd => ({ id, title: titleOf(doc.get(id) ?? ({ id } as CanvasNode)) || id });
  const arrows = doc.edges
    .filter((e) => ids.has(e.fromNode) || ids.has(e.toNode))
    .map((e): GraphArrow => {
      const st = edgeStyle(e);
      const start = hasArrow(e.fromEnd, false);
      const stop = hasArrow(e.toEnd, true);
      return {
        id: e.id,
        from: end(e.fromNode),
        to: end(e.toNode),
        ...(e.label ? { label: e.label } : {}),
        ends: start && stop ? '↔' : stop ? '→' : start ? '←' : '—',
        ...(st.dashed ? { dashed: true } : {}),
        ...(st.curve ? { curve: true } : {}),
        ...(e.color ? { color: e.color } : {}),
      };
    });
  const overlaps: [string, string][] = [];
  for (let i = 0; i < listed.length && overlaps.length < MAX_OVERLAPS; i++)
    for (let j = i + 1; j < listed.length && overlaps.length < MAX_OVERLAPS; j++) {
      const a = listed[i];
      const b = listed[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) overlaps.push([a.id, b.id]);
    }
  const target = inId ? doc.get(inId) : undefined;
  return { shapes, arrows, overlaps, ...(inId ? { filter: { title: target ? titleOf(target) || inId : inId, isGroup: target?.type === 'group' } } : {}) };
}

const quote = (t: string) => {
  const lines = t.trim().split('\n');
  return `“${lines[0]}${lines.length > 1 ? '…' : ''}”`;
};
const ref = (title: string, id: string) => `${quote(title)} (${id})`;

export function graphText(g: Graph): string {
  if (!g.shapes.length && g.filter) return g.filter.isGroup ? `No diagram shapes in “${g.filter.title}”.` : `No diagram shapes in “${g.filter.title}”: it is not a frame.`;
  if (!g.shapes.length) return 'No diagram shapes yet. diagram.add {kind, text} adds one.';
  const out = [`Diagram: ${g.shapes.length} shape${g.shapes.length === 1 ? '' : 's'}, ${g.arrows.length} arrow${g.arrows.length === 1 ? '' : 's'}`, 'Shapes:'];
  const byId = new Map(g.shapes.map((s) => [s.id, s]));
  for (const s of g.shapes) {
    const look = [s.style.stroke && `stroke ${s.style.stroke}`, s.style.fill && `fill ${s.style.fill}`, s.style.dashed && 'dashed', s.style.size && `text ${s.style.size}px`].filter(Boolean);
    out.push(['  ' + `${s.kind} ${ref(s.text || '(no text)', s.id)}`, `${s.x},${s.y} ${s.width}x${s.height}`, s.in && `in ${s.in}`, ...look].filter(Boolean).join(' · '));
  }
  if (g.arrows.length) {
    out.push('Arrows:');
    for (const a of g.arrows) {
      const tail = [a.label ? `${quote(a.label)} (${a.id})` : `no label (${a.id})`, a.dashed && 'dashed', a.curve && 'curved', a.color && `color ${a.color}`].filter(Boolean).join(' · ');
      out.push(`  ${ref(a.from.title, a.from.id)} ${a.ends} ${ref(a.to.title, a.to.id)}: ${tail}`);
    }
  }
  if (g.overlaps.length) out.push('Overlapping: ' + g.overlaps.map(([a, b]) => `${ref(byId.get(a)!.text, a)} and ${ref(byId.get(b)!.text, b)}`).join('; '));
  return out.join('\n');
}
