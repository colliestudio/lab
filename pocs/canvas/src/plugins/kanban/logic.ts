import type { CanvasNode, Command, DocFilter, Store } from '../../core';
import type { PluginLogic } from '../logic';
import { GUIDE, specs, views } from './agent';
import { commands, duplicateRule } from './commands';
import { layoutRule, parentRule } from './layout';
import { FIELD, isBoard, isTask } from './model';

/**
 * Export (the .canvas file): only what makes a card on a board that is not live. The sync's
 * bookkeeping (hashes, status, pending comments) and the sections stay out; the serve refills them
 * from the folder on load. The file never holds a path: a task's `file` is its id.
 */
export const shapeExport: DocFilter = (doc) => ({
  ...doc,
  nodes: doc.nodes.map((n): CanvasNode => {
    if (isTask(n)) {
      const { base: _b, description: _d, plan: _p, notes: _n, ac: _a, comments: _c, note: _note, ...f } = n[FIELD];
      return { ...n, [FIELD]: Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith('outbox:'))) as typeof f };
    }
    if (isBoard(n)) {
      const { state: _s, caps: _caps, nextId: _next, ...f } = n[FIELD];
      return { ...n, [FIELD]: f };
    }
    return n;
  }),
});

/** The data side of the plugin (no DOM): commands, containment, layout, the agent surface. Used by the browser, the bridge, the serve and tests. */
export function registerKanbanLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`kanban.${name}`, cmd as Command, specs[name]);
  for (const [name, v] of Object.entries(views)) store.registerView(name, v);
  store.addParentRule(parentRule);
  store.addLayout(layoutRule);
  store.duplicateRules.push(duplicateRule);
  store.exportFilters.push(shapeExport);
  store.deleteGuards.push((n) => (isTask(n) ? 'kept a task card: tasks are removed in the files (the backlog CLI, archive), the card follows' : undefined));
  store.unlisted.push((n) => isTask(n)); // the task nodes are many: the kanban.board view lists them
}

export const logic: PluginLogic = {
  id: 'kanban',
  title: 'Kanban',
  summary: 'A live kanban board of a Backlog.md folder the serve hosts: move, create, edit and comment on tasks, and read the board as text.',
  guide: GUIDE,
  register: registerKanbanLogic,
};
