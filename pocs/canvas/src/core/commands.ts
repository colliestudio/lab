import * as z from 'zod/mini';
import { command, nodeRef, type CommandSpec } from './agent';
import { set, type CanvasEdge, type CanvasNode, type Change, type DocView } from './doc';
import { isSide, type EdgeStyle } from './edges';
import type { Command, Store } from './store';

// Generic commands every object gets. Args are validated; bad args are a no-op.

export const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Known nodes for `ids`, in z order. */
export function pick(doc: DocView, ids: unknown): CanvasNode[] {
  if (!isIds(ids)) return [];
  const want = new Set(ids);
  return doc.nodes.filter((n) => want.has(n.id));
}

/** `nodes` plus everything riding on them (transitively), each carrier directly followed by its riders. */
export function withRiders(doc: DocView, nodes: CanvasNode[]): CanvasNode[] {
  const out: CanvasNode[] = [];
  const seen = new Set<string>();
  const ids = new Set(nodes.map((n) => n.id));
  const add = (n: CanvasNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
    for (const r of doc.riders(n.id)) add(r);
  };
  // a rider that is itself in `nodes` is placed after its carrier, not on its own
  for (const n of nodes) {
    const c = doc.carrierOf(n.id);
    if (!c || !ids.has(c)) add(n);
  }
  for (const n of nodes) add(n);
  return out;
}

/**
 * Changes that put `nodes` on top (keeping their relative order), or none if they already are.
 * Riders come along, just above their carrier (a board stays under its pieces). Contained nodes
 * stack with their container (their z comes from its layout).
 */
export function toFront(doc: DocView, all: CanvasNode[]): Change[] {
  const nodes = all.filter((n) => !doc.parentOf(n.id));
  if (!nodes.length) return [];
  const sorted = withRiders(doc, nodes.slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0)));
  const vis = doc.visible.filter((n) => !doc.parentOf(n.id));
  const top = vis.slice(vis.length - sorted.length);
  if (top.length === sorted.length && top.every((n, i) => n.id === sorted[i].id)) return [];
  const base = Math.floor(doc.topZ);
  return sorted.map((n, i) => set(n.id, 'z', base + 1 + i));
}

/**
 * Bring pressed objects to the top. A press is not an edit: no undo step of its own, and the redo
 * stack stays (a click between Undo and Redo must not eat the redo).
 */
export function raise(store: Store, ids: string[]) {
  return store.dispatch('core.front', { ids }, { undoable: false });
}

// Agent side: how the generic commands describe themselves (see agent.ts).
const side = z.enum(['top', 'right', 'bottom', 'left']);
const end = z.enum(['none', 'arrow']);
const arrowLook = {
  label: z.nullable(z.optional(z.string().check(z.meta({ description: 'text on the arrow; null/"" removes it' })))),
  from_side: z.nullable(z.optional(side.check(z.meta({ description: 'side of the first shape the arrow leaves; default: the side facing the other shape' })))),
  to_side: z.nullable(z.optional(side)),
  start: z.optional(end.check(z.meta({ description: 'arrowhead at the start (default none)' }))),
  end: z.optional(end.check(z.meta({ description: 'arrowhead at the end (default arrow)' }))),
  dashed: z.optional(z.boolean()),
  curve: z.optional(z.boolean().check(z.meta({ description: 'curved instead of straight' }))),
  color: z.nullable(z.optional(z.string().check(z.meta({ description: '#hex or a JSON Canvas preset 1-6; null clears' })))),
};
/** Agent arrow args to core.connect / core.edge args. */
const arrowArgs = (a: { label?: string | null; from_side?: string | null; to_side?: string | null; start?: string; end?: string; dashed?: boolean; curve?: boolean; color?: string | null }) => ({
  label: a.label,
  fromSide: a.from_side,
  toSide: a.to_side,
  fromEnd: a.start,
  toEnd: a.end,
  dashed: a.dashed,
  curve: a.curve,
  color: a.color,
});
const changed = (r: { changes: unknown[] }) => ({ changed: r.changes.length });

export const coreSpecs: Record<string, CommandSpec> = {
  move: command({
    description: 'Move nodes by (dx, dy); what rides on them (a board\'s pieces) goes along.',
    args: z.strictObject({ ids: z.array(nodeRef()), dx: z.number(), dy: z.number() }),
    example: { ids: ['Deck'], dx: 100, dy: 0 },
    result: changed,
  }),
  duplicate: command({
    description: 'Copy nodes (and the arrows between them), offset by (dx, dy) (default 24, 24). Returns the first copy\'s id.',
    args: z.strictObject({ ids: z.array(nodeRef()), dx: z.optional(z.number()), dy: z.optional(z.number()) }),
    example: { ids: ['Deck'] },
  }),
  delete: command({
    description: 'Remove nodes or arrows by id; a node takes what it contains, what rides on it and its arrows with it.',
    args: z.strictObject({ ids: z.array(z.string()) }),
    example: { ids: ['a1b2c3'] },
    result: changed,
  }),
  unedge: command({
    description: 'Remove arrows by id (shapes stay). Nodes are removed with their own delete or remove command.',
    args: z.strictObject({ arrows: z.array(z.string()) }),
    example: { arrows: ['e1f2a3'] },
    tool: 'canvas_remove_arrow',
    cli: [{ verb: 'arrow-rm', rest: 'arrows' }],
    toCommand: (a) => ({ ids: a.arrows }),
    result: changed,
  }),
  connect: command({
    description: 'Draw an arrow from one shape to another, optionally labelled and styled. Returns the arrow id (for canvas_edit_arrow / canvas_remove_arrow; canvas_list shows each node’s outgoing arrows).',
    args: z.strictObject({ from: nodeRef(), to: nodeRef(), ...arrowLook }),
    example: { from: 'Order placed', to: 'Payment taken', label: 'then', dashed: true },
    tool: 'canvas_arrow',
    cli: [{ verb: 'arrow', pos: ['from', 'to'] }],
    toCommand: (a) => ({ from: a.from, to: a.to, ...arrowArgs(a) }),
  }),
  edge: command({
    description: 'Change an arrow: label, sides, arrowheads, dashed, curve, color.',
    args: z.strictObject({ arrow: z.string().check(z.meta({ description: 'arrow id' })), ...arrowLook }),
    example: { arrow: 'e1f2a3', label: 'no' },
    tool: 'canvas_edit_arrow',
    cli: [{ verb: 'arrow-edit', pos: ['arrow'] }],
    toCommand: (a) => ({ id: a.arrow, ...arrowArgs(a) }),
    result: (r, a) => ({ id: a.arrow, changed: r.changes.length }),
  }),
};

/** Log entries for the nodes a delete-guard kept (those not deleted with their container anyway). */
export function keptEvents(doc: DocView, ids: unknown, store: Store, deleted: ReadonlySet<string>) {
  const texts = pick(doc, ids as string[])
    .filter((n) => !deleted.has(n.id))
    .map((n) => store.deleteGuards.map((g) => g(n, doc)).find(Boolean))
    .filter((t): t is string => !!t);
  return [...new Set(texts)].map((text) => ({ type: 'core.kept', text }));
}

/** `cmd` (a command that deletes the nodes in `args.ids`) with the delete guards applied: guarded nodes stay, and the log says so. */
export function guardedDelete<A extends { ids: string[] }>(store: Store, cmd: Command<A>): Command<A> {
  return (doc, a, ctx) => {
    const free = pick(doc, a?.ids ?? []).filter((n) => !store.deleteGuards.some((g) => g(n, doc)));
    const r = cmd(doc, { ...a, ids: free.map((n) => n.id) }, ctx);
    const res = Array.isArray(r) ? { changes: r } : r;
    const events = keptEvents(doc, a?.ids, store, new Set(res.changes.flatMap((c) => (c.op === 'del' ? [c.id] : []))));
    return events.length ? { ...res, events: [...(Array.isArray(res.events) ? res.events : []), ...events] } : res;
  };
}

export function registerCoreCommands(store: Store) {
  const spec = (name: string) => coreSpecs[name];
  store.register('core.move', (doc, a: { ids: string[]; dx: number; dy: number }) => {
    if (!isNum(a?.dx) || !isNum(a?.dy)) return [];
    // contained nodes go where their container's layout puts them; riders (a board's pieces) move with their carrier
    const nodes = pick(doc, a.ids).filter((n) => !doc.parentOf(n.id));
    return withRiders(doc, nodes).flatMap((n) => [set(n.id, 'x', Math.round(n.x + a.dx)), set(n.id, 'y', Math.round(n.y + a.dy))]);
  }, spec('move'));
  store.register('core.front', (doc, a: { ids: string[] }) => toFront(doc, pick(doc, a?.ids)));
  /** Deletes nodes, everything they contain and everything riding on them (a board's pieces). */
  store.register('core.delete', (doc, a: { ids: string[] }) => {
    const out = new Set<string>();
    const walk = (id: string) => {
      if (out.has(id)) return;
      out.add(id);
      for (const c of doc.children(id)) walk(c.id);
      for (const r of doc.riders(id)) walk(r.id);
    };
    const kept: string[] = [];
    for (const n of pick(doc, a?.ids)) {
      const why = store.deleteGuards.map((g) => g(n, doc)).find(Boolean);
      if (why) kept.push(why);
      else walk(n.id);
    }
    // a guarded node that goes with its container (a board deleted with its cards) was not kept
    const events = keptEvents(doc, a?.ids, store, out);
    // edge ids (a picked arrow) go too
    const edges = isIds(a?.ids) ? a.ids.filter((id) => doc.edge(id)) : [];
    const changes = [...[...out].map((id): Change => ({ op: 'del', id })), ...edges.map((id): Change => ({ op: 'unedge', id }))];
    void kept;
    return events.length ? { changes, events } : changes;
  }, spec('delete'));
  /** Deletes arrows only (ids that are not arrows are refused). */
  store.register('core.unedge', (doc, a: { ids: string[] }) => {
    const ids = isIds(a?.ids) ? a.ids : [];
    const bad = ids.filter((id) => !doc.edge(id));
    if (bad.length) throw new Error(`no arrow ${bad.join(', ')}`);
    return ids.map((id): Change => ({ op: 'unedge', id }));
  }, spec('unedge'));
  /** Copy nodes offset by (dx, dy) (default 24, 24) on top; plugins shape or refuse copies. Selects the copies. */
  store.register('core.duplicate', (doc, a: { ids: string[]; dx?: number; dy?: number }, ctx) => {
    const dx = isNum(a?.dx) ? a.dx : 24;
    const dy = isNum(a?.dy) ? a.dy : 24;
    const changes: Change[] = [];
    const ids: string[] = [];
    let z = doc.topZ;
    const nodes = pick(doc, a?.ids).filter((n) => !doc.parentOf(n.id));
    const copying = new Set(nodes.map((n) => n.id));
    const copyIds = new Map<string, string>();
    const made = new Map<string, string>(); // original → copy, for the nodes actually copied
    const copyOf = (id: string) => {
      if (!copying.has(id)) return undefined;
      let c = copyIds.get(id);
      if (!c) copyIds.set(id, (c = ctx.newId()));
      return c;
    };
    for (const n of nodes) {
      let copy: CanvasNode | null | undefined;
      for (const rule of store.duplicateRules) if ((copy = rule(n, doc, copyOf)) !== undefined) break;
      if (copy === null) continue;
      const id = copyOf(n.id)!;
      ids.push(id);
      made.set(n.id, id);
      changes.push({ op: 'add', node: { ...structuredClone(copy ?? n), id, x: Math.round(n.x + dx), y: Math.round(n.y + dy), z: ++z } });
    }
    // arrows between copied nodes are copied too
    for (const e of doc.edges) {
      const f = made.get(e.fromNode);
      const t = made.get(e.toNode);
      if (f && t) changes.push({ op: 'edge', edge: { ...structuredClone(e), id: ctx.newId(), fromNode: f, toNode: t } });
    }
    return { changes, select: ids.length ? ids : undefined };
  }, spec('duplicate'));
  /** Every plugin puts its objects back in their starting state (kits stay; what they hold resets). A reset's `untracked` part stays when it is undone. */
  store.register('core.reset', (doc, _a, ctx) => {
    const changes: Change[] = [];
    const untracked: Change[] = [];
    for (const cmd of store.resets) {
      const r = cmd(doc, {}, ctx);
      if (Array.isArray(r)) changes.push(...r);
      else {
        changes.push(...r.changes);
        untracked.push(...(r.untracked ?? []));
      }
    }
    return { changes, untracked, events: changes.length || untracked.length ? [{ type: 'core.reset', text: 'reset the table' }] : [] };
  });
  /** Put copies of `nodes` (and the arrows between them) on the table, offset by (dx, dy), on top. Ids are made new. */
  store.register('core.paste', (doc, a: { nodes: CanvasNode[]; edges?: CanvasEdge[]; dx?: number; dy?: number }, ctx) => {
    if (!Array.isArray(a?.nodes)) return [];
    const dx = isNum(a.dx) ? a.dx : 24;
    const dy = isNum(a.dy) ? a.dy : 24;
    const ids = new Map<string, string>();
    const changes: Change[] = [];
    let z = doc.topZ;
    for (const n of a.nodes) {
      if (!n || typeof n.id !== 'string' || typeof n.type !== 'string' || ![n.x, n.y, n.width, n.height].every(isNum)) continue;
      const id = ctx.newId();
      ids.set(n.id, id);
      changes.push({ op: 'add', node: { ...structuredClone(n), id, x: Math.round(n.x + dx), y: Math.round(n.y + dy), z: ++z } });
    }
    for (const e of Array.isArray(a.edges) ? a.edges : []) {
      const f = ids.get(e?.fromNode);
      const t = ids.get(e?.toNode);
      if (f && t) changes.push({ op: 'edge', edge: { ...structuredClone(e), id: ctx.newId(), fromNode: f, toNode: t } });
    }
    return { changes, select: [...ids.values()] };
  });
  /** An arrow between two nodes. `x-edge` marks it as a styled arrow (see edges.ts). */
  store.register('core.connect', (doc, a: ConnectArgs, ctx) => {
    if (!a || typeof a.from !== 'string' || typeof a.to !== 'string' || a.from === a.to) return [];
    if (!doc.isVisible(a.from) || !doc.isVisible(a.to)) return [];
    const id = typeof a.id === 'string' && a.id ? a.id : ctx.newId();
    if (doc.edge(id) || doc.get(id)) return [];
    const fields = edgeFields(a);
    if (!fields) return [];
    const edge: Record<string, unknown> = { id, fromNode: a.from, toNode: a.to, 'x-edge': {} };
    for (const [k, v] of fields) {
      if (v === undefined) continue;
      if (k.startsWith('x-edge.')) (edge['x-edge'] as Record<string, unknown>)[k.slice(7)] = v;
      else edge[k] = v;
    }
    return { changes: [{ op: 'edge', edge: edge as unknown as CanvasEdge }], select: [id] };
  }, spec('connect'));
  /** Restyle, relabel or re-aim an arrow. `null` or "" clears a field. */
  store.register('core.edge', (doc, a: EdgeArgs) => {
    const e = typeof a?.id === 'string' ? doc.edge(a.id) : undefined;
    if (!e) return [];
    const fields = edgeFields(a);
    // per field, so two people changing one arrow (label, color) both keep their change
    return fields ? fields.map(([key, value]): Change => ({ op: 'edgeset', id: e.id, key, value })) : [];
  }, spec('edge'));
  store.register('core.add', (doc, a: { nodes: CanvasNode[] }) => {
    if (!Array.isArray(a?.nodes)) return [];
    return a.nodes
      .filter((n) => n && typeof n.id === 'string' && [n.x, n.y, n.width, n.height].every(isNum))
      .map((n, i): Change => ({ op: 'add', node: { ...n, z: n.z ?? doc.topZ + 1 + i } }));
  });
}

export interface EdgeArgs extends EdgeStyle {
  id?: string;
  label?: string | null;
  color?: string | null;
  fromEnd?: 'none' | 'arrow' | null;
  toEnd?: 'none' | 'arrow' | null;
  fromSide?: string | null;
  toSide?: string | null;
}
export interface ConnectArgs extends EdgeArgs {
  from: string;
  to: string;
}

/**
 * The field writes `a` asks for, as [key, value] (value undefined = clear; dotted keys reach into
 * `x-edge`). Undefined result: a bad value. A style field is only written when asked, so editing a
 * plain edge (board, prototype) never turns it into a styled one.
 */
function edgeFields(a: EdgeArgs): [string, unknown][] | undefined {
  const out: [string, unknown][] = [];
  const put = (key: string, v: unknown, ok: (v: unknown) => boolean) => {
    if (v === undefined) return true;
    if (v === null || v === '') out.push([key, undefined]);
    else if (ok(v)) out.push([key, v]);
    else return false;
    return true;
  };
  const end = (v: unknown) => v === 'none' || v === 'arrow';
  const str = (v: unknown) => typeof v === 'string';
  // JSON Canvas colors: a preset "1".."6" or hex
  const color = (v: unknown) => typeof v === 'string' && /^([1-6]|#[0-9a-f]{3}|#[0-9a-f]{6})$/i.test(v);
  const bool = (v: unknown) => typeof v === 'boolean';
  if (
    !put('label', a.label, str) ||
    !put('color', a.color, color) ||
    !put('fromEnd', a.fromEnd, end) ||
    !put('toEnd', a.toEnd, end) ||
    !put('fromSide', a.fromSide, isSide) ||
    !put('toSide', a.toSide, isSide) ||
    !put('x-edge.dashed', a.dashed === false ? null : a.dashed, bool) ||
    !put('x-edge.curve', a.curve === false ? null : a.curve, bool)
  )
    return undefined;
  return out;
}
