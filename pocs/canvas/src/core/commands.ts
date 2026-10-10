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

/** Changes that put `nodes` on top (keeping their relative order), or none if they already are. */
export function toFront(doc: DocView, all: CanvasNode[]): Change[] {
  // contained nodes stack with their container (their z comes from its layout)
  const nodes = all.filter((n) => !doc.parentOf(n.id));
  if (!nodes.length) return [];
  const ids = new Set(nodes.map((n) => n.id));
  const vis = doc.visible.filter((n) => !doc.parentOf(n.id));
  const top = vis.slice(vis.length - nodes.length);
  if (top.length === nodes.length && top.every((n) => ids.has(n.id))) return [];
  const sorted = nodes.slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const base = Math.floor(doc.topZ);
  return sorted.map((n, i) => set(n.id, 'z', base + 1 + i));
}

export function registerCoreCommands(store: Store) {
  store.register('core.move', (doc, a: { ids: string[]; dx: number; dy: number }) => {
    if (!isNum(a?.dx) || !isNum(a?.dy)) return [];
    return pick(doc, a.ids)
      .filter((n) => !doc.parentOf(n.id)) // contained nodes go where their container's layout puts them
      .flatMap((n) => [set(n.id, 'x', Math.round(n.x + a.dx)), set(n.id, 'y', Math.round(n.y + a.dy))]);
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
  store.register('core.add', (doc, a: { nodes: CanvasNode[] }) => {
    if (!Array.isArray(a?.nodes)) return [];
    return a.nodes
      .filter((n) => n && typeof n.id === 'string' && [n.x, n.y, n.width, n.height].every(isNum))
      .map((n, i): Change => ({ op: 'add', node: { ...n, z: n.z ?? doc.topZ + 1 + i } }));
  });
}
