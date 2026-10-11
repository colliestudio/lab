import type { CanvasNode, DocView } from '../../core';
import { FIELDS, hashOf, type FieldName, type TaskFields } from './markdown';

// A kanban board on the canvas is a view of a Backlog.md project. Three kinds of node share the
// `x-kanban` namespace:
//   board: a group node (columns = statuses). Its tasks are contained in it and laid out in columns.
//   task:  one per Backlog.md task, a JSON Canvas `file` node pointing at the task's markdown file.
//          Holds the task's fields (synced through Yjs like any node) and `base`: hashes of what the
//          source (files or the Backlog.md server) said at the last sync. Field != base = a local edit
//          the host still has to write; source != base = an outside edit (agent, CLI, git pull).
//   ref:   a linked reference to a task, placed anywhere on the canvas (same task, second view).
//   web:   (comparison) an iframe of the Backlog.md web UI.

export const FIELD = 'x-kanban';

export type SourceKind = 'files' | 'service';

export interface BoardField {
  kind: 'board';
  name: string;
  statuses: string[];
  labels: string[];
  defaultStatus: string;
  /** Where the data comes from. Unset = not connected yet. */
  source?: SourceKind;
  /** Shown on the board: the folder name or the service URL. */
  sourceLabel?: string;
  /** Who writes to the source: the player and the tab (only that tab talks to files/service). */
  owner?: string;
  ownerName?: string;
  ownerTab?: string;
  /** Columns showing all their cards (else the first COLUMN_LIMIT). */
  expanded?: string[];
  /** Last sync (ms epoch) and its problem, if any. */
  syncedAt?: number;
  error?: string;
}

export interface TaskField extends TaskFields {
  kind: 'task';
  board: string;
  /** Backlog.md id ("TASK-12"); unset until the host created it in the source. */
  taskId?: string;
  /** Path inside the source folder (files) or the server's file path (service). */
  path?: string;
  base?: Partial<Record<FieldName, string>>;
}

export interface RefField {
  kind: 'ref';
  task: string;
}

export interface WebField {
  kind: 'web';
  url: string;
}

export const COL_W = 248;
export const COL_GAP = 12;
export const PAD = 14;
export const HEADER = 50;
export const COL_HEAD = 34;
export const CARD_W = COL_W - 16;
export const CARD_H = 74;
export const CARD_GAP = 8;
export const FOOT = 40;
export const COLUMN_LIMIT = 8;
export const REF_W = 240;
export const REF_H = 92;

const f = (n: CanvasNode | undefined) => (n ? (n[FIELD] as { kind?: string } | undefined) : undefined);
// guards narrow to a node with that field, so a false branch still leaves a plain CanvasNode
export const isBoard = (n: CanvasNode | undefined): n is CanvasNode & { [FIELD]: BoardField } => f(n)?.kind === 'board';
export const isTask = (n: CanvasNode | undefined): n is CanvasNode & { [FIELD]: TaskField } => f(n)?.kind === 'task';
export const isRef = (n: CanvasNode | undefined): n is CanvasNode & { [FIELD]: RefField } => f(n)?.kind === 'ref';
export const isWeb = (n: CanvasNode | undefined): n is CanvasNode & { [FIELD]: WebField } => f(n)?.kind === 'web';
export const board = (n: CanvasNode) => n[FIELD] as BoardField;
export const task = (n: CanvasNode) => n[FIELD] as TaskField;
export const ref = (n: CanvasNode) => n[FIELD] as RefField;
export const web = (n: CanvasNode) => n[FIELD] as WebField;

/** Tasks of a board (contained nodes). */
export const tasksOf = (doc: DocView, boardId: string) => doc.children(boardId).filter(isTask);

/** Columns: the board's statuses, then any status a task uses that the config doesn't list. */
export function columnsOf(doc: DocView, b: CanvasNode): string[] {
  const cols = [...board(b).statuses];
  for (const t of tasksOf(doc, b.id)) if (!cols.includes(task(t).status)) cols.push(task(t).status);
  return cols.length ? cols : ['To Do'];
}

const idNum = (id: string | undefined) =>
  (id ?? '')
    .replace(/^[^-]*-/, '')
    .split('.')
    .map(Number);
/** Board order inside a column: ordinal, then id (1, 2, 10, 10.1), then unsaved new tasks last. */
export function byOrder(a: CanvasNode, b: CanvasNode): number {
  const x = task(a);
  const y = task(b);
  const ox = x.ordinal ?? Infinity;
  const oy = y.ordinal ?? Infinity;
  if (ox !== oy) return ox < oy ? -1 : 1;
  if (!x.taskId || !y.taskId) return x.taskId ? -1 : y.taskId ? 1 : a.id < b.id ? -1 : 1;
  const [p, q] = [idNum(x.taskId), idNum(y.taskId)];
  for (let i = 0; i < Math.max(p.length, q.length); i++) if ((p[i] ?? -1) !== (q[i] ?? -1)) return (p[i] ?? -1) - (q[i] ?? -1);
  return 0;
}

export function column(doc: DocView, boardId: string, status: string): CanvasNode[] {
  return tasksOf(doc, boardId)
    .filter((t) => task(t).status === status)
    .sort(byOrder);
}

/** Fields of a task that differ from what the source had at the last sync (the host must write them). */
export function dirtyFields(t: TaskField): FieldName[] {
  // never synced: a new task (no id) is all to write; a known task (a reopened .canvas) waits for a pull
  if (!t.base) return t.taskId ? [] : [...FIELDS];
  return FIELDS.filter((k) => t.base![k] !== hashOf(t[k]));
}

export function fieldsOf(t: TaskField): TaskFields {
  return { title: t.title, status: t.status, labels: t.labels ?? [], assignee: t.assignee ?? [], ordinal: t.ordinal, body: t.body ?? '' };
}

export const boardWidth = (cols: number) => PAD * 2 + cols * COL_W + (cols - 1) * COL_GAP;
export const colX = (b: CanvasNode, i: number) => b.x + PAD + i * (COL_W + COL_GAP);
export const cardsTop = (b: CanvasNode) => b.y + HEADER + COL_HEAD;
