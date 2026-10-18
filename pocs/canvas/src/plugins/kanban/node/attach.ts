import type { ServeBoard } from '../../../core/serveExtra';
import { set } from '../../../core/doc';
import { FIELD, board, isBoard } from '../model';
import { KanbanSync } from '../sync';
import type { SourceRegistry } from './registry';

/**
 * Runs the sync for every kanban node of a loaded board whose source name this serve has, and follows
 * nodes that come and go (a viewer adds one, undo removes it, an outside edit of the board file).
 * A node whose name the serve does not have shows that on the node. Returns the stop function.
 */
export function attachKanban(b: ServeBoard, registry: SourceRegistry, opts: { pushDelayMs?: number } = {}): () => void {
  const syncs = new Map<string, { sync: KanbanSync; source: string }>();
  let stopped = false;

  const reconcile = () => {
    if (stopped) return;
    const doc = b.doc();
    const nodes = doc.nodes.filter(isBoard);
    const ids = new Set(nodes.map((n) => n.id));
    for (const [id, s] of [...syncs]) {
      const n = doc.get(id);
      if (!ids.has(id) || (isBoard(n) && board(n).source !== s.source)) {
        s.sync.stop();
        syncs.delete(id);
      }
    }
    for (const n of nodes) {
      if (syncs.has(n.id)) continue;
      const name = board(n).source;
      const src = registry.get(name);
      if (!src) {
        const msg = `this serve has no kanban folder named "${name}"${registry.names().length ? ` (it has: ${registry.names().join(', ')})` : ' (start it with --kanban name=path)'}`;
        if (board(n).state?.error !== msg) b.apply([set(n.id, `${FIELD}.state`, { error: msg })], []);
        continue;
      }
      const sync = new KanbanSync(b, n.id, src, { pushDelayMs: opts.pushDelayMs });
      syncs.set(n.id, { sync, source: name });
      sync.start();
    }
  };

  const off = b.onDocChange(reconcile);
  reconcile();
  return () => {
    stopped = true;
    off();
    for (const s of syncs.values()) s.sync.stop();
    syncs.clear();
  };
}
