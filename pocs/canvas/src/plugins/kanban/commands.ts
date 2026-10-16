import type { CanvasNode, Change, Command, DocView } from '../../core';
import { isIds, isNum } from '../../core/commands';
import { set } from '../../core/doc';
import type { AcItem } from './markdown';
import { commentProblem, markerProblem, nextTaskId } from './markdown';
import { CARD_H, CARD_W, COLUMN_LIMIT, FIELD, authorOf, board, byOrder, column, columnsOf, isBoard, isTask, shownIn, task, tasksOf, type BoardField, type TaskField } from './model';

const isStr = (v: unknown): v is string => typeof v === 'string';
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const uniq = (a: string[]) => [...new Set(a)];

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export const SOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TITLE = 500;
const MAX_TEXT = 200_000;
const MAX_AC = 200;

/** The fields a board edit may change. `priority: null` clears it. */
export interface EditPatch {
  title?: string;
  labels?: string[];
  assignee?: string[];
  priority?: string | null;
  description?: string;
  plan?: string;
  notes?: string;
  ac?: AcItem[];
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Clean task fields from untrusted args (a peer, an agent). Unknown keys are dropped; sizes are bounded. */
export function cleanEdit(p: unknown): EditPatch {
  const out: EditPatch = {};
  if (!p || typeof p !== 'object') return out;
  const a = p as Record<string, unknown>;
  if (isStr(a.title) && oneLine(a.title)) out.title = oneLine(a.title).slice(0, MAX_TITLE);
  if ('labels' in a) out.labels = uniq(strs(a.labels).map(oneLine).filter(Boolean)).slice(0, 50);
  if ('assignee' in a) out.assignee = uniq(strs(a.assignee).map(oneLine).filter(Boolean)).slice(0, 20);
  if ('priority' in a) {
    if (a.priority === null || a.priority === '') out.priority = null;
    else if (isStr(a.priority) && (PRIORITIES as readonly string[]).includes(a.priority)) out.priority = a.priority;
  }
  for (const k of ['description', 'plan', 'notes'] as const) if (isStr(a[k]) && !markerProblem(a[k])) out[k] = a[k].slice(0, MAX_TEXT);
  if (Array.isArray(a.ac)) {
    out.ac = a.ac
      .filter((x): x is { text: string; done?: unknown } => !!x && typeof x === 'object' && isStr((x as { text?: unknown }).text) && !!oneLine((x as { text: string }).text))
      .slice(0, MAX_AC)
      .map((x) => ({ text: x.text.replace(/[\r\n]+/g, ' ').trim().slice(0, 1000), done: x.done === true })); // inner spacing stays: ticking one item must not rewrite another
  }
  return out;
}

const ns = (id: string, key: string, v: unknown) => set(id, `${FIELD}.${key}`, v);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Order the tasks of column `status` (limited to `scope`, when given) would have if `over` replaced their status/ordinal. */
function orderWith(doc: DocView, boardId: string, status: string, over: Map<string, { status: string; ordinal?: number }>, scope?: Set<string>): string[] {
  const view = (n: CanvasNode): CanvasNode => {
    const o = over.get(n.id);
    return o ? { ...n, [FIELD]: { ...task(n), ...o } } : n;
  };
  return tasksOf(doc, boardId)
    .filter((t) => !scope || scope.has(t.id))
    .map(view)
    .filter((t) => task(t).status === status)
    .sort(byOrder)
    .map((t) => t.id);
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Put task nodes `moving` into column `status` just before `beforeId` (null = after the others), changing
 * as few fields as possible: status only if the existing order already puts them there; else ordinals for
 * the moved cards between their neighbours; else renumber the column (1000, 2000, ...). Only the tasks in
 * `scope` (the ones that show) count: hidden ones (older Done tasks, a filter) are never renumbered.
 */
export function placeInColumn(doc: DocView, boardId: string, status: string, moving: string[], beforeId: string | null, scope?: Set<string>): Change[] {
  const rest = column(doc, boardId, status).filter((t) => !moving.includes(t.id) && (!scope || scope.has(t.id)));
  const at = beforeId === null ? -1 : rest.findIndex((t) => t.id === beforeId);
  const i = at < 0 ? rest.length : at;
  const desired = [...rest.slice(0, i).map((t) => t.id), ...moving, ...rest.slice(i).map((t) => t.id)];
  const statusChanges = moving.filter((id) => task(doc.get(id)!).status !== status).map((id) => ns(id, 'status', status));
  const scoped = scope && new Set([...scope, ...moving]);

  // 1. status only
  const keep = new Map(moving.map((id) => [id, { status, ordinal: task(doc.get(id)!).ordinal }]));
  if (sameList(orderWith(doc, boardId, status, keep, scoped), desired)) return statusChanges;

  // 2. ordinals for the moved cards only
  const prev = i > 0 ? task(rest[i - 1]).ordinal : undefined;
  const next = i < rest.length ? task(rest[i]).ordinal : undefined;
  if ((i === 0 || prev !== undefined) && (i === rest.length || next !== undefined)) {
    const lo = prev ?? 0;
    const hi = next ?? lo + 1000 * (moving.length + 1);
    const step = (hi - lo) / (moving.length + 1);
    const ords = moving.map((_, k) => Math.round(lo + step * (k + 1)));
    const ok = ords.every((o, k) => o > lo && o < hi && (k === 0 || o > ords[k - 1]));
    if (ok) {
      const over = new Map(moving.map((id, k) => [id, { status, ordinal: ords[k] }]));
      if (sameList(orderWith(doc, boardId, status, over, scoped), desired)) return [...statusChanges, ...moving.flatMap((id, k) => (task(doc.get(id)!).ordinal !== ords[k] ? [ns(id, 'ordinal', ords[k])] : []))];
    }
  }

  // 3. renumber the column
  const out = [...statusChanges];
  desired.forEach((id, k) => {
    const o = (k + 1) * 1000;
    if (task(doc.get(id)!).ordinal !== o) out.push(ns(id, 'ordinal', o));
  });
  return out;
}

/** The ids the next `count` tasks would get on this board: past every id the doc knows, and past the serve's own guess; per parent for subtasks. */
export function nextLocalIds(doc: DocView, b: CanvasNode, count: number, parent?: string): string[] {
  const ids = tasksOf(doc, b.id).flatMap((t) => (task(t).taskId ? [task(t).taskId!] : []));
  const guess = board(b).nextId;
  const prefix = (guess ?? ids[0] ?? 'TASK-1').split('-')[0];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let id = nextTaskId(ids, prefix, parent);
    // the serve counted archived and completed tasks too: never go below its guess
    if (!parent && guess && Number(guess.split('-')[1]) > Number(id.split('-')[1])) id = guess;
    out.push(id);
    ids.push(id);
  }
  return out;
}

/** The node a command argument means: a task of the board by node id. */
const taskNode = (doc: DocView, id: unknown): (CanvasNode & { [FIELD]: TaskField }) | undefined => {
  const n = isStr(id) ? doc.get(id) : undefined;
  return isTask(n) ? n : undefined;
};

export interface MoveArgs {
  board: string;
  ids: string[];
  status: string;
  /** Position among the tasks that show in the column (without the moved ones). */
  index: number;
}

export interface CreateArgs {
  board: string;
  titles: string[];
  status?: string;
  labels?: string[];
  assignee?: string[];
  priority?: string;
  parent?: string;
  description?: string;
}

export const commands: Record<string, Command> = {
  /** A new, not yet synced board node of `source`, centred on (x, y). */
  addBoard(doc, a: { x: number; y: number; source: string }, ctx) {
    if (!isNum(a?.x) || !isNum(a?.y) || !isStr(a.source) || !SOURCE_NAME.test(a.source)) return [];
    const id = ctx.newId();
    const cols = ['To Do', 'In Progress', 'Done'];
    const f: BoardField = { kind: 'board', source: a.source, name: a.source, columns: cols, defaultColumn: 'To Do', doneColumn: 'Done', labels: [] };
    const w = 3 * 248 + 2 * 12 + 28;
    return { changes: [{ op: 'add', node: { id, type: 'group', label: f.name, x: Math.round(a.x - w / 2), y: Math.round(a.y - 200), width: w, height: 400, z: doc.topZ + 1, [FIELD]: f } }], select: [id] };
  },

  /** Drag on the board: tasks into column `status` at `index` (among the tasks that show there). */
  move(doc, a: MoveArgs) {
    const b = doc.get(a?.board);
    if (!isBoard(b) || !isIds(a.ids) || !isStr(a.status) || !isNum(a.index)) return [];
    if (!columnsOf(doc, b).includes(a.status)) return [];
    const moving: string[] = [];
    for (const id of a.ids) {
      const n = taskNode(doc, id);
      if (n && task(n).board === b.id && !moving.includes(n.id)) moving.push(n.id);
    }
    if (!moving.length) return [];
    const visible = shownIn(doc, b, a.status).shown.filter((t) => !moving.includes(t.id));
    const i = Math.max(0, Math.min(visible.length, Math.round(a.index)));
    // before the task that shows at `index`; at the end of what shows (hidden older Done tasks stay where they were)
    const before = i < visible.length ? visible[i].id : null;
    const changes = placeInColumn(doc, b.id, a.status, moving, before, new Set(visible.map((t) => t.id)));
    // a card dropped past the cut of a long column opens the column, so it stays where the user put it
    const cur = board(b).expanded ?? [];
    if (a.status !== board(b).doneColumn && i >= COLUMN_LIMIT && !cur.includes(a.status)) changes.push(ns(b.id, 'expanded', [...cur, a.status]));
    const noted = moving.filter((id) => task(doc.get(id)!).note).map((id) => ns(id, 'note', undefined));
    const titles = moving.map((id) => task(doc.get(id)!).taskId ?? task(doc.get(id)!).title);
    const moved = changes.some((c) => c.op === 'set' && c.key.endsWith('.status'));
    return {
      changes: [...changes, ...(changes.length ? noted : [])],
      events: moved ? [{ type: 'kanban.move', text: `moved ${titles.join(', ')} to ${a.status}`, targets: moving }] : [],
    };
  },

  /** Edit a task's fields (title, labels, assignee, priority, description, plan, notes, acceptance criteria). */
  edit(doc, a: { id: string; patch: EditPatch }) {
    const n = taskNode(doc, a?.id);
    if (!n) return [];
    const p = cleanEdit(a.patch);
    const t = task(n);
    const out: Change[] = [];
    for (const k of Object.keys(p) as (keyof EditPatch)[]) {
      const v = k === 'priority' ? (p.priority ?? undefined) : p[k];
      const cur = k === 'description' || k === 'plan' || k === 'notes' ? (t[k] ?? '') : t[k];
      if (!same(cur, v)) out.push(ns(n.id, k, v));
    }
    if (out.length && t.note) out.push(ns(n.id, 'note', undefined));
    return out;
  },

  /**
   * New tasks at the end of a column (one per title: a paste of several lines makes several). They get a
   * provisional id at once; the serve writes the files and corrects an id that was taken meanwhile.
   * Not undoable: undo would have to delete files.
   */
  create(doc, a: CreateArgs, ctx) {
    const b = doc.get(a?.board);
    if (!isBoard(b) || !Array.isArray(a.titles)) return [];
    const titles = a.titles.filter(isStr).map(oneLine).filter(Boolean).slice(0, 100);
    if (!titles.length) return [];
    const bf = board(b);
    const status = isStr(a.status) && columnsOf(doc, b).includes(a.status) ? a.status : bf.defaultColumn;
    const labels = a.labels ? uniq(strs(a.labels).map(oneLine).filter(Boolean)) : (bf.filter?.labels ?? []);
    const parent = isStr(a.parent) && a.parent ? a.parent.toUpperCase() : bf.filter?.parent?.toUpperCase();
    const priority = isStr(a.priority) && (PRIORITIES as readonly string[]).includes(a.priority) ? a.priority : undefined;
    const ids = nextLocalIds(doc, b, titles.length, parent);
    const top = Math.max(0, ...tasksOf(doc, b.id).map((t) => task(t).ordinal ?? 0));
    const added: Change[] = [];
    const newIds: string[] = [];
    titles.forEach((title, i) => {
      const id = ctx.newId();
      newIds.push(id);
      const f: TaskField = {
        kind: 'task',
        board: b.id,
        taskId: ids[i],
        title: title.slice(0, MAX_TITLE),
        status,
        ordinal: top + 1000 * (i + 1),
        labels,
        assignee: a.assignee ? uniq(strs(a.assignee).map(oneLine).filter(Boolean)) : [],
        ...(priority ? { priority } : {}),
        ...(parent ? { parent } : {}),
        description: isStr(a.description) ? a.description.slice(0, MAX_TEXT) : '',
        plan: '',
        notes: '',
        ac: [],
        comments: [],
        pending: true,
      };
      added.push({ op: 'add', node: { id, type: 'file', file: ids[i], x: b.x, y: b.y, width: CARD_W, height: CARD_H, [FIELD]: f } });
    });
    if (!parent) added.push(ns(b.id, 'nextId', nextTaskId([...ids], ids[0].split('-')[0])));
    return {
      changes: [],
      untracked: added,
      select: newIds,
      events: [{ type: 'kanban.new', text: titles.length === 1 ? `added task "${titles[0]}" to ${status}` : `added ${titles.length} tasks to ${status}`, targets: newIds }],
    };
  },

  /** A comment on a task, written by the serve. Not undoable. */
  comment(doc, a: { id: string; text: string }, ctx) {
    const n = taskNode(doc, a?.id);
    const text = isStr(a?.text) ? a.text.trim() : '';
    if (!n || !text || commentProblem(text) || markerProblem(text)) return [];
    const t = task(n);
    const entry = { key: ctx.newId(), at: ctx.now?.() ?? Date.now(), author: authorOf(ctx.actor?.name), text: text.slice(0, 20_000) };
    return {
      changes: [],
      untracked: [ns(n.id, `outbox:${entry.key}`, entry)],
      events: [{ type: 'kanban.comment', text: `commented on ${t.taskId ?? t.title}`, targets: [n.id] }],
    };
  },

  /** Save the board's filter on the node (labels: any of; parent: its subtasks only). Empty = no filter. */
  filter(doc, a: { board: string; labels?: string[] | null; parent?: string | null }) {
    const b = doc.get(a?.board);
    if (!isBoard(b)) return [];
    const cur = board(b).filter ?? {};
    const labels = a.labels === undefined ? cur.labels : a.labels === null ? undefined : uniq(strs(a.labels).map(oneLine).filter(Boolean));
    const parent = a.parent === undefined ? cur.parent : a.parent === null || !isStr(a.parent) || !a.parent ? undefined : a.parent.toUpperCase();
    const next = { ...(labels?.length ? { labels } : {}), ...(parent ? { parent } : {}) };
    const value = Object.keys(next).length ? next : undefined;
    return same(value, board(b).filter) ? [] : [ns(b.id, 'filter', value)];
  },

  /** Show all cards of a column (Done: the older ones too), or only the first few. */
  expand(doc, a: { id: string; status: string; on: boolean }) {
    const b = doc.get(a?.id);
    if (!isBoard(b) || !isStr(a.status)) return [];
    const cur = board(b).expanded ?? [];
    const next = a.on ? [...new Set([...cur, a.status])] : cur.filter((s) => s !== a.status);
    return same(next, cur) ? [] : [ns(b.id, 'expanded', next.length ? next : undefined)];
  },
};

/** Duplicate (⌘D): tasks and boards are refused (a second node would be a second copy of one file). */
export function duplicateRule(n: CanvasNode): CanvasNode | null | undefined {
  if (isTask(n) || isBoard(n)) return null;
  return undefined;
}

