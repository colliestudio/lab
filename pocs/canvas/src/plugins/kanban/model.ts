import type { CanvasNode, DocView } from '../../core';
import type { AcItem, CommentItem, FieldName } from './markdown';
import { FIELDS, hashOf, stampTime } from './markdown';
import type { SourceInfo } from './source';

// A kanban board on the canvas is a live view of a Backlog.md project that the canvas serve hosts. Two
// kinds of node share the `x-kanban` namespace:
//   board: a group node (columns = statuses). Its tasks are contained in it and laid out in columns.
//   task:  one per Backlog.md task, a JSON Canvas `file` node (`file` = the task id, never a path).
//          Holds the task's fields (synced through Yjs like any node) and `base`: hashes of what the
//          source said at the last sync. Field != base = an edit the serve still has to write;
//          source != base = an outside edit (agent, CLI, git pull).
// The browser never reaches files: it changes the doc, and the serve (server/kanban/attach.ts) syncs.

export const FIELD = 'x-kanban';

export interface BoardFilter {
  /** A task shows when it has any of these labels. */
  labels?: string[];
  /** Only the subtasks of this task. */
  parent?: string;
}

export interface BoardField {
  kind: 'board';
  /** Which folder of the serve: a name from `--kanban name=path`. Never a path. */
  source: string;
  name: string;
  // written by the sync from the source:
  columns: string[];
  defaultColumn: string;
  doneColumn?: string;
  labels: string[];
  priorities?: string[];
  caps?: SourceInfo['caps'];
  /** The id the next new task gets (provisional until the serve writes the file). */
  nextId?: string;
  // the user's, saved on the node (undoable):
  filter?: BoardFilter;
  /** Done tasks changed within this many days show; older ones sit behind "+N". */
  doneDays?: number;
  /** Columns that show all their cards (Done: the older ones too). */
  expanded?: string[];
  /** The sync's status (not exported): `live` once the serve has read the folder, or the problem it has. */
  state?: { live?: boolean; error?: string };
}

export interface PendingComment {
  key: string;
  author: string;
  text: string;
}

export interface TaskField {
  kind: 'task';
  /** The board node's id. */
  board: string;
  /** Backlog.md id ("TASK-12"); provisional while `pending`. */
  taskId?: string;
  title: string;
  status: string;
  ordinal?: number;
  labels: string[];
  assignee: string[];
  priority?: string;
  description: string;
  plan: string;
  notes: string;
  ac: AcItem[];
  // read-only, from the source:
  parent?: string;
  created?: string;
  updated?: string;
  comments: CommentItem[];
  /** Comments typed on the board that the serve has not written yet. */
  outbox?: PendingComment[];
  /** Made on the board, not written to the source yet (so its id is a guess). */
  pending?: boolean;
  /** Hashes of what the source held at the last sync, per synced field. */
  base?: Partial<Record<FieldName, string>>;
  /** A conflict note on the card: the file won (cleared by the next edit of that task). */
  note?: string;
}

export const COL_W = 248;
export const DONE_W = 176;
export const COL_GAP = 12;
export const PAD = 14;
export const HEADER = 50;
export const COL_HEAD = 34;
export const CARD_W = COL_W - 16;
export const CARD_H = 74;
export const ROW_W = DONE_W - 16;
export const ROW_H = 26;
export const CARD_GAP = 8;
export const FOOT = 40;
export const COLUMN_LIMIT = 8;
export const DONE_DAYS = 14;
export const DAY = 86_400_000;

const f = (n: CanvasNode | undefined) => (n ? (n[FIELD] as { kind?: string } | undefined) : undefined);
// guards narrow to a node with that field, so a false branch still leaves a plain CanvasNode
export const isBoard = (n: CanvasNode | undefined): n is CanvasNode & { [FIELD]: BoardField } => f(n)?.kind === 'board';
export const isTask = (n: CanvasNode | undefined): n is CanvasNode & { [FIELD]: TaskField } => f(n)?.kind === 'task';
export const board = (n: CanvasNode) => n[FIELD] as BoardField;
export const task = (n: CanvasNode) => n[FIELD] as TaskField;

/** The clock the Done recency and the sync read; tests set it. */
export const clock = { now: () => Date.now() };

/** Tasks of a board (contained nodes). */
export const tasksOf = (doc: DocView, boardId: string) => doc.children(boardId).filter(isTask);

/** Columns: the board's statuses, then any status a task uses that the config doesn't list (so no task is lost). */
export function columnsOf(doc: DocView, b: CanvasNode): string[] {
  const cols = [...board(b).columns];
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

/** Every task of a column in order, filtered or not. */
export function column(doc: DocView, boardId: string, status: string): CanvasNode[] {
  return tasksOf(doc, boardId)
    .filter((t) => task(t).status === status)
    .sort(byOrder);
}

/** Does the board's filter let this task show? */
export function passesFilter(t: TaskField, filter: BoardFilter | undefined): boolean {
  if (filter?.labels?.length && !filter.labels.some((l) => t.labels?.includes(l))) return false;
  if (filter?.parent && t.parent?.toUpperCase() !== filter.parent.toUpperCase()) return false;
  return true;
}

/** When a task last changed (ms epoch): `updated`, else `created`; undefined if neither is readable. */
export const changedAt = (t: TaskField) => stampTime(t.updated) ?? stampTime(t.created);

/** A Done task is recent when it changed within `days` days (14: shown; 15: hidden). Without a date it counts as old. */
export function isRecent(t: TaskField, days: number, now: number): boolean {
  const at = changedAt(t);
  return at !== undefined && now - at <= days * DAY;
}

/** A task with a board edit the serve has not written yet (or one made on the board): it stays in view until the file has it. */
const inFlight = (t: TaskField) => !!t.pending || !!t.outbox?.length || dirtyFields(t).length > 0;

/**
 * The tasks of a column that show: the filter applies to every column; the Done column also hides
 * its older tasks unless the column is expanded, the others cut after COLUMN_LIMIT. A task whose edit is
 * still being written always shows (a card dropped far down must not vanish into "+N" for a moment).
 * `hidden` = how many sit behind "+N".
 */
export function shownIn(doc: DocView, b: CanvasNode, status: string, now = clock.now()): { shown: CanvasNode[]; filtered: CanvasNode[]; hidden: number } {
  const bf = board(b);
  const filtered = column(doc, b.id, status).filter((t) => passesFilter(task(t), bf.filter));
  const keep = (t: CanvasNode) => inFlight(task(t));
  if (status !== bf.doneColumn) {
    const all = !!bf.expanded?.includes(status);
    if (all) return { shown: filtered, filtered, hidden: 0 };
    const shown = filtered.filter((t, i) => i < COLUMN_LIMIT || keep(t));
    return { shown, filtered, hidden: filtered.length - shown.length };
  }
  if (bf.expanded?.includes(status)) return { shown: filtered, filtered, hidden: 0 };
  const days = bf.doneDays ?? DONE_DAYS;
  const shown = filtered.filter((t) => isRecent(task(t), days, now) || keep(t));
  return { shown, filtered, hidden: filtered.length - shown.length };
}

/** All tasks that show on the board (what a viewer sees). */
export function visibleTasks(doc: DocView, b: CanvasNode, now = clock.now()): CanvasNode[] {
  return columnsOf(doc, b).flatMap((s) => shownIn(doc, b, s, now).shown);
}

/** The fields the source owns and the sync compares (see markdown.ts FIELDS). */
export function syncValues(t: TaskField): Record<FieldName, unknown> {
  return { title: t.title, status: t.status, labels: t.labels ?? [], assignee: t.assignee ?? [], priority: t.priority, ordinal: t.ordinal, description: t.description ?? '', plan: t.plan ?? '', notes: t.notes ?? '', ac: t.ac ?? [] };
}

/** Fields of a task that differ from what the source had at the last sync (the serve must write them). */
export function dirtyFields(t: TaskField): FieldName[] {
  if (!t.base) return [];
  const v = syncValues(t);
  return FIELDS.filter((k) => t.base![k] !== hashOf(v[k]));
}

// ------------------------------------------------------------ geometry

export const colWidth = (b: CanvasNode, status: string) => (status === board(b).doneColumn ? DONE_W : COL_W);
export const boardWidth = (b: CanvasNode, cols: string[]) => PAD * 2 + cols.reduce((w, s) => w + colWidth(b, s), 0) + (cols.length - 1) * COL_GAP;
export function colX(b: CanvasNode, cols: string[], i: number) {
  let x = b.x + PAD;
  for (let k = 0; k < i; k++) x += colWidth(b, cols[k]) + COL_GAP;
  return x;
}
export const cardsTop = (b: CanvasNode) => b.y + HEADER + COL_HEAD;

// ------------------------------------------------------------ who is on it, links

export interface Seat {
  id: string;
  name: string;
  color?: string;
}

/**
 * The seat an assignee stands for, if one is at the table: the "@" is dropped, case does not matter,
 * and it is the first word of the seat's name that must equal it ("Claude · task-3.48" is `@claude`).
 * Purely display; nothing is written.
 */
export function seatOf(assignee: readonly string[] | undefined, seats: readonly Seat[]): Seat | undefined {
  const names = (assignee ?? []).map((a) => a.replace(/^@/, '').trim().toLowerCase()).filter(Boolean);
  if (!names.length) return;
  return seats.find((s) => names.includes(s.name.trim().split(/[\s·]/)[0].toLowerCase()));
}

export const assigneeSeated = (assignee: readonly string[] | undefined, seats: readonly Seat[]) => !!seatOf(assignee, seats);

/** Where a task's work lives, derived from its id (workspace convention): worktree, branch prefix, notes. Text only. */
export function derivedLinks(taskId: string | undefined): { label: string; text: string }[] {
  if (!taskId || !/^[A-Za-z]+-\d+(\.\d+)*$/.test(taskId)) return [];
  const t = taskId.toLowerCase();
  return [
    { label: 'Worktree', text: `wt/<repo>/${t}` },
    { label: 'Branch', text: `${t}-…` },
    { label: 'Notes', text: `work/${t}` },
  ];
}

/** "@claude" from an actor's name: the first word, lowercased. */
export const authorOf = (name: string | undefined) => `@${(name ?? 'canvas').trim().split(/[\s·]/)[0].toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'canvas'}`;
