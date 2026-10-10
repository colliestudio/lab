import type { CanvasNode, Change } from './doc';
import type { Store } from './store';

// Generic commands every object gets.
export function registerCoreCommands(store: Store) {
  store.register('core.move', (doc, a: { ids: string[]; dx: number; dy: number }) => {
    const ids = new Set(a.ids);
    return doc.nodes.filter((n) => ids.has(n.id)).map((n): Change => ({ op: 'put', node: { ...n, x: n.x + a.dx, y: n.y + a.dy } }));
  });
  store.register('core.front', (_doc, a: { ids: string[] }) => [{ op: 'front', ids: a.ids }]);
  store.register('core.delete', (_doc, a: { ids: string[] }) => a.ids.map((id): Change => ({ op: 'del', id })));
  store.register('core.put', (_doc, a: { nodes: CanvasNode[] }) => a.nodes.map((node): Change => ({ op: 'put', node })));
}
