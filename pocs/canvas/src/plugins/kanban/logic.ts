import type { CanvasNode, Command, DocFilter, Store } from '../../core';
import { commands, duplicateRule } from './commands';
import { layoutRule, parentRule } from './layout';
import { FIELD, isBoard, isTask } from './model';

/**
 * Export: sync bookkeeping (hashes, host tab) stays out of .canvas files. A reopened file's tasks
 * then have no base: the host pulls before it writes anything (the files win).
 */
export const shapeExport: DocFilter = (doc) => ({
  ...doc,
  nodes: doc.nodes.map((n): CanvasNode => {
    if (isTask(n)) {
      const { base: _b, ...f } = n[FIELD];
      return { ...n, [FIELD]: f };
    }
    if (isBoard(n)) {
      const { ownerTab: _t, syncedAt: _s, error: _e, ...f } = n[FIELD];
      return { ...n, [FIELD]: f };
    }
    return n;
  }),
});

/** The data side of the plugin (no DOM): commands, containment, layout. Used by tests too. */
export function registerKanbanLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`kanban.${name}`, cmd as Command);
  store.addParentRule(parentRule);
  store.addLayout(layoutRule);
  store.duplicateRules.push(duplicateRule);
  store.exportFilters.push(shapeExport);
}
