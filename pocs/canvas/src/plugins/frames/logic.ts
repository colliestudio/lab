import * as z from 'zod/mini';
import { command, nodeRef, view, type CommandSpec } from '../../core/agent';
import type { CanvasNode, Command, DocView, Store } from '../../core';
import { titleOf } from '../../core/query';
import type { PluginLogic } from '../logic';
import { MIN_H, MIN_W, cleanLabel, commands, freeSpot, includeBox } from './commands';
import { frameAt, isFrame, isPortal, memberships, orderedFrames } from './model';
import { framesOf, framesText } from './text';

/**
 * Membership rule state: while a pointer is down the frame of every node is frozen at what it was
 * at the press, so a frame dragged over other objects doesn't scoop them up on the way (geometry
 * decides again on release).
 */
let frozen: Map<string, string> | null = null;
/** Freeze frame membership as it is in `nodes` (until `thaw`). */
export function freezeMembership(nodes: readonly CanvasNode[]) {
  frozen = memberships(nodes);
}
/** Back to geometry; true if it was frozen (the caller should invalidate its store). */
export function thawMembership(): boolean {
  const was = frozen !== null;
  frozen = null;
  return was;
}

// Agent side: a spec per command, the frames.outline view, the guide. Refusals with a reason are
// thrown in the adapters (`toCommand`); the commands keep the store contract (bad args do nothing),
// so the UI, which dispatches without specs, is unchanged.

const ref = nodeRef('frame (id or its title)');
const roomId = z.string().check(z.regex(/^[a-z0-9][a-z0-9-]{0,62}$/), z.meta({ description: 'room id: lowercase letters, digits and dashes' }));

const quoted = (n: CanvasNode | undefined, id: string) => (n ? `“${titleOf(n) || n.type}” (${id})` : `no node ${id}`);
const framesList = (doc: DocView) => orderedFrames(doc).map((f) => quoted(f, f.id)).join(', ') || 'none yet (frames.create makes one)';

/** The frame (or portal, when allowed) `id` names, else an error that lists the frames. */
function needFrame(doc: DocView, id: string, portal = false): CanvasNode {
  const n = doc.get(id);
  if (isFrame(n) || (portal && isPortal(n))) return n!;
  throw new Error(n ? `${quoted(n, id)} is not a ${portal ? 'frame or portal' : 'frame'}; frames: ${framesList(doc)}` : `no node ${id}`);
}
function needPortal(doc: DocView, id: string): CanvasNode {
  const n = doc.get(id);
  if (isPortal(n)) return n!;
  throw new Error(n ? `${quoted(n, id)} is not a portal` : `no node ${id}`);
}

/** Riders of a frame before an include ran, per call (the adapter and the result share the ctx). */
const included = new WeakMap<object, { before: Set<string>; parent?: string }>();
const order = (doc: DocView, id: string) => orderedFrames(doc).findIndex((f) => f.id === id) + 1;
const inside = (doc: DocView, id: string) => doc.riders(id).filter((n) => doc.isVisible(n.id)).length;
const changed = (r: { changes: unknown[] }) => r.changes.length;

const GUIDE = `A frame is a named area (a JSON Canvas group): whatever has its center inside it is in it and moves with it.
- Draw first, then frame it: frames.create {around: [ids or titles], label} fits a frame around those nodes. frames.create {label} alone makes an empty 640x420 frame right of everything.
- frames.include {id, nodes} grows a frame so more nodes are inside it. Shapes added later land right of everything: if other frames lie in between it refuses (core.move the nodes next to the frame first, or force: true); \`captured\` in the result names other nodes it took in.
- frames.resize sets its size (top-left stays); core.move {ids: [frame]} moves it with its contents; frames.rename renames it.
- Frames have an order (the slides of a presentation): frames.reorder {id, to} (1-based), frames.skip leaves one out.
- frames.unframe removes a frame and keeps its contents; core.delete removes it with them.
- Check with the view frames.outline (canvas_look with view "frames.outline"): frames in order, what is in each, what is in none. canvas_list also shows a node's frame as its column.
- Presenting and following a presenter are people's screens: an agent can't present, but the order and skips are what gets presented.`;

export const specs: Record<string, CommandSpec> = {
  create: command({
    description:
      'Add a frame: a named area that holds what is inside it. `around` fits it around those nodes (with a margin and room for the title); else it is a box at x/y (top-left) of width x height (default 640x420), or right of everything when no position is given. Returns the id, its place in the order and how many nodes are inside.',
    args: z.strictObject({
      label: z.optional(z.string().check(z.meta({ description: 'the frame\'s title (default "Frame N")' }))),
      around: z.optional(z.array(nodeRef('node to frame (id or title)')).check(z.minLength(1))),
      x: z.optional(z.number()),
      y: z.optional(z.number()),
      width: z.optional(z.number()),
      height: z.optional(z.number()),
    }),
    example: { label: 'Architecture', around: ['Browser', 'API server'] },
    toCommand: ({ around, ...a }, ctx) => {
      if (around) {
        if (!around.some((id) => ctx.doc.get(id) && ctx.doc.isVisible(id))) throw new Error('none of the nodes in `around` is on the table');
        return { ...a, around };
      }
      if ((a.x === undefined) !== (a.y === undefined)) throw new Error('give both x and y (top-left), or neither');
      if (a.x !== undefined) return a;
      return { ...a, ...freeSpot(ctx.doc, a.width ?? 640, a.height ?? 420) };
    },
    result: (r, _a, ctx) => {
      const id = r.select?.[0] as string;
      const f = ctx.doc.get(id)!;
      return { id, label: f.label, n: order(ctx.doc, id), x: f.x, y: f.y, width: f.width, height: f.height, inside: inside(ctx.doc, id) };
    },
  }),
  include: command({
    description:
      'Grow a frame so these nodes are inside it (it never shrinks; margins as in create). Whatever else lies under the bigger frame is inside too: other nodes are listed as `captured` in the result; if it would take in another frame it refuses, unless force is true (move the nodes next to the frame with core.move first). Use it for shapes added after the frame.',
    args: z.strictObject({
      id: ref,
      nodes: z.array(nodeRef('node to put in the frame (id or title)')).check(z.minLength(1)),
      force: z.optional(z.boolean().check(z.meta({ description: 'also take in other frames that lie in the way' }))),
    }),
    example: { id: 'Architecture', nodes: ['Cache'] },
    toCommand: ({ id, nodes, force }, ctx) => {
      const f = needFrame(ctx.doc, id);
      if (nodes.includes(id)) throw new Error('a frame cannot be put in itself');
      const off = nodes.find((n) => !ctx.doc.get(n) || !ctx.doc.isVisible(n));
      if (off) throw new Error(`${quoted(ctx.doc.get(off), off)} is not on the table`);
      const before = new Set(ctx.doc.riders(id).map((n) => n.id));
      if (!force) {
        const grown = includeBox(f, nodes.map((n) => ctx.doc.get(n)!));
        const nodesAfter = ctx.doc.nodes.map((n) => (n.id === id ? { ...n, ...grown } : n));
        const swallowed = ctx.doc.nodes.filter((g) => isFrame(g) && g.id !== id && !nodes.includes(g.id) && !before.has(g.id) && frameAt(g, nodesAfter) === id);
        if (swallowed.length) throw new Error(`that would also take in the frame${swallowed.length > 1 ? 's' : ''} ${swallowed.map((g) => quoted(g, g.id)).join(', ')}. Move the nodes next to ${quoted(f, id)} with core.move first, or pass force: true`);
      }
      // each node must end up in this frame by the real membership rule: one already held by a smaller
      // frame, a board column or a chess board stays there unless the holder itself ends up in this frame
      const grown = includeBox(f, nodes.map((n) => ctx.doc.get(n)!));
      const after = ctx.doc.nodes.map((n) => (n.id === id ? { ...n, ...grown } : n));
      for (const n of nodes) {
        let cur = n;
        let holder: string | undefined;
        for (let i = 0; i < 20; i++) {
          const c = ctx.doc.carrierOf(cur);
          // a frame holding it is judged on the grown layout; a board column or chess board holds it for good
          const next = c && !isFrame(ctx.doc.get(c)) ? c : frameAt(ctx.doc.get(cur)!, after);
          if (next === id) {
            holder = undefined;
            break;
          }
          if (!next) break;
          holder ??= next;
          cur = next;
        }
        if (holder) {
          const up = new Set<string>();
          for (let c = ctx.doc.carrierOf(id); c && up.size < 20; c = ctx.doc.carrierOf(c)) up.add(c);
          const hint = up.has(holder) ? '' : `, or include ${quoted(ctx.doc.get(holder), holder)} instead`;
          throw new Error(`${quoted(ctx.doc.get(n), n)} would stay outside: it is held by ${quoted(ctx.doc.get(holder), holder)}. Move it out first with core.move${hint}`);
        }
      }
      const parent = ctx.doc.carrierOf(id);
      included.set(ctx, { before, ...(parent ? { parent } : {}) });
      return { id, nodes };
    },
    result: (r, a, ctx) => {
      const f = ctx.doc.get(a.id)!;
      const { before, parent } = included.get(ctx) ?? { before: new Set<string>() };
      const captured = ctx.doc.riders(a.id).filter((n) => !before.has(n.id) && !a.nodes.includes(n.id)).map((n) => ({ id: n.id, title: titleOf(n) || n.type }));
      return { id: a.id, width: f.width, height: f.height, inside: inside(ctx.doc, a.id), ...(captured.length ? { captured } : {}), ...(parent && ctx.doc.carrierOf(a.id) !== parent ? { leftParent: titleOf(ctx.doc.get(parent)!) } : {}), changed: changed(r) };
    },
  }),
  rename: command({
    description: "Change a frame's (or portal's) title.",
    args: z.strictObject({ id: ref, label: z.string().check(z.minLength(1)) }),
    example: { id: 'Frame 1', label: 'Architecture' },
    toCommand: (a, ctx) => {
      needFrame(ctx.doc, a.id, true);
      if (!cleanLabel(a.label)) throw new Error('the label is empty');
      return a;
    },
    result: (r, a, ctx) => ({ id: a.id, label: ctx.doc.get(a.id)!.label, changed: changed(r) }),
  }),
  resize: command({
    description: "Set a frame's size (minimum 160x100); its top-left stays. Nodes are not moved, so a smaller frame can drop some out; a bigger one can take more in.",
    args: z.strictObject({ id: ref, width: z.number(), height: z.number() }),
    example: { id: 'Architecture', width: 1000, height: 700 },
    toCommand: (a, ctx) => (needFrame(ctx.doc, a.id, true), a),
    result: (r, a, ctx) => ({ id: a.id, width: ctx.doc.get(a.id)!.width, height: ctx.doc.get(a.id)!.height, changed: changed(r) }),
  }),
  reorder: command({
    description: "Move a frame to place `to` in the presentation order (1 = first, numbered as the frames.outline view shows). Returns its new place.",
    args: z.strictObject({ id: ref, to: z.int().check(z.minimum(1)) }),
    example: { id: 'Architecture', to: 1 },
    toCommand: ({ id, to }, ctx) => (needFrame(ctx.doc, id), { id, to: to - 1 }),
    result: (r, a, ctx) => ({ id: a.id, n: order(ctx.doc, a.id), changed: changed(r) }),
  }),
  skip: command({
    description: 'Leave a frame out of the presentation (skip true, the default) or put it back (skip false). It stays in the order and on the canvas. Doing it twice changes nothing.',
    args: z.strictObject({ id: ref, skip: z.optional(z.boolean()) }),
    example: { id: 'Notes', skip: true },
    toCommand: ({ id, skip }, ctx) => (needFrame(ctx.doc, id), { id, skip: skip ?? true }),
    result: (r, a) => ({ id: a.id, skipped: a.skip ?? true, changed: changed(r) }),
  }),
  unframe: command({
    description: 'Remove a frame and keep what is in it. (core.delete removes the frame with its contents.)',
    args: z.strictObject({ id: ref }),
    example: { id: 'Architecture' },
    toCommand: (a, ctx) => (needFrame(ctx.doc, a.id), a),
    result: (r) => ({ changed: changed(r) }),
  }),
  pin: command({
    description: "Write the current presentation order down, so moving a frame doesn't reshuffle it. The UI does this itself; agents rarely need it.",
    args: z.strictObject({}),
    example: {},
    result: (r) => ({ changed: changed(r) }),
  }),
  sink: command({
    description: 'Put frames back under every other node (the UI does this after each press so frames stay backdrops). Agents rarely need it.',
    args: z.strictObject({}),
    example: {},
    result: (r) => ({ changed: changed(r) }),
  }),
  createPortal: command({
    description: 'Experimental: add a portal, a window onto another room. Browsers show portals only with ?portals=1. Without x/y it goes right of everything (x/y is its center).',
    args: z.strictObject({ room: roomId, label: z.optional(z.string()), x: z.optional(z.number()), y: z.optional(z.number()), width: z.optional(z.number()), height: z.optional(z.number()) }),
    example: { room: 'sprint-12', label: 'Sprint 12' },
    toCommand: (a, ctx) => {
      if ((a.x === undefined) !== (a.y === undefined)) throw new Error('give both x and y (center), or neither');
      if (a.x !== undefined) return a;
      const w = Math.max(MIN_W, a.width ?? 560);
      const h = Math.max(MIN_H, a.height ?? 440);
      const p = freeSpot(ctx.doc, w, h);
      return { ...a, x: p.x + w / 2, y: p.y + h / 2 };
    },
  }),
  retarget: command({
    description: 'Experimental: point a portal at another room.',
    args: z.strictObject({ id: nodeRef('portal (id or title)'), room: roomId }),
    example: { id: 'Sprint 12', room: 'sprint-13' },
    toCommand: (a, ctx) => (needPortal(ctx.doc, a.id), a),
    result: (r, a) => ({ id: a.id, room: a.room, changed: changed(r) }),
  }),
};

/** The data side (commands, rider rule). No DOM; used by the browser, the bridge and tests. */
export function registerFramesLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`frames.${name}`, cmd as Command, specs[name]);
  store.registerView(
    'frames.outline',
    view({
      description: 'The frames as text, in presentation order: number, title, id, slide or skipped, box, nesting, and what is inside each; nodes in no frame.',
      args: z.strictObject({}),
      example: {},
      read: (doc) => framesOf(doc),
      text: (v) => framesText(v as ReturnType<typeof framesOf>),
    }),
  );
  // Registered after other plugins' rider rules (a piece rides its board, the board rides the frame).
  store.addRiderRule((n, get, all) => {
    if (!frozen) return frameAt(n, all);
    const f = frozen.get(n.id);
    return f && get(f) ? f : undefined;
  });
}

export const logic: PluginLogic = {
  id: 'frames',
  title: 'Frames',
  summary: 'Frames group parts of a big canvas into named areas, in an order you can present as slides.',
  guide: GUIDE,
  register: registerFramesLogic,
};
