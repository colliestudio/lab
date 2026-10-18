import * as Y from 'yjs';
import { Store, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerKanbanLogic } from './logic';
import { FIELD, type BoardField, type TaskField } from './model';

// Helpers for the kanban tests: a store with the plugin's logic, a board and tasks put straight into the doc.

export function ctx(prefix = 'id'): CommandCtx {
  let n = 0;
  return { newId: () => `${prefix}${++n}`, random: () => 0.5 };
}

export function kanbanStore(opts: { ydoc?: Y.Doc; prefix?: string; actor?: { id: string; name: string; color: string } } = {}) {
  const s = new Store({ ctx: ctx(opts.prefix), ydoc: opts.ydoc });
  registerCoreCommands(s);
  registerKanbanLogic(s);
  if (opts.actor) s.actor = () => opts.actor!;
  return s;
}

export const BOARD: BoardField = { kind: 'board', source: 'demo', name: 'demo', columns: ['To Do', 'In Progress', 'Done'], defaultColumn: 'To Do', doneColumn: 'Done', labels: ['canvas', 'ui'], state: { live: true } };

export function addBoard(s: Store, over: Partial<BoardField> = {}, id = 'b1') {
  s.apply([{ op: 'add', node: { id, type: 'group', label: 'demo', x: 0, y: 0, width: 800, height: 400, z: 1, [FIELD]: { ...BOARD, ...over } } }]);
  return id;
}

let counter = 0;
export function addTask(s: Store, board: string, over: Partial<TaskField> & { title: string }, id?: string) {
  const n = ++counter;
  const nid = id ?? `t${n}`;
  const f: TaskField = { kind: 'task', board, taskId: `TASK-${n}`, status: 'To Do', labels: [], assignee: [], description: '', plan: '', notes: '', ac: [], comments: [], ...over };
  s.apply([{ op: 'add', node: { id: nid, type: 'file', file: f.taskId ?? '', x: 0, y: 0, width: 232, height: 74, z: 2, [FIELD]: f } }]);
  return nid;
}

export const resetCounter = () => (counter = 0);
export const taskField = (s: Store, id: string) => s.doc.get(id)![FIELD] as unknown as TaskField;
export const day = 86_400_000;
export const NOW = Date.UTC(2026, 9, 16, 12, 0);
export const stampDaysAgo = (d: number, now = NOW) => {
  const t = new Date(now - d * day);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
};
