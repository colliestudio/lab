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
 * Riders come along, just above their carrier (a board stays under its pieces).
 */
export function toFront(doc: DocView, nodes: CanvasNode[]): Change[] {
  if (!nodes.length) return [];
  const sorted = withRiders(doc, nodes.slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0)));
  const vis = doc.visible;
  const top = vis.slice(vis.length - sorted.length);
  if (top.length === sorted.length && top.every((n, i) => n.id === sorted[i].id)) return [];
  return sorted.map((n, i) => set(n.id, 'z', doc.topZ + 1 + i));
}

export function registerCoreCommands(store: Store) {
  store.register('core.move', (doc, a: { ids: string[]; dx: number; dy: number }) => {
    if (!isNum(a?.dx) || !isNum(a?.dy)) return [];
    // riders (a board's pieces) move with their carrier
    return withRiders(doc, pick(doc, a.ids)).flatMap((n) => [set(n.id, 'x', Math.round(n.x + a.dx)), set(n.id, 'y', Math.round(n.y + a.dy))]);
  });
  store.register('core.front', (doc, a: { ids: string[] }) => toFront(doc, pick(doc, a?.ids)));
  /** Deletes nodes and everything they contain. */
  store.register('core.delete', (doc, a: { ids: string[] }) => {
    const out = new Set<string>();
    const walk = (id: string) => {
      if (out.has(id)) return;
      out.add(id);
      for (const c of doc.children(id)) walk(c.id);
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
    for (const n of pick(doc, a?.ids)) {
      if (doc.parentOf(n.id)) continue;
      let copy: CanvasNode | null | undefined;
      for (const rule of store.duplicateRules) if ((copy = rule(n, doc)) !== undefined) break;
      if (copy === null) continue;
      const id = ctx.newId();
      ids.push(id);
      changes.push({ op: 'add', node: { ...structuredClone(copy ?? n), id, x: Math.round(n.x + dx), y: Math.round(n.y + dy), z: ++z } });
    }
    return { changes, select: ids.length ? ids : undefined };
  });
  store.register('core.add', (doc, a: { nodes: CanvasNode[] }) => {
    if (!Array.isArray(a?.nodes)) return [];
    return a.nodes
      .filter((n) => n && typeof n.id === 'string' && [n.x, n.y, n.width, n.height].every(isNum))
      .map((n, i): Change => ({ op: 'add', node: { ...n, z: n.z ?? doc.topZ + 1 + i } }));
  });
}
