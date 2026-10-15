import { set, type CanvasEdge, type CanvasNode, type Change, type DocView } from './doc';
import { isSide, type EdgeStyle } from './edges';
import type { Store } from './store';

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

export function registerCoreCommands(store: Store) {
  store.register('core.move', (doc, a: { ids: string[]; dx: number; dy: number }) => {
    if (!isNum(a?.dx) || !isNum(a?.dy)) return [];
    // contained nodes go where their container's layout puts them; riders (a board's pieces) move with their carrier
    const nodes = pick(doc, a.ids).filter((n) => !doc.parentOf(n.id));
    return withRiders(doc, nodes).flatMap((n) => [set(n.id, 'x', Math.round(n.x + a.dx)), set(n.id, 'y', Math.round(n.y + a.dy))]);
  });
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
    for (const n of pick(doc, a?.ids)) walk(n.id);
    // edge ids (a picked arrow) go too
    const edges = isIds(a?.ids) ? a.ids.filter((id) => doc.edge(id)) : [];
    return [...[...out].map((id): Change => ({ op: 'del', id })), ...edges.map((id): Change => ({ op: 'unedge', id }))];
  });
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
  });
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
    if (doc.edge(id)) return [];
    const edge = applyEdgeArgs({ id, fromNode: a.from, toNode: a.to }, a);
    if (!edge) return [];
    return { changes: [{ op: 'edge', edge }], select: [id] };
  });
  /** Restyle, relabel or re-aim an arrow. `null` or "" clears a field. */
  store.register('core.edge', (doc, a: EdgeArgs) => {
    const e = typeof a?.id === 'string' ? doc.edge(a.id) : undefined;
    if (!e) return [];
    const edge = applyEdgeArgs(structuredClone(e), a);
    return edge ? [{ op: 'edge', edge } as Change] : [];
  });
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

/** Fold the fields of `a` into `edge`; undefined = leave, null = clear. Undefined result: a bad value. */
function applyEdgeArgs(edge: CanvasEdge, a: EdgeArgs): CanvasEdge | undefined {
  const put = (key: keyof CanvasEdge & string, v: unknown, ok: (v: unknown) => boolean = () => true) => {
    if (v === undefined) return true;
    if (v === null || v === '') delete edge[key];
    else if (ok(v)) (edge as unknown as Record<string, unknown>)[key] = v;
    else return false;
    return true;
  };
  const end = (v: unknown) => v === 'none' || v === 'arrow';
  const str = (v: unknown) => typeof v === 'string';
  if (
    !put('label', a.label, str) ||
    !put('color', a.color, str) ||
    !put('fromEnd', a.fromEnd, end) ||
    !put('toEnd', a.toEnd, end) ||
    !put('fromSide', a.fromSide, isSide) ||
    !put('toSide', a.toSide, isSide)
  )
    return undefined;
  const style: EdgeStyle = { ...(edge['x-edge'] as EdgeStyle | undefined) };
  if (a.dashed !== undefined) a.dashed ? (style.dashed = true) : delete style.dashed;
  if (a.curve !== undefined) a.curve ? (style.curve = true) : delete style.curve;
  edge['x-edge'] = style;
  return edge;
}
