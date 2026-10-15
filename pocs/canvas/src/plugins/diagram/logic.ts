import { anchor, sideToward, isSide, NORMAL, type CanvasNode, type Change, type Command, type DocView, type Side, type Store } from '../../core';
import { DEFAULT_SIZE, DEFAULT_TEXT_SIZE, MIN_SIZE, isKind, isShape, shapeOf, textBox, type ShapeKind, type ShapeStyle } from './model';

// Diagram commands. No DOM: the browser plugin and the Node bridge both register them, so an
// agent's "add a box" is what a person's toolbar does. Arrows are core commands (core.connect,
// core.edge, core.delete with an arrow id).

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface AddArgs extends Partial<Omit<ShapeStyle, 'kind'>> {
  id?: string;
  kind?: ShapeKind;
  text?: string;
  /** Top-left corner; else `cx`/`cy` (center) or next to everything. */
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
  width?: number;
  height?: number;
}

/** Space to the right of everything, top-aligned. */
function freeSpot(doc: DocView, w: number, h: number): { x: number; y: number } {
  const all = doc.visible;
  if (!all.length) return { x: Math.round(-w / 2), y: Math.round(-h / 2) };
  return { x: Math.round(Math.max(...all.map((n) => n.x + n.width)) + 60), y: Math.round(Math.min(...all.map((n) => n.y))) };
}

/** The node a new shape gets: `a` fills in the defaults of its kind. */
export function buildShape(doc: DocView, a: AddArgs, id: string): CanvasNode | undefined {
  const kind = a.kind ?? 'rect';
  if (!isKind(kind)) return undefined;
  const text = typeof a.text === 'string' ? a.text : '';
  const style: ShapeStyle = { kind };
  if (typeof a.stroke === 'string') style.stroke = a.stroke;
  if (typeof a.fill === 'string') style.fill = a.fill;
  if (a.dashed) style.dashed = true;
  if (num(a.size) && a.size > 0) style.size = a.size;
  let w = num(a.width) ? a.width : DEFAULT_SIZE[kind].w;
  let h = num(a.height) ? a.height : DEFAULT_SIZE[kind].h;
  if (kind === 'text' && !num(a.width) && !num(a.height)) ({ w, h } = textBox(text, style.size ?? DEFAULT_TEXT_SIZE));
  w = Math.max(MIN_SIZE, Math.round(w));
  h = Math.max(MIN_SIZE, Math.round(h));
  const spot = num(a.x) && num(a.y) ? { x: a.x, y: a.y } : num(a.cx) && num(a.cy) ? { x: a.cx - w / 2, y: a.cy - h / 2 } : freeSpot(doc, w, h);
  return { id, type: 'text', text, x: Math.round(spot.x), y: Math.round(spot.y), width: w, height: h, z: doc.topZ + 1, 'x-shape': style };
}

const add: Command<AddArgs> = (doc, a, ctx) => {
  const id = typeof a?.id === 'string' && a.id ? a.id : ctx.newId();
  if (doc.get(id)) return [];
  const node = buildShape(doc, a ?? {}, id);
  if (!node) return [];
  return { changes: [{ op: 'add', node }], select: [id] };
};

export interface UpdateArgs extends Partial<ShapeStyle> {
  id?: string;
  ids?: string[];
  text?: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  width?: number;
  height?: number;
}

/** Style fields: null clears (back to the kind's default). */
const STYLE_KEYS = ['stroke', 'fill', 'dashed', 'size'] as const;

const update: Command<UpdateArgs> = (doc, a) => {
  const ids = Array.isArray(a?.ids) ? a.ids : typeof a?.id === 'string' ? [a.id] : [];
  const changes: Change[] = [];
  for (const id of ids) {
    const n = doc.get(id);
    const cur = shapeOf(n);
    if (!n || !cur) continue;
    let kind = cur.kind;
    if (a.kind !== undefined && isKind(a.kind) && a.kind !== kind) {
      kind = a.kind;
      changes.push({ op: 'set', id, key: 'x-shape.kind', value: kind });
      // a sticky has its own color: switching to or from it drops a fill that belongs to the old kind
      if ((kind === 'sticky') !== (cur.kind === 'sticky') && a.fill === undefined) changes.push({ op: 'set', id, key: 'x-shape.fill', value: undefined });
    }
    for (const k of STYLE_KEYS) {
      const v = (a as Record<string, unknown>)[k];
      if (v === undefined) continue;
      const ok = v === null || (k === 'dashed' ? typeof v === 'boolean' : k === 'size' ? num(v) && v > 0 : typeof v === 'string');
      if (!ok) continue;
      changes.push({ op: 'set', id, key: `x-shape.${k}`, value: v === null || (k === 'dashed' && v === false) ? undefined : v });
    }
    let { x, y, width, height } = n;
    if (num(a.x)) x = a.x;
    if (num(a.y)) y = a.y;
    if (num(a.dx)) x += a.dx;
    if (num(a.dy)) y += a.dy;
    if (num(a.width)) width = Math.max(MIN_SIZE, a.width);
    if (num(a.height)) height = Math.max(MIN_SIZE, a.height);
    const text = typeof a.text === 'string' ? a.text : n.text;
    // a bare text shape wraps its words: its box follows them unless the caller sized it
    if (kind === 'text' && (a.text !== undefined || a.size !== undefined || a.kind === 'text') && !num(a.width) && !num(a.height)) {
      const size = a.size === null ? DEFAULT_TEXT_SIZE : (a.size ?? cur.size ?? DEFAULT_TEXT_SIZE);
      ({ w: width, h: height } = textBox(text ?? '', size));
    }
    const geo: Record<string, number> = { x, y, width, height };
    for (const [key, v] of Object.entries(geo)) if (Math.round(v) !== n[key as 'x']) changes.push({ op: 'set', id, key, value: Math.round(v) });
    if (typeof a.text === 'string' && a.text !== n.text) changes.push({ op: 'set', id, key: 'text', value: a.text });
  }
  return changes;
};

/** Place and size one shape (resize handles): position and size in one go. */
const resize: Command<{ id: string; x: number; y: number; width: number; height: number }> = (doc, a) => {
  const n = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!n || !isShape(n) || ![a.x, a.y, a.width, a.height].every(num)) return [];
  const w = Math.max(MIN_SIZE, Math.round(a.width));
  const h = Math.max(MIN_SIZE, Math.round(a.height));
  // when a size is clamped, the edge the user isn't dragging stays: keep the opposite corner put
  const x = Math.round(a.x + (a.width < MIN_SIZE && a.x !== n.x ? a.width - w : 0));
  const y = Math.round(a.y + (a.height < MIN_SIZE && a.y !== n.y ? a.height - h : 0));
  return (['x', 'y', 'width', 'height'] as const)
    .map((key, i) => ({ key, value: [x, y, w, h][i] }))
    .filter(({ key, value }) => n[key] !== value)
    .map(({ key, value }): Change => ({ op: 'set', id: n.id, key, value }));
};

export interface AddConnectedArgs extends Omit<AddArgs, 'x' | 'y'> {
  from: string;
  /** Which side of `from` the arrow leaves. Default: the side facing `at`, else right. */
  side?: string;
  /** Where the new shape's center goes. Default: beyond `side`. */
  at?: { x: number; y: number };
  label?: string;
}

const GAP = 90;

/** A new shape with an arrow to it from `from` (the flowchart move: drag an arrow out and let go on empty space). */
const addConnected: Command<AddConnectedArgs> = (doc, a, ctx) => {
  const from = typeof a?.from === 'string' ? doc.get(a.from) : undefined;
  if (!from || !doc.isVisible(from.id)) return [];
  const own = shapeOf(from);
  const kind = a.kind ?? (own && own.kind !== 'text' ? own.kind : 'rect');
  const box = { x: from.x, y: from.y, w: from.width, h: from.height };
  const side: Side = isSide(a.side) ? a.side : a.at ? sideToward(box, a.at) : 'right';
  const id = typeof a.id === 'string' && a.id ? a.id : ctx.newId();
  const edgeId = ctx.newId();
  if (doc.get(id)) return [];
  const w = num(a.width) ? a.width : DEFAULT_SIZE[kind as ShapeKind]?.w;
  const h = num(a.height) ? a.height : DEFAULT_SIZE[kind as ShapeKind]?.h;
  if (!w || !h) return [];
  let c = a.at;
  if (!c) {
    const p = anchor(box, side);
    const nrm = NORMAL[side];
    c = { x: p.x + nrm.x * (GAP + w / 2), y: p.y + nrm.y * (GAP + h / 2) };
  }
  // carry the look of a boxed source over (same color family), not its words
  const style: Partial<ShapeStyle> = own && own.kind !== 'text' ? { stroke: own.stroke, fill: own.fill, dashed: own.dashed, size: own.size } : {};
  const node = buildShape(doc, { ...style, ...a, kind, cx: c.x, cy: c.y, x: undefined, y: undefined }, id);
  if (!node) return [];
  const toSide = sideToward({ x: node.x, y: node.y, w: node.width, h: node.height }, anchor(box, side));
  return {
    changes: [
      { op: 'add', node },
      { op: 'edge', edge: { id: edgeId, fromNode: from.id, toNode: id, fromSide: side, toSide, ...(a.label ? { label: a.label } : {}), 'x-edge': {} } },
    ],
    select: [id],
  };
};

export function registerDiagramLogic(store: Store) {
  store.register('diagram.add', add);
  store.register('diagram.update', update);
  store.register('diagram.resize', resize);
  store.register('diagram.addConnected', addConnected);
}
