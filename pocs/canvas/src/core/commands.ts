import { describeDiff } from './canonical';
import { set, type CanvasNode, type Change, type DocView } from './doc';
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
    return [...out].map((id): Change => ({ op: 'del', id }));
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
      changes.push({ op: 'add', node: { ...structuredClone(copy ?? n), id, x: Math.round(n.x + dx), y: Math.round(n.y + dy), z: ++z } });
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
  store.register('core.add', (doc, a: { nodes: CanvasNode[] }) => {
    if (!Array.isArray(a?.nodes)) return [];
    return a.nodes
      .filter((n) => n && typeof n.id === 'string' && [n.x, n.y, n.width, n.height].every(isNum))
      .map((n, i): Change => ({ op: 'add', node: { ...n, z: n.z ?? doc.topZ + 1 + i } }));
  });
  /**
   * Apply field-level changes made outside the commands (the JSON panel's edit): one undo step, logged
   * with a line that carries counts only. Any peer or bridge agent can send this, so the changes are
   * checked for shape (a malformed one would break every peer's render) and the log line is made here.
   */
  store.register('core.patch', (_doc, a: { changes: Change[] }) => {
    if (!Array.isArray(a?.changes)) return [];
    const bad = a.changes.findIndex((c) => !validChange(c));
    if (bad >= 0) throw new Error(`change #${bad} is not a valid change`);
    if (!a.changes.length) return [];
    const ids = (op: Change['op']) => [...new Set(a.changes.flatMap((c) => (c.op === op ? [c.op === 'add' ? c.node.id : (c as { id: string }).id] : [])))];
    const added = ids('add');
    const changed = [...new Set(a.changes.flatMap((c) => (c.op === 'set' && c.key !== 'z' && !added.includes(c.id) ? [c.id] : [])))];
    const summary = { added, changed, removed: ids('del'), edges: a.changes.filter((c) => c.op === 'edge' || c.op === 'unedge').length };
    const targets = [...added, ...changed].slice(0, 20);
    return { changes: a.changes, events: [{ type: 'core.patch', text: `edited the JSON: ${describeDiff(summary)}`, targets, cue: 'pulse' }] };
  });
}

const GEOMETRY = new Set(['x', 'y', 'width', 'height', 'z']);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** A change a renderer can live with: a node keeps an id, a type and numeric geometry. */
function validChange(c: unknown): c is Change {
  if (!isObj(c)) return false;
  switch (c.op) {
    case 'add': {
      const n = c.node;
      return isObj(n) && isStr(n.id) && isStr(n.type) && [n.x, n.y, n.width, n.height].every(isNum) && (n.z === undefined || isNum(n.z));
    }
    case 'set':
      if (!isStr(c.id) || !isStr(c.key) || c.key === 'id') return false;
      if (GEOMETRY.has(c.key)) return isNum(c.value);
      return c.key !== 'type' || isStr(c.value);
    case 'del':
    case 'unedge':
      return isStr(c.id);
    case 'edge':
      return isObj(c.edge) && isStr(c.edge.id) && isStr(c.edge.fromNode) && isStr(c.edge.toNode);
    default:
      return false;
  }
}
