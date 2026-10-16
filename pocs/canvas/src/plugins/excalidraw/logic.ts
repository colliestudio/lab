import { generateKeyBetween } from 'fractional-indexing';
import type { Command, CommandCtx } from '../../core/store';
import { set, type CanvasDoc, type CanvasNode, type Change } from '../../core/doc';
import * as z from 'zod/mini';
import { command, view, type CommandSpec, type ViewSpec } from '../../core/agent';
import { resolveNode } from '../../core/query';
import type { PluginLogic } from '../logic';

// Excalidraw frames: the real Excalidraw editor embedded in a frame on the table. A frame is a
// JSON Canvas `text` node: `x-excalidraw` holds the scene's elements keyed by element id (a nested
// Y.Map in the live doc, so two people editing different elements both keep theirs), and
// `x-excalidraw-frame` the frame's title, lock and saved view (which part of the drawing the frame
// shows, at what zoom). The frame keeps its size; the drawing scrolls and zooms inside it.
// No DOM here: the bridge (Node) registers this too, so agents add shapes with the same commands.

export const NS = 'x-excalidraw';
export const FRAME = 'x-excalidraw-frame';
/** Padding around the content when a frame fits its drawing. */
export const PAD = 16;
/** Height of the frame's title bar (world px). */
export const BAR = 28;
// big enough that Excalidraw shows its desktop toolbar (not the mobile one) at 100%
export const FRAME_W = 820;
export const FRAME_H = 560;
export const MIN_W = 160;
export const MIN_H = 100;

/** Which part of the drawing a frame shows: scene point at the content's top-left, and the zoom. */
export interface View {
  x: number;
  y: number;
  zoom: number;
}
export interface FrameInfo {
  title?: string;
  /** Static: a picture you can't edit in place until it's unlocked. */
  locked?: boolean;
  view?: View;
}
export const frameOf = (n: CanvasNode | undefined) => (n?.[FRAME] ?? {}) as FrameInfo;
const isView = (v: unknown): v is View => !!v && typeof v === 'object' && [(v as View).x, (v as View).y, (v as View).zoom].every((k) => typeof k === 'number' && Number.isFinite(k)) && (v as View).zoom > 0;

/** The subset of an Excalidraw element this side reads. The rest is kept verbatim. */
export interface XElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  index?: string | null;
  points?: [number, number][];
  text?: string;
  containerId?: string | null;
  boundElements?: { id: string; type: string }[] | null;
  [k: string]: unknown;
}

export const isDrawing = (n: CanvasNode) => !!n[NS] && typeof n[NS] === 'object';

/** All stored elements (deleted ones too: they are tombstones for merging), in z order. */
export function elementsOf(n: CanvasNode | undefined): XElement[] {
  const m = (n?.[NS] ?? {}) as Record<string, XElement>;
  return Object.values(m)
    .filter((e) => e && typeof e === 'object' && typeof e.id === 'string')
    .sort((a, b) => cmpIndex(a.index, b.index) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export const liveElements = (n: CanvasNode | undefined) => elementsOf(n).filter((e) => !e.isDeleted);

const cmpIndex = (a?: string | null, b?: string | null) => (a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0;

/** Does `incoming` replace `current`? Excalidraw's rule: higher version, ties by lower nonce. */
export const newer = (incoming: XElement, current: XElement | undefined) =>
  !current || incoming.version > current.version || (incoming.version === current.version && incoming.versionNonce < current.versionNonce);

/** Content bounds of the visible elements (scene coordinates, rotation included), or undefined when empty. */
export function bounds(els: XElement[]): { x: number; y: number; w: number; h: number } | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) {
    if (e.isDeleted) continue;
    const pts: [number, number][] = Array.isArray(e.points) && e.points.length ? e.points : [[0, 0], [e.width, 0], [e.width, e.height], [0, e.height]];
    const a = typeof e.angle === 'number' ? e.angle : 0;
    // Excalidraw rotates around the middle of the element's own box
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const cos = Math.cos(a), sin = Math.sin(a);
    for (const [px, py] of pts) {
      const x = a ? cx + (px - cx) * cos - (py - cy) * sin : px;
      const y = a ? cy + (px - cx) * sin + (py - cy) * cos : py;
      x0 = Math.min(x0, e.x + x);
      y0 = Math.min(y0, e.y + y);
      x1 = Math.max(x1, e.x + x);
      y1 = Math.max(y1, e.y + y);
    }
  }
  return x0 === Infinity ? undefined : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The frame's content area (below the title bar), world px. */
export const contentSize = (n: CanvasNode) => ({ w: Math.max(1, n.width), h: Math.max(1, n.height - BAR) });

/** What the frame shows: its saved view, else the whole drawing fitted (never above 100%). */
export function viewOf(n: CanvasNode): View {
  const v = frameOf(n).view;
  if (isView(v)) return v;
  const { w, h } = contentSize(n);
  const b = bounds(liveElements(n));
  if (!b) return { x: 0, y: 0, zoom: 1 };
  const zoom = Math.min(1, w / (b.w + PAD * 2), h / (b.h + PAD * 2));
  return { x: b.x + b.w / 2 - w / 2 / zoom, y: b.y + b.h / 2 - h / 2 / zoom, zoom };
}

/** A frame by id or title (exact, else a unique case-insensitive substring). */
export function pickFrame(frames: CanvasNode[], ref: string): string | undefined {
  const byId = frames.find((f) => f.id === ref);
  if (byId) return byId.id;
  const q = ref.toLowerCase();
  const exact = frames.filter((f) => (frameOf(f).title ?? '').toLowerCase() === q);
  if (exact.length === 1) return exact[0].id;
  const some = frames.filter((f) => (frameOf(f).title ?? '').toLowerCase().includes(q));
  return some.length === 1 ? some[0].id : undefined;
}

/** Text a reader without Excalidraw sees (Obsidian, a text diff): the drawing's words. */
export function fallbackText(n: CanvasNode): string {
  const words = liveElements(n)
    .filter((e) => e.type === 'text' && typeof e.text === 'string' && e.text.trim())
    .map((e) => `- ${(e.text as string).replace(/\s*\n\s*/g, ' ')}`);
  const title = frameOf(n).title;
  return [`**${title ? `${title} (Excalidraw)` : 'Excalidraw drawing'}** (open in Canvas to edit)`, ...(words.length ? ['', ...words] : [])].join('\n');
}

// ------------------------------------------------------------ commands

interface CreateArgs {
  /** Top-left with width/height (a dragged frame), else the center of a default-size frame. */
  x: number;
  y: number;
  width?: number;
  height?: number;
  title?: string;
  elements?: XElement[];
  /** Agent-friendly shapes (see `fromShapes`), converted here. */
  shapes?: Shape[];
}
const create: Command<CreateArgs> = (doc, a, ctx) => {
  if (typeof a?.x !== 'number' || typeof a?.y !== 'number') return [];
  const map: Record<string, XElement> = {};
  for (const e of a.elements ?? []) if (e?.id) map[e.id] = e;
  if (a.shapes?.length) for (const e of fromShapes(a.shapes, [], ctx)) map[e.id] = e;
  const sized = typeof a.width === 'number' && typeof a.height === 'number' && a.width > 0 && a.height > 0;
  const width = Math.round(sized ? Math.max(MIN_W, a.width!) : FRAME_W);
  const height = Math.round(sized ? Math.max(MIN_H, a.height!) : FRAME_H);
  const x = Math.round(sized ? a.x : a.x - width / 2);
  const y = Math.round(sized ? a.y : a.y - height / 2);
  const id = ctx.newId();
  const info: FrameInfo = typeof a.title === 'string' && a.title.trim() ? { title: a.title.trim().slice(0, 80) } : {};
  const node: CanvasNode = { id, type: 'text', x, y, width, height, z: doc.topZ + 1, [NS]: map, [FRAME]: info };
  return { changes: [{ op: 'add', node }], select: [id] };
};

/** Title, lock, saved view (null = fit the drawing), size. */
interface FrameArgs {
  id: string;
  title?: string | null;
  locked?: boolean;
  view?: View | null;
  width?: number;
  height?: number;
}
const frame: Command<FrameArgs> = (doc, a) => {
  const n = doc.get(a?.id);
  if (!n || !isDrawing(n)) return [];
  const f = frameOf(n);
  const out: Change[] = [];
  if (a.title !== undefined) {
    const t = typeof a.title === 'string' ? a.title.trim().slice(0, 80) : '';
    if ((t || undefined) !== f.title) out.push(set(n.id, `${FRAME}.title`, t || undefined));
  }
  if (typeof a.locked === 'boolean' && a.locked !== !!f.locked) out.push(set(n.id, `${FRAME}.locked`, a.locked || undefined));
  if (a.view === null && f.view) out.push(set(n.id, `${FRAME}.view`, undefined));
  if (isView(a.view)) out.push(set(n.id, `${FRAME}.view`, { x: a.view.x, y: a.view.y, zoom: a.view.zoom }));
  if (typeof a.width === 'number' && Number.isFinite(a.width)) {
    const w = Math.round(Math.max(MIN_W, a.width));
    if (w !== n.width) out.push(set(n.id, 'width', w));
  }
  if (typeof a.height === 'number' && Number.isFinite(a.height)) {
    const h = Math.round(Math.max(MIN_H, a.height));
    if (h !== n.height) out.push(set(n.id, 'height', h));
  }
  return out;
};

/**
 * Write elements from an editor: each one that differs from the stored copy. The editor's edit
 * wins (last writer): when the stored copy is as new or newer (someone else's edit or a table
 * undo crossed ours), it's written one version above, so every open editor takes it.
 */
interface PutArgs {
  id: string;
  elements: XElement[];
}
const put: Command<PutArgs> = (doc, a, ctx) => {
  const n = doc.get(a?.id);
  if (!n || !isDrawing(n) || !Array.isArray(a.elements)) return [];
  const cur = (n[NS] ?? {}) as Record<string, XElement>;
  const changes: Change[] = [];
  for (const e of a.elements) {
    if (!e || typeof e.id !== 'string' || typeof e.version !== 'number') continue;
    const old = cur[e.id];
    if (old && old.version === e.version && old.versionNonce === e.versionNonce) continue;
    const el = newer(e, old) ? e : { ...e, version: old!.version + 1, versionNonce: nonce(ctx) };
    changes.push(set(n.id, `${NS}.${e.id}`, el));
  }
  return changes;
};

/** Agents: add shapes (and arrows between them) to a drawing. Returns the new element ids. */
interface AddArgs {
  id: string;
  shapes: Shape[];
}
const add: Command<AddArgs> = (doc, a, ctx) => {
  const n = doc.get(a?.id);
  if (!n || !isDrawing(n) || !Array.isArray(a.shapes) || !a.shapes.length) return [];
  if (frameOf(n).locked) throw new Error('the frame is locked (a static picture): unlock it first');
  const cur = elementsOf(n);
  const made = fromShapes(a.shapes, cur, ctx);
  const existingIds = new Set(cur.map((e) => e.id));
  const next = Object.fromEntries(cur.map((e) => [e.id, e]));
  const changes: Change[] = [];
  for (const e of made) {
    // an arrow bound to an existing shape changes that shape's boundElements too: bump it
    const old = next[e.id];
    const el = old ? { ...e, version: old.version + 1, versionNonce: nonce(ctx), updated: now(ctx) } : e;
    next[e.id] = el;
    changes.push(set(n.id, `${NS}.${e.id}`, el));
  }
  // new shapes out of the frame's saved view: back to fitting the whole drawing, so they show
  const v = frameOf(n).view;
  if (isView(v)) {
    const { w, h } = contentSize(n);
    const nb = bounds(made);
    if (nb && (nb.x < v.x || nb.y < v.y || nb.x + nb.w > v.x + w / v.zoom || nb.y + nb.h > v.y + h / v.zoom)) changes.push(set(n.id, `${FRAME}.view`, undefined));
  }
  const shown = made.filter((e) => !existingIds.has(e.id) && !(e.type === 'text' && e.containerId)).length;
  const what = `${shown} shape${shown === 1 ? '' : 's'}`;
  return { changes, select: [n.id], events: [{ type: 'excalidraw.add', text: `drew ${what} in a drawing`, targets: [n.id], cue: 'pulse' }] };
};

/** Agents: delete elements by id (with their bound labels). */
interface RemoveArgs {
  id: string;
  ids: string[];
}
const remove: Command<RemoveArgs> = (doc, a, ctx) => {
  const n = doc.get(a?.id);
  if (!n || !isDrawing(n) || !Array.isArray(a.ids)) return [];
  if (frameOf(n).locked) throw new Error('the frame is locked (a static picture): unlock it first');
  const all = elementsOf(n);
  const gone = new Set(a.ids);
  for (const e of all) if (e.containerId && gone.has(e.containerId)) gone.add(e.id);
  const changes: Change[] = [];
  for (const e of all) {
    if (!gone.has(e.id) || e.isDeleted) continue;
    const el = { ...e, isDeleted: true, version: e.version + 1, versionNonce: nonce(ctx), updated: now(ctx) };
    changes.push(set(n.id, `${NS}.${e.id}`, el));
  }
  if (!changes.length) return [];
  return { changes, events: [{ type: 'excalidraw.remove', text: 'erased shapes in a drawing', targets: [n.id], cue: 'pulse' }] };
};

export const commands = { create, put, add, remove, frame };

export function registerExcalidrawLogic(store: { register(name: string, cmd: Command, spec?: CommandSpec): void; registerView?(name: string, spec: ViewSpec): void; exportFilters: ((d: CanvasDoc, c: CommandCtx) => CanvasDoc)[] }) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`excalidraw.${name}`, cmd as Command, specs[name]);
  store.registerView?.('excalidraw.shapes', shapesView);
  // a file reader without Canvas sees the drawing's text (JSON Canvas text nodes need `text`)
  store.exportFilters.push((d) => ({ ...d, nodes: d.nodes.map((n) => (isDrawing(n) ? { ...n, text: fallbackText(n) } : n)) }));
}


// ------------------------------------------------------------ agent shapes → Excalidraw elements

/**
 * What an agent writes: a small skeleton per shape, like Excalidraw's own ElementSkeleton.
 * Positions are the drawing's own coordinates (see `describe`; default: a row right of the drawing's shapes). Arrows name shapes by
 * `ref` (given in this call) or by an existing element id.
 */
export type Shape =
  | { type: 'rectangle' | 'ellipse' | 'diamond'; ref?: string; x?: number; y?: number; width?: number; height?: number; label?: string; stroke?: string; fill?: string; dashed?: boolean }
  | { type: 'text'; ref?: string; x?: number; y?: number; text: string; size?: number; stroke?: string }
  | { type: 'arrow'; ref?: string; from: string; to: string; label?: string; stroke?: string; dashed?: boolean; ends?: 'none' | 'end' | 'both' };

const FONT = 5; // Excalifont
const FONT_SIZE = 20;
const LINE = 1.25;
const GAP = 40;
const SAFE_REF = /^[A-Za-z0-9_-]{1,40}$/;

const nonce = (ctx: CommandCtx) => Math.floor(ctx.random() * 2 ** 31);
const now = (ctx: CommandCtx) => ctx.now?.() ?? Date.now();

/** Rough text box (no DOM in Node): Excalidraw re-measures when it opens the drawing. */
export function textSize(text: string, size = FONT_SIZE) {
  const lines = text.split('\n');
  return { width: Math.ceil(Math.max(...lines.map((l) => l.length)) * size * 0.6) + 4, height: Math.ceil(lines.length * size * LINE) };
}

function base(ctx: CommandCtx, type: string, x: number, y: number, width: number, height: number, index: string, o: { stroke?: string; fill?: string; dashed?: boolean; id?: string } = {}): XElement {
  return {
    id: o.id ?? ctx.newId(),
    type,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    angle: 0,
    strokeColor: o.stroke ?? '#1e1e1e',
    backgroundColor: o.fill ?? 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: o.dashed ? 'dashed' : 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    roundness: type === 'rectangle' || type === 'diamond' ? { type: 3 } : type === 'arrow' ? { type: 2 } : null,
    seed: nonce(ctx),
    version: 1,
    versionNonce: nonce(ctx),
    isDeleted: false,
    boundElements: null,
    updated: now(ctx),
    link: null,
    locked: false,
  };
}

function textEl(ctx: CommandCtx, text: string, x: number, y: number, index: string, o: { size?: number; stroke?: string; containerId?: string; id?: string } = {}): XElement {
  const size = o.size ?? FONT_SIZE;
  const t = textSize(text, size);
  return {
    ...base(ctx, 'text', x - (o.containerId ? t.width / 2 : 0), y - (o.containerId ? t.height / 2 : 0), t.width, t.height, index, { stroke: o.stroke, id: o.id }),
    text,
    originalText: text,
    fontSize: size,
    fontFamily: FONT,
    textAlign: o.containerId ? 'center' : 'left',
    verticalAlign: o.containerId ? 'middle' : 'top',
    containerId: o.containerId ?? null,
    autoResize: true,
    lineHeight: LINE,
  };
}

const center = (e: XElement) => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 });

/** Where the segment from `e`'s center towards `p` leaves its box (+ gap). */
function edgePoint(e: XElement, p: { x: number; y: number }, gap: number) {
  const c = center(e);
  const dx = p.x - c.x, dy = p.y - c.y;
  if (!dx && !dy) return c;
  const hw = e.width / 2 + gap, hh = e.height / 2 + gap;
  const t = e.type === 'ellipse' || e.type === 'diamond'
    ? 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2) * (e.type === 'diamond' ? Math.SQRT1_2 * 1.2 : 1)
    : Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: c.x + dx * Math.min(t, 1), y: c.y + dy * Math.min(t, 1) };
}

/**
 * Convert agent shapes into Excalidraw elements, given the drawing's current elements (for
 * placement, z order and arrows to existing shapes). Bound shapes come back with the arrow listed
 * in their `boundElements` (existing ones too: the caller bumps their version).
 */
export function fromShapes(shapes: Shape[], existing: XElement[], ctx: CommandCtx): XElement[] {
  const live = existing.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  /** ref (or element id) → element id */
  const refs = new Map<string, string>();
  const out = new Map<string, XElement>();
  let last = existing.reduce<string | null>((m, e) => (e.index && (!m || e.index > m) ? e.index : m), null);
  const idx = () => (last = generateKeyBetween(last, null));
  const b = bounds(live);
  let cx = b ? b.x + b.w + GAP * 2 : 0;
  const rowY = b ? b.y : 0;
  const touch = (e: XElement, bound: { id: string; type: string }) => {
    const cur = out.get(e.id) ?? e;
    const next = { ...cur, boundElements: [...(cur.boundElements ?? []), bound] };
    out.set(e.id, next);
    byId.set(e.id, next);
    return next;
  };
  const find = (r: string) => byId.get(refs.get(r) ?? r);
  /** A new element takes its `ref` as id when that is a free, plain id (agents can name shapes). */
  const idFor = (ref?: string) => (ref && SAFE_REF.test(ref) && !byId.has(ref) && !existing.some((e) => e.id === ref) ? ref : undefined);

  for (const s of shapes) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'rectangle' || s.type === 'ellipse' || s.type === 'diamond') {
      const lt = s.label ? textSize(s.label) : { width: 0, height: 0 };
      const w = s.width ?? Math.max(s.type === 'diamond' ? 160 : 140, lt.width * (s.type === 'rectangle' ? 1 : 1.5) + 40);
      const h = s.height ?? Math.max(s.type === 'diamond' ? 100 : 70, lt.height * (s.type === 'rectangle' ? 1 : 1.6) + 30);
      const x = s.x ?? cx;
      const y = s.y ?? rowY;
      if (s.x === undefined) cx += w + GAP * 2;
      let shape = base(ctx, s.type, x, y, w, h, idx(), { ...s, id: idFor(s.ref) });
      out.set(shape.id, shape);
      if (s.ref) refs.set(s.ref, shape.id);
      byId.set(shape.id, shape);
      if (s.label) {
        const c = center(shape);
        const t = textEl(ctx, s.label, c.x, c.y, idx(), { containerId: shape.id, stroke: s.stroke });
        shape = touch(shape, { id: t.id, type: 'text' });
        out.set(t.id, t);
      }
    } else if (s.type === 'text') {
      if (typeof s.text !== 'string') continue;
      const t = textEl(ctx, s.text, s.x ?? cx, s.y ?? rowY, idx(), { size: s.size, stroke: s.stroke, id: idFor(s.ref) });
      if (s.x === undefined) cx += t.width + GAP * 2;
      out.set(t.id, t);
      if (s.ref) refs.set(s.ref, t.id);
      byId.set(t.id, t);
    } else if (s.type === 'arrow') {
      const from = find(s.from);
      const to = find(s.to);
      if (!from || !to || from.id === to.id) continue;
      const p0 = edgePoint(from, center(to), 6);
      const p1 = edgePoint(to, center(from), 6);
      const a: XElement = {
        ...base(ctx, 'arrow', p0.x, p0.y, Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y), idx(), { ...s, id: idFor(s.ref) }),
        points: [[0, 0], [Math.round(p1.x - p0.x), Math.round(p1.y - p0.y)]],
        lastCommittedPoint: null,
        startBinding: { elementId: from.id, focus: 0, gap: 6 },
        endBinding: { elementId: to.id, focus: 0, gap: 6 },
        startArrowhead: s.ends === 'both' ? 'arrow' : null,
        endArrowhead: s.ends === 'none' ? null : 'arrow',
        elbowed: false,
      };
      out.set(a.id, a);
      byId.set(a.id, a);
      if (s.ref) refs.set(s.ref, a.id);
      touch(from, { id: a.id, type: 'arrow' });
      touch(to, { id: a.id, type: 'arrow' });
      if (s.label) {
        const t = textEl(ctx, s.label, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2, idx(), { containerId: a.id, stroke: s.stroke });
        out.set(a.id, { ...out.get(a.id)!, boundElements: [{ id: t.id, type: 'text' }] });
        out.set(t.id, t);
      }
    }
  }
  return [...out.values()];
}

/** Short, agent-readable listing of a drawing's shapes, in the drawing's coordinates. */
export function describe(n: CanvasNode): { id: string; type: string; label?: string; x: number; y: number; from?: string; to?: string }[] {
  const els = liveElements(n);
  const label = new Map(els.filter((e) => e.type === 'text' && e.containerId).map((e) => [e.containerId as string, e.text as string]));
  return els
    .filter((e) => !(e.type === 'text' && e.containerId))
    .map((e) => ({
      id: e.id,
      type: e.type,
      ...(label.has(e.id) || e.type === 'text' ? { label: label.get(e.id) ?? (e.text as string) } : {}),
      x: Math.round(e.x),
      y: Math.round(e.y),
      ...(e.type === 'arrow'
        ? { from: (e.startBinding as { elementId?: string } | null)?.elementId, to: (e.endBinding as { elementId?: string } | null)?.elementId }
        : {}),
    }));
}


// ------------------------------------------------------------ agent descriptions (see core/agent.ts)

/** The drawing an agent means: a frame by id or title, else the only one on the canvas. */
function drawingId(doc: { nodes: CanvasNode[] }, ref?: string): string {
  const ds = doc.nodes.filter(isDrawing);
  if (ref) return pickFrame(ds, ref) ?? resolveNode(doc, ref).id;
  if (ds.length === 1) return ds[0].id;
  throw new Error(ds.length ? `${ds.length} drawings: pass drawing (${ds.map((d) => d.id).join(', ')})` : 'no drawing on the canvas: draw one first (excalidraw.create)');
}

const shapeArg = z.looseObject({
  type: z.enum(['rectangle', 'ellipse', 'diamond', 'text', 'arrow']),
  ref: z.optional(z.string().check(z.meta({ description: 'your name for it (becomes its id when free): arrows point at refs or shape ids' }))),
  label: z.optional(z.string().check(z.meta({ description: 'text inside a shape, or on an arrow' }))),
  text: z.optional(z.string().check(z.meta({ description: 'for type text' }))),
  x: z.optional(z.number()),
  y: z.optional(z.number()),
  width: z.optional(z.number()),
  height: z.optional(z.number()),
  size: z.optional(z.number().check(z.meta({ description: 'font size for type text (default 20)' }))),
  from: z.optional(z.string().check(z.meta({ description: 'arrow start: ref or shape id' }))),
  to: z.optional(z.string().check(z.meta({ description: 'arrow end: ref or shape id' }))),
  stroke: z.optional(z.string().check(z.meta({ description: '#hex' }))),
  fill: z.optional(z.string().check(z.meta({ description: '#hex' }))),
  dashed: z.optional(z.boolean()),
  ends: z.optional(z.enum(['none', 'end', 'both'])),
});
const drawing = z.optional(z.string().check(z.meta({ description: 'frame node id or title (default: the only Excalidraw frame on the canvas)' })));
const IN = { in: 'drawing' };
const pickFlag = (flags: Record<string, string>) => (flags.in ? { drawing: flags.in } : {});

const specs: Record<string, CommandSpec> = {
  create: command({
    description:
      'Put a new Excalidraw frame on the canvas: a titled frame people draw in with the real Excalidraw (it scrolls/zooms inside; the frame keeps its size), optionally with shapes. x/y = center (640x440), or top-left with width/height. Returns its id.',
    args: z.strictObject({ title: z.optional(z.string()), x: z.optional(z.number()), y: z.optional(z.number()), width: z.optional(z.number()), height: z.optional(z.number()), shapes: z.optional(z.array(shapeArg)) }),
    example: { title: 'Flow', shapes: [{ type: 'rectangle', ref: 'a', label: 'Start' }] },
    tool: 'canvas_draw_new',
    cli: [{ verb: 'draw new' }],
    toCommand: (a) => ({ ...a, x: a.x ?? 0, y: a.y ?? 0 }),
  }),
  add: command({
    description:
      'Add shapes to an Excalidraw drawing: boxes (rectangle/ellipse/diamond with a label), text, arrows between shapes (from/to = a ref from this call or an existing shape id, optional label). x/y are the drawing’s own coordinates (see canvas_draw_shapes; boxes ~140x70); without x/y shapes go in a row right of the drawing. The frame shows new shapes (it re-fits if they fall outside its view).',
    args: z.strictObject({ drawing, shapes: z.array(shapeArg) }),
    example: { shapes: [{ type: 'rectangle', ref: 'a', label: 'Start' }, { type: 'ellipse', ref: 'b', label: 'End' }, { type: 'arrow', from: 'a', to: 'b', label: 'go' }] },
    tool: 'canvas_draw_add',
    cli: [
      { verb: 'draw add', rest: 'shapes', alias: IN },
      { verb: 'draw box', alias: IN, compose: (w, f) => ({ ...pickFlag(f), shapes: [{ type: f.type ?? 'rectangle', label: w.join(' '), ref: f.ref }] }) },
      { verb: 'draw arrow', alias: IN, compose: (w, f) => ({ ...pickFlag(f), shapes: [{ type: 'arrow', from: w[0], to: w[1], label: f.label }] }) },
    ],
    toCommand: (a, ctx) => ({ id: drawingId(ctx.doc, a.drawing), shapes: a.shapes }),
    result: (_r, a, ctx) => describe(ctx.doc.get(drawingId(ctx.doc, a.drawing))!),
  }),
  remove: command({
    description: 'Delete shapes from an Excalidraw drawing by id (their labels go too).',
    args: z.strictObject({ drawing, ids: z.array(z.string()) }),
    example: { ids: ['a'] },
    tool: 'canvas_draw_remove',
    cli: [{ verb: 'draw rm', rest: 'ids', alias: IN }],
    toCommand: (a, ctx) => ({ id: drawingId(ctx.doc, a.drawing), ids: a.ids }),
  }),
  frame: command({
    description: 'Change an Excalidraw frame: title, locked (a static picture people cannot draw in until unlocked), fit (show the whole drawing again).',
    args: z.strictObject({ drawing, title: z.optional(z.string()), locked: z.optional(z.boolean()), fit: z.optional(z.boolean()) }),
    example: { title: 'Checkout flow' },
    tool: 'canvas_draw_frame',
    cli: [
      { verb: 'draw title', rest: 'title', alias: IN },
      { verb: 'draw lock', set: { locked: true }, alias: IN },
      { verb: 'draw unlock', set: { locked: false }, alias: IN },
      { verb: 'draw fit', set: { fit: true }, alias: IN },
    ],
    toCommand: (a, ctx) => ({ id: drawingId(ctx.doc, a.drawing), title: a.title, locked: a.locked, view: a.fit ? null : undefined }),
  }),
};

const shapesView: ViewSpec = view({
  description: "List an Excalidraw drawing's shapes: id, type, label, position, arrows (from → to ids).",
  args: z.strictObject({ drawing }),
  example: {},
  tool: 'canvas_draw_shapes',
  cli: [{ verb: 'draw shapes', alias: IN }],
  read: (doc, a) => describe(doc.get(drawingId(doc, a.drawing))!),
  text: (v) =>
    (v as ReturnType<typeof describe>)
      .map((s) => `${s.id.padEnd(22)} ${s.type.padEnd(9)} ${String(s.x).padStart(6)},${String(s.y).padEnd(6)} ${s.label ?? ''}${s.from ? `  ${s.from} → ${s.to}` : ''}`)
      .join('\n'),
});

const GUIDE = `Drawings live in Excalidraw frames; people draw in them with the real Excalidraw.
1. excalidraw.create makes a frame (optionally with shapes) and returns its id.
2. excalidraw.add puts shapes in: boxes (rectangle, ellipse, diamond) with a label, text, and arrows between them.
   Give a box a ref; arrows point at refs from the same call or at existing shape ids.
3. Coordinates are the drawing's own (excalidraw.shapes lists them); boxes are about 140x70. Without x/y, shapes go in a row right of the drawing.
4. excalidraw.remove deletes shapes by id; excalidraw.frame renames the frame, locks it (a static picture) or fits the view.
With several drawings pass drawing (frame id or title) on every call.`;

export const logic: PluginLogic = {
  id: 'excalidraw',
  title: 'Excalidraw',
  summary: 'Drawings in Excalidraw frames: add boxes, text and arrows by name, list shapes, rename, lock or fit the frame.',
  guide: GUIDE,
  register: registerExcalidrawLogic,
};
