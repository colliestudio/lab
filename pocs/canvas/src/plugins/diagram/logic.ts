// runtime imports come from the DOM-free core modules: the Node bridge loads this file too
import * as z from 'zod/mini';
import { command, nodeRef, redirect, view, type CommandSpec } from '../../core/agent';
import type { CanvasNode, Change, DocView } from '../../core/doc';
import { anchor, isSide, NORMAL, sideToward, type Side } from '../../core/edges';
import type { Command, DispatchResult, Store } from '../../core/store';
import type { PluginLogic } from '../logic';
import { graphOf, graphText } from './graph';
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
      { op: 'edge', edge: { id: edgeId, fromNode: from.id, toNode: id, fromSide: side, toSide, ...(typeof a.label === 'string' && a.label ? { label: a.label } : {}), 'x-edge': {} } },
    ],
    select: [id],
  };
};

// Agent side: how the commands describe themselves (see core/agent.ts). A straight port of the
// tools agents had before commands described themselves; arrows are core.connect / core.edge.
const kind = z.enum(['rect', 'ellipse', 'diamond', 'text', 'sticky']);
const side = z.enum(['top', 'right', 'bottom', 'left']);
const look = {
  stroke: z.nullable(z.optional(z.string().check(z.meta({ description: 'outline and text color, a CSS color or a JSON Canvas preset 1-6; null = default' })))),
  fill: z.nullable(z.optional(z.string().check(z.meta({ description: 'fill color, #hex, or "none" for see-through; null = the kind\'s default' })))),
  dashed: z.optional(z.boolean()),
  size: z.nullable(z.optional(z.number().check(z.meta({ description: 'text size in px (default 18); null = default' })))),
};
const geometry = { x: z.optional(z.number()), y: z.optional(z.number()), width: z.optional(z.number()), height: z.optional(z.number()) };

/** A spot beside `n` (default: below it) for a shape of the given size. */
function besideSpot(n: CanvasNode, side: string, w: number, h: number) {
  const gap = 90;
  const at: Record<string, { x: number; y: number }> = {
    bottom: { x: n.x + n.width / 2 - w / 2, y: n.y + n.height + gap },
    top: { x: n.x + n.width / 2 - w / 2, y: n.y - gap - h },
    right: { x: n.x + n.width + gap, y: n.y + n.height / 2 - h / 2 },
    left: { x: n.x - gap - w, y: n.y + n.height / 2 - h / 2 },
  };
  return at[side];
}

/** What adding returns: the new shape's id, and the arrow's when it came with one. */
const created = (r: DispatchResult) => {
  const arrow = r.changes.find((c) => c.op === 'edge');
  return { id: r.select?.[0], ...(arrow?.op === 'edge' ? { arrow: arrow.edge.id } : {}), changed: r.changes.length };
};

const GUIDE = `Diagrams: shapes (rect, ellipse, diamond, text, sticky) with words, joined by arrows.
- diagram.add {kind, text} adds a shape and returns its id. Place it with near: <shape> + side, x/y (top-left) or cx/cy (center); with none it goes right of everything.
- diagram.add {from: <shape>, text, label} adds a shape with a labelled arrow from <shape>: the fast way to grow a flowchart. Returns the shape id and the arrow id.
- core.connect {from, to, label} joins two existing shapes. core.edge {arrow, label, dashed, curve, color, start, end} changes an arrow; core.unedge removes arrows.
- diagram.update {node, ...} changes text, kind, stroke, fill, dashed, text size, place (x/y, dx/dy) or size. diagram.resize sets the whole box.
- Shapes are referred to by id or by their text.
- Check with the view diagram.graph (canvas_look with view "diagram.graph"): shapes with ids, kinds, boxes and frame, arrows with labels, overlapping shapes.
- To put a diagram in a frame: draw it, then frames.create {around: [shape ids], label}.
- core.move moves shapes, core.delete removes them (and their arrows).
- An Excalidraw drawing (canvas_draw_*) is one node with its own shapes inside; diagram shapes are separate nodes, so core.connect, frames and core.move work on them.`;

export const specs: Record<string, CommandSpec> = {
  add: command({
    description:
      'Add a diagram shape (rect, ellipse, diamond, text, sticky). Place it with x/y (top-left), cx/cy (center), beside `near` (on `side`), or right of everything. With `from` it is a new shape connected by an arrow from that shape (the fast flowchart step; `side` = which side of `from` the arrow leaves, `at` = where the new center goes). Returns the new id (and the arrow id with `from`). For a diagram (architecture, flowchart): add the shapes and join them with canvas_arrow; to put them in a frame, canvas_do frames.create {around: [shapes], label}. Each shape is its own node, which is what arrows, frames and moves work on. For a freehand sketch, or when asked for Excalidraw, use canvas_draw_new instead.',
    args: z.strictObject({
      kind: z.optional(kind.check(z.meta({ description: 'default rect' }))),
      text: z.optional(z.string()),
      ...geometry,
      cx: z.optional(z.number()),
      cy: z.optional(z.number()),
      from: z.optional(nodeRef('connect from this shape')),
      near: z.optional(nodeRef('place the shape beside this one')),
      side: z.optional(side),
      at: z.optional(z.strictObject({ x: z.number(), y: z.number() })),
      label: z.optional(z.string().check(z.meta({ description: 'label for the arrow (with `from`)' }))),
      ...look,
    }),
    example: { kind: 'rect', text: 'Start' },
    tool: 'canvas_add_shape',
    cli: [{ verb: 'shape', pos: ['kind'], rest: 'text', keepNone: ['fill'] }],
    toCommand: ({ from, near, ...a }, ctx) => {
      if (from) return redirect('diagram.addConnected', { ...a, from, at: a.at ?? (a.x !== undefined && a.y !== undefined ? { x: a.x, y: a.y } : undefined) });
      if (!near) return a;
      const n = ctx.doc.get(near);
      const p = n && besideSpot(n, a.side ?? 'bottom', a.width ?? 160, a.height ?? 90);
      if (!p) throw new Error(`no node ${near}`);
      return { ...a, ...p };
    },
    result: created,
  }),
  update: command({
    description: 'Change a diagram shape: text, kind, colors, dashed, text size, and its place or size (x/y absolute, dx/dy relative, width/height). null clears a color or size.',
    args: z.strictObject({ node: nodeRef(), text: z.optional(z.string()), kind: z.optional(kind), ...geometry, dx: z.optional(z.number()), dy: z.optional(z.number()), ...look }),
    example: { node: 'Start', fill: '#ffe08a', dashed: true },
    tool: 'canvas_style_shape',
    cli: [{ verb: 'style', pos: ['node'], keepNone: ['fill'] }],
    toCommand: ({ node, ...a }) => ({ id: node, ...a }),
    result: (r, a) => ({ id: a.node, changed: r.changes.length }),
  }),
  addConnected: command({
    description: 'Add a new shape with an arrow to it from `from` (the flowchart step). `side` = which side of `from` the arrow leaves; `at` = where the new center goes. Same as diagram.add with `from`.',
    args: z.strictObject({ from: nodeRef(), kind: z.optional(kind), text: z.optional(z.string()), side: z.optional(side), at: z.optional(z.strictObject({ x: z.number(), y: z.number() })), label: z.optional(z.string()), width: z.optional(z.number()), height: z.optional(z.number()), ...look }),
    example: { from: 'Start', text: 'Next', side: 'right' },
    result: created,
  }),
  resize: command({
    description: "Set a shape's whole box at once: top-left x/y and width/height (what the resize handles do). For just one of them use diagram.update.",
    args: z.strictObject({ node: nodeRef(), x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    example: { node: 'Start', x: 0, y: 0, width: 200, height: 100 },
    toCommand: ({ node, ...a }) => ({ id: node, ...a }),
    result: (r, a) => ({ id: a.node, changed: r.changes.length }),
  }),
};

export function registerDiagramLogic(store: Store) {
  store.summaryExt.add('x-shape'); // a shape's kind and colors show in listings
  store.register('diagram.add', add, specs.add);
  store.register('diagram.update', update, specs.update);
  store.register('diagram.resize', resize, specs.resize);
  store.register('diagram.addConnected', addConnected, specs.addConnected);
  store.registerView(
    'diagram.graph',
    view({
      description: 'The diagram as text: every shape (kind, text, id, box, which frame it is in, non-default style) and every arrow (from → to, label, id, style), plus shapes that overlap.',
      args: z.strictObject({ in: z.optional(nodeRef('only shapes inside this frame (id or title)')) }),
      example: {},
      read: (doc, a) => graphOf(doc, a.in),
      text: (v) => graphText(v as ReturnType<typeof graphOf>),
    }),
  );
}

export const logic: PluginLogic = { id: 'diagram', title: 'Diagram', summary: 'Shapes (boxes, ellipses, diamonds, text, stickies) joined by arrows.', guide: GUIDE, register: registerDiagramLogic };
