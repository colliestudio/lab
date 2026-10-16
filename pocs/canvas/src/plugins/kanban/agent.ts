import * as z from 'zod/mini';
import { command, nodeRef, view, type CommandSpec, type ViewSpec } from '../../core/agent';
import type { CanvasNode, DocView } from '../../core';
import { SOURCE_NAME, type EditPatch } from './commands';
import { DONE_DAYS, board, clock, columnsOf, isBoard, isTask, shownIn, task, tasksOf, type TaskField } from './model';

// Agent side: a spec per command, the kanban.board view, the guide. Refusals with a reason are thrown in
// the adapters (`toCommand`); the commands keep the store contract (bad args do nothing), so the UI,
// which dispatches without specs, is unchanged.

type Node = CanvasNode & { 'x-kanban': ReturnType<typeof task> };

const boardRef = z.optional(nodeRef('kanban node (id or title); optional when the board has exactly one'));
const taskRef = (extra = '') => z.string().check(z.minLength(1), z.meta({ description: `a task: its id (TASK-12, task-3.48, or just 12) or a unique part of its title${extra}` }));
const status = z.string().check(z.meta({ description: 'a column (status) of the board, e.g. "In Progress"' }));
const priority = z.enum(['high', 'medium', 'low']);

const quote = (n: CanvasNode) => `“${n.label ?? n.id}” (${n.id})`;

/** The kanban node a command means: `ref` (already resolved to an id), or the only one on the board. */
export function needBoard(doc: DocView, ref?: string): CanvasNode {
  if (ref) {
    const n = doc.get(ref);
    if (isBoard(n)) return n;
    throw new Error(`${ref} is not a kanban node${n ? ` (it is a ${n.type})` : ''}; kanban nodes: ${doc.nodes.filter(isBoard).map(quote).join(', ') || 'none'}`);
  }
  const boards = doc.nodes.filter(isBoard);
  if (!boards.length) throw new Error('there is no kanban node on this board (kanban.addBoard {source} adds one; the source is a folder name the serve was started with)');
  if (boards.length > 1) throw new Error(`there are ${boards.length} kanban nodes; say which one with board: ${boards.map(quote).join(', ')}`);
  return boards[0];
}

const norm = (s: string) => s.trim().toLowerCase();

/** The task `ref` names on board `b`: an id (TASK-12, task-12, 12) or a unique title (exact, then part of it). */
export function needTask(doc: DocView, b: CanvasNode, ref: string): Node {
  const tasks = tasksOf(doc, b.id) as Node[];
  const r = norm(ref);
  const prefix = (board(b).nextId ?? tasks.find((t) => task(t).taskId)?.[`x-kanban`].taskId ?? 'TASK-1').split('-')[0].toLowerCase();
  const id = /^\d+(\.\d+)*$/.test(r) ? `${prefix}-${r}` : r;
  const byId = tasks.find((t) => norm(task(t).taskId ?? '') === id);
  if (byId) return byId;
  for (const test of [(t: string) => t === r, (t: string) => t.includes(r)]) {
    const hits = tasks.filter((t) => test(norm(task(t).title)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} tasks: ${hits.slice(0, 5).map((t) => `${task(t).taskId} (${task(t).title})`).join(', ')}; use the id`);
  }
  throw new Error(`no task "${ref}" on ${quote(b)}${tasks.length ? ' (it may be archived, or filtered out of the sync)' : ''}`);
}

/** The column `s` names (case does not matter), or an error that lists them. */
function needStatus(doc: DocView, b: CanvasNode, s: string): string {
  const cols = columnsOf(doc, b);
  const hit = cols.find((c) => norm(c) === norm(s));
  if (!hit) throw new Error(`no column "${s}"; columns: ${cols.join(', ')}`);
  return hit;
}

const acText = (t: TaskField) => (t.ac ?? []).map((a, i) => `${i + 1}. [${a.done ? 'x' : ' '}] ${a.text}`).join('\n');

/**
 * The acceptance list after applying set, add, check, uncheck, then remove (1-based, as `backlog task edit` counts;
 * numbers refer to the list with the new items at the end, so a call can add an item and tick it).
 */
export function applyAc(t: TaskField, ops: { check?: number[]; uncheck?: number[]; set?: { index: number; text: string }[]; remove?: number[]; add?: string[] }) {
  const list = (t.ac ?? []).map((a) => ({ ...a }));
  for (const text of ops.add ?? []) list.push({ text, done: false });
  const at = (i: number) => {
    if (!Number.isInteger(i) || i < 1 || i > list.length) throw new Error(`acceptance criterion #${i} does not exist (${list.length ? `1 to ${list.length}` : 'this task has none'})`);
    return list[i - 1];
  };
  for (const s of ops.set ?? []) at(s.index).text = s.text;
  for (const i of ops.check ?? []) at(i).done = true;
  for (const i of ops.uncheck ?? []) at(i).done = false;
  const gone = new Set((ops.remove ?? []).map((i) => (at(i), i)));
  return list.filter((_, i) => !gone.has(i + 1));
}

const changed = (r: { changes: unknown[]; untracked?: unknown[] }) => r.changes.length + (r.untracked?.length ?? 0);

export const specs: Record<string, CommandSpec> = {
  move: command({
    description: 'Move a task to another column (a status), optionally just before another task of that column. The serve writes the status (and the order) to the task file within a second.',
    args: z.strictObject({ task: taskRef(), status, before: z.optional(taskRef(' (it goes just before this one)')), board: boardRef }),
    example: { task: 'TASK-12', status: 'In Progress' },
    toCommand: (a, ctx) => {
      const b = needBoard(ctx.doc, a.board);
      const t = needTask(ctx.doc, b, a.task);
      const st = needStatus(ctx.doc, b, a.status);
      let index = 1e9;
      if (a.before) {
        const other = needTask(ctx.doc, b, a.before);
        if (other.id === t.id) throw new Error('before: a task can not go before itself');
        if (task(other).status !== st) throw new Error(`${task(other).taskId} is in ${task(other).status}, not ${st}: before: must be a task of the target column`);
        index = shownIn(ctx.doc, b, st).shown.filter((x) => x.id !== t.id).findIndex((x) => x.id === other.id);
        if (index < 0) throw new Error(`${task(other).taskId} does not show on the board (filtered out or in Done's older tasks)`);
      }
      return { board: b.id, ids: [t.id], status: st, index };
    },
    result: (r, a, ctx) => ({ task: a.task, status: needStatus(ctx.doc, needBoard(ctx.doc, a.board), a.status), changed: changed(r), pending: true }),
    cli: [{ verb: 'kanban move', pos: ['task', 'status'] }],
  }),
  create: command({
    description:
      'Add a task. It gets its id at once (in the result) and the serve writes the file within a second. Without a status it goes to the first column; without labels or a parent it takes the node\'s filter. An agent that picks the task up should also set itself as assignee.',
    args: z.strictObject({
      title: z.string().check(z.minLength(1)),
      status: z.optional(status),
      labels: z.optional(z.array(z.string())),
      assignee: z.optional(z.array(z.string())),
      priority: z.optional(priority),
      parent: z.optional(taskRef(' (makes a subtask)')),
      description: z.optional(z.string()),
      board: boardRef,
    }),
    example: { title: 'Fix the login redirect', labels: ['canvas'], priority: 'high' },
    toCommand: (a, ctx) => {
      const b = needBoard(ctx.doc, a.board);
      const parent = a.parent ? task(needTask(ctx.doc, b, a.parent)).taskId : undefined;
      return { board: b.id, titles: [a.title], status: a.status ? needStatus(ctx.doc, b, a.status) : undefined, labels: a.labels, assignee: a.assignee, priority: a.priority, parent, description: a.description };
    },
    result: (r, _a, ctx) => {
      const n = r.select?.[0] ? ctx.doc.get(r.select[0]) : undefined;
      return { id: isTask(n) ? task(n).taskId : undefined, pending: true, changed: changed(r) };
    },
    cli: [{ verb: 'kanban create', rest: 'title' }],
  }),
  edit: command({
    description:
      'Change a task\'s fields: title, labels (replaces the list), assignee (replaces), priority, description, plan, notes, and the acceptance criteria with ops (numbers are 1-based like `backlog task edit --check-ac`). Status and order are kanban.move. The serve writes only what changed.',
    args: z.strictObject({
      task: taskRef(),
      title: z.optional(z.string()),
      labels: z.optional(z.array(z.string())),
      assignee: z.optional(z.array(z.string())),
      priority: z.optional(z.union([priority, z.literal('none')])),
      description: z.optional(z.string()),
      plan: z.optional(z.string()),
      notes: z.optional(z.string()),
      ac: z.optional(
        z.strictObject({
          check: z.optional(z.array(z.number())),
          uncheck: z.optional(z.array(z.number())),
          add: z.optional(z.array(z.string())),
          remove: z.optional(z.array(z.number())),
          set: z.optional(z.array(z.strictObject({ index: z.number(), text: z.string() }))),
        }),
      ),
      board: boardRef,
    }),
    example: { task: 'TASK-12', assignee: ['@claude'], ac: { check: [1] } },
    toCommand: ({ task: ref, board: bref, ac, priority: pr, ...fields }, ctx) => {
      const b = needBoard(ctx.doc, bref);
      const t = needTask(ctx.doc, b, ref);
      const patch: EditPatch = { ...fields };
      if (pr !== undefined) patch.priority = pr === 'none' ? null : pr;
      if (ac) patch.ac = applyAc(task(t), ac);
      if (!Object.keys(patch).length) throw new Error('nothing to change: give at least one of title, labels, assignee, priority, description, plan, notes, ac');
      return { id: t.id, patch };
    },
    result: (r, a) => ({ task: a.task, changed: changed(r), pending: true }),
    cli: [{ verb: 'kanban edit', pos: ['task'] }],
  }),
  comment: command({
    description: 'Add a comment to a task (as `backlog task edit --comment`); the author is @ + the first word of your name. The serve writes it within a second.',
    args: z.strictObject({ task: taskRef(), text: z.string().check(z.minLength(1)), board: boardRef }),
    example: { task: 'TASK-12', text: 'Plan agreed, starting.' },
    toCommand: (a, ctx) => ({ id: needTask(ctx.doc, needBoard(ctx.doc, a.board), a.task).id, text: a.text }),
    result: (r, a) => ({ task: a.task, changed: changed(r), pending: true }),
    cli: [{ verb: 'kanban comment', pos: ['task'], rest: 'text' }],
  }),
  filter: command({
    description: 'Set what the kanban node shows (saved on the node, everyone sees it): tasks with any of `labels`, and/or only the subtasks of `parent`. Empty labels / empty parent clears that part.',
    args: z.strictObject({ labels: z.optional(z.array(z.string())), parent: z.optional(z.string()), board: boardRef }),
    example: { labels: ['canvas'], parent: 'TASK-3' },
    toCommand: (a, ctx) => {
      const b = needBoard(ctx.doc, a.board);
      return { board: b.id, labels: a.labels === undefined ? undefined : a.labels.length ? a.labels : null, parent: a.parent === undefined ? undefined : a.parent ? (task(needTask(ctx.doc, b, a.parent)).taskId ?? a.parent) : null };
    },
    result: (r) => ({ changed: changed(r) }),
    cli: [{ verb: 'kanban filter' }],
  }),
  addBoard: command({
    description: 'Put a kanban node on the board for a Backlog.md folder the serve was started with (`--kanban name=path`); `source` is that name. The folder can not be chosen here.',
    args: z.strictObject({ source: z.string().check(z.regex(SOURCE_NAME), z.meta({ description: 'the folder\'s name on the serve' })), x: z.optional(z.number()), y: z.optional(z.number()) }),
    example: { source: 'cs' },
    toCommand: (a, ctx) => {
      if (a.x !== undefined && a.y !== undefined) return a;
      const nodes = ctx.doc.nodes.filter((n) => !ctx.doc.parentOf(n.id));
      const right = nodes.length ? Math.max(...nodes.map((n) => n.x + n.width)) : -300;
      const top = nodes.length ? Math.min(...nodes.map((n) => n.y)) : 0;
      return { source: a.source, x: a.x ?? right + 480, y: a.y ?? top + 200 };
    },
    result: (r) => ({ id: r.select?.[0], changed: changed(r) }),
    cli: [{ verb: 'kanban add', pos: ['source'] }],
  }),
};

// ------------------------------------------------------------ the view

const cardLine = (t: TaskField) => {
  const done = (t.ac ?? []).filter((a) => a.done).length;
  const bits = [`${t.taskId ?? 'new'}${t.priority ? ` [${t.priority}]` : ''} ${t.title}`];
  if (t.ac?.length) bits.push(`AC ${done}/${t.ac.length}`);
  if (t.assignee?.length) bits.push(t.assignee.join(' '));
  if (t.pending) bits.push('pending');
  if (t.note) bits.push(`note: ${t.note}`);
  return `  ${bits.join(' · ')}`;
};

function oneTask(t: TaskField, b: CanvasNode): string {
  const rows = [
    `${t.taskId ?? 'new'} ${t.title}`,
    `status: ${t.status} · priority: ${t.priority ?? 'none'} · assignee: ${t.assignee?.join(', ') || 'none'} · labels: ${t.labels?.join(', ') || 'none'}${t.parent ? ` · parent: ${t.parent}` : ''}`,
    `created ${t.created ?? '?'} · updated ${t.updated ?? '?'} · board ${board(b).name}`,
  ];
  const sec = (label: string, text: string) => text && rows.push('', `${label}:`, text);
  sec('Description', t.description);
  sec('Acceptance criteria', acText(t));
  sec('Plan', t.plan);
  sec('Notes', t.notes);
  if (t.comments?.length) rows.push('', 'Comments:', ...t.comments.map((c) => `- ${c.author ?? 'someone'} ${c.created ?? ''}: ${c.text.replace(/\n/g, ' / ')}`));
  if (t.outbox?.length) rows.push('', `Not written yet: ${t.outbox.length} comment${t.outbox.length === 1 ? '' : 's'}`);
  return rows.join('\n');
}

/** The board as compact text: columns, one line per task, Done collapsed. */
export function boardText(doc: DocView, b: CanvasNode, all = false, now = clock.now()): string {
  const bf = board(b);
  const filter = [bf.filter?.labels?.length ? `label ${bf.filter.labels.join('|')}` : '', bf.filter?.parent ? `parent ${bf.filter.parent}` : ''].filter(Boolean).join(', ');
  const state = bf.state?.error ? `NOT LIVE: ${bf.state.error}` : bf.state?.live ? 'live' : 'not synced yet';
  const out = [`${bf.name} (${bf.source}) · ${state}${filter ? ` · filter: ${filter}` : ''} · ${b.id}`];
  for (const s of columnsOf(doc, b)) {
    const { shown, filtered, hidden } = shownIn(doc, b, s, now);
    const all_ = all ? filtered : shown;
    out.push(`${s} (${filtered.length})${s === bf.doneColumn && !all ? ` · last ${bf.doneDays ?? DONE_DAYS} days: ${shown.length}` : ''}`);
    for (const t of all_) out.push(cardLine(task(t)));
    if (!all && hidden > 0) out.push(`  +${hidden} ${s === bf.doneColumn ? 'older' : 'more'} (all: true shows them)`);
  }
  return out.join('\n');
}

export const views: Record<string, ViewSpec> = {
  'kanban.board': view({
    description: 'The kanban node as text: columns with their tasks (id, priority, title, AC progress, assignee), what its filter hides left out, Done collapsed to recent. `task` shows one task in full: sections, acceptance criteria, comments. `all` shows every task.',
    args: z.strictObject({ board: boardRef, task: z.optional(taskRef()), all: z.optional(z.boolean()) }),
    example: {},
    read: (doc, a) => {
      const b = needBoard(doc, a.board);
      if (a.task) return oneTask(task(needTask(doc, b, a.task)), b);
      return boardText(doc, b, !!a.all);
    },
    text: (v) => String(v),
    cli: [{ verb: 'kanban' }],
  }),
};

export const GUIDE = `A kanban node is a live board of a Backlog.md folder the serve hosts: columns are the project's statuses, cards are its task files.
- The files are the truth. The \`backlog\` CLI, git and hand edits work as before and the board follows within about a second; the serve writes board edits to the files the way the CLI would.
- kanban.move {task, status, before?} moves a card; kanban.create {title, status?, labels?, priority?, parent?} adds one and returns its id; kanban.edit changes title, labels, assignee, priority, description, plan, notes and acceptance criteria (ac: {check, uncheck, add, remove, set}, 1-based); kanban.comment {task, text} comments. kanban.filter narrows what the node shows.
- Name a task by its id (TASK-12, task-3.48, or 12) or by a unique part of its title. With more than one kanban node, add board: <node>.
- Read it with the view kanban.board (canvas_look): columns and cards as text; {task: "TASK-12"} one task in full; {all: true} includes older Done tasks.
- Writes land asynchronously: a result says pending, and the file follows within a second. If you read the file right after, it may still be the old one.
- When you pick a task up, set yourself as its assignee (kanban.edit {task, assignee: ["@you"]}); the card shows a live dot while an assignee is seated on the board.
- If a file changed the same field meanwhile, the file wins and the board says so; check the card before repeating an edit.
- The folder is fixed by the serve (--kanban name=path): there is no way to choose or leave it from here, and extra path arguments are errors.`;

