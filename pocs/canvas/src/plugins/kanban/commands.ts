import { isIds, isNum, set, type CanvasNode, type Change, type Command, type DocView } from '../../core';
import { FIELDS, type FieldName, type TaskFields } from './markdown';
import { CARD_H, CARD_W, FIELD, REF_H, REF_W, boardWidth, board, byOrder, column, isBoard, isRef, isTask, ref, task, tasksOf, type BoardField, type SourceKind, type TaskField } from './model';

const isStr = (v: unknown): v is string => typeof v === 'string';
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);

/** Clean task fields from untrusted args (a peer, a file, the service). Unknown keys dropped. */
export function cleanFields(p: unknown): Partial<TaskFields> {
  const out: Partial<TaskFields> = {};
  if (!p || typeof p !== 'object') return out;
  const a = p as Record<string, unknown>;
  if (isStr(a.title)) out.title = a.title.slice(0, 500);
  if (isStr(a.status) && a.status.trim()) out.status = a.status.trim().slice(0, 80);
  if ('labels' in a) out.labels = strs(a.labels).map((s) => s.trim()).filter(Boolean);
  if ('assignee' in a) out.assignee = strs(a.assignee).map((s) => s.trim()).filter(Boolean);
  if ('ordinal' in a) out.ordinal = isNum(a.ordinal) ? a.ordinal : undefined;
  if (isStr(a.body)) out.body = a.body;
  return out;
}

const ns = (id: string, key: string, v: unknown) => set(id, `${FIELD}.${key}`, v);

/** Order `ids` would get in column `status` if `over` replaced their status/ordinal. */
function orderWith(doc: DocView, boardId: string, status: string, over: Map<string, { status: string; ordinal?: number }>): string[] {
  const view = (n: CanvasNode): CanvasNode => {
    const o = over.get(n.id);
    return o ? { ...n, [FIELD]: { ...task(n), ...o } } : n;
  };
  return tasksOf(doc, boardId)
    .map(view)
    .filter((t) => task(t).status === status)
    .sort(byOrder)
    .map((t) => t.id);
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Put task nodes `moving` into column `status` at `index` (among the others), changing as few
 * fields as possible: status only if the existing order already puts them there; else ordinals for
 * the moved cards between their neighbours; else renumber the column (1000, 2000, ...).
 */
export function placeInColumn(doc: DocView, boardId: string, status: string, moving: string[], index: number): Change[] {
  const rest = column(doc, boardId, status).filter((t) => !moving.includes(t.id));
  const i = Math.max(0, Math.min(rest.length, Math.round(index)));
  const desired = [...rest.slice(0, i).map((t) => t.id), ...moving, ...rest.slice(i).map((t) => t.id)];
  const statusChanges = moving.filter((id) => task(doc.get(id)!).status !== status).map((id) => ns(id, 'status', status));

  // 1. status only
  const keep = new Map(moving.map((id) => [id, { status, ordinal: task(doc.get(id)!).ordinal }]));
  if (same(orderWith(doc, boardId, status, keep), desired)) return statusChanges;

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
      if (same(orderWith(doc, boardId, status, over), desired))
        return [...statusChanges, ...moving.filter((id, k) => task(doc.get(id)!).ordinal !== ords[k]).map((id, k) => ns(id, 'ordinal', ords[k]))];
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

export interface PulledTask {
  taskId: string;
  path?: string;
  fields: TaskFields;
  /** Hashes of `fields` (what the source says now). */
  hashes: Partial<Record<FieldName, string>>;
}

export const commands: Record<string, Command> = {
  /** A new, unconnected board centred on (x, y). */
  create(doc, a: { x: number; y: number; name?: string }, ctx) {
    if (!isNum(a?.x) || !isNum(a?.y)) return [];
    const id = ctx.newId();
    const f: BoardField = { kind: 'board', name: isStr(a.name) ? a.name : 'Backlog', statuses: ['To Do', 'In Progress', 'Done'], labels: [], defaultStatus: 'To Do' };
    const w = boardWidth(3);
    return { changes: [{ op: 'add', node: { id, type: 'group', label: f.name, x: Math.round(a.x - w / 2), y: Math.round(a.y - 200), width: w, height: 400, z: doc.topZ + 1, [FIELD]: f } }], select: [id] };
  },

  /** This tab becomes the host of the board's data (files or service). Not undoable. */
  connect(doc, a: { id: string; source: SourceKind; label: string; owner: string; ownerName?: string; ownerTab: string }) {
    const b = doc.get(a?.id);
    if (!isBoard(b) || (a.source !== 'files' && a.source !== 'service') || !isStr(a.owner) || !isStr(a.ownerTab)) return [];
    return [ns(b.id, 'source', a.source), ns(b.id, 'sourceLabel', String(a.label ?? '')), ns(b.id, 'owner', a.owner), ns(b.id, 'ownerName', a.ownerName ?? ''), ns(b.id, 'ownerTab', a.ownerTab), ns(b.id, 'error', undefined)];
  },

  /**
   * The host read the source. Per task and field: if the source changed since the last sync
   * (hash != base) the source wins; local edits of other fields stay (the host writes them next).
   * `complete`: tasks missing from the source are gone (archived, deleted): removed from the board.
   */
  pull(doc, a: { board: string; meta?: Partial<BoardField>; tasks: PulledTask[]; complete?: boolean; at?: number; error?: string }, ctx) {
    const b = doc.get(a?.board);
    if (!isBoard(b) || !Array.isArray(a.tasks)) return [];
    const out: Change[] = [];
    const bf = board(b);
    if (a.meta) {
      if (isStr(a.meta.name) && a.meta.name !== bf.name) out.push(ns(b.id, 'name', a.meta.name), set(b.id, 'label', a.meta.name));
      for (const k of ['statuses', 'labels'] as const) {
        const v = strs(a.meta[k]);
        if (v.length && JSON.stringify(v) !== JSON.stringify(bf[k])) out.push(ns(b.id, k, v));
      }
      if (isStr(a.meta.defaultStatus) && a.meta.defaultStatus !== bf.defaultStatus) out.push(ns(b.id, 'defaultStatus', a.meta.defaultStatus));
    }
    if (isNum(a.at)) out.push(ns(b.id, 'syncedAt', a.at));
    if (a.error !== bf.error) out.push(ns(b.id, 'error', isStr(a.error) ? a.error : undefined));

    const existing = tasksOf(doc, b.id);
    const byId = new Map(existing.filter((t) => task(t).taskId).map((t) => [task(t).taskId!, t]));
    const seen = new Set<string>();
    for (const p of a.tasks) {
      if (!p || !isStr(p.taskId)) continue;
      const fields = cleanFields(p.fields);
      const hashes = p.hashes ?? {};
      seen.add(p.taskId);
      const n = byId.get(p.taskId);
      if (!n) {
        const f: TaskField = { kind: 'task', board: b.id, taskId: p.taskId, path: p.path, title: '', status: bf.defaultStatus, labels: [], assignee: [], body: '', ...fields, base: hashes };
        out.push({ op: 'add', node: { id: ctx.newId(), type: 'file', file: p.path ?? p.taskId, x: b.x, y: b.y, width: CARD_W, height: CARD_H, [FIELD]: f } });
        continue;
      }
      const t = task(n);
      const base = { ...(t.base ?? {}) };
      let changedBase = false;
      for (const k of FIELDS) {
        if (hashes[k] === undefined || hashes[k] === base[k]) continue;
        // the source changed this field since the last sync: take it
        if (JSON.stringify(t[k] ?? null) !== JSON.stringify(fields[k] ?? null)) out.push(ns(n.id, k, fields[k]));
        base[k] = hashes[k];
        changedBase = true;
      }
      if (changedBase) out.push(ns(n.id, 'base', base));
      if (p.path && p.path !== t.path) out.push(ns(n.id, 'path', p.path), set(n.id, 'file', p.path));
    }
    if (a.complete) for (const t of existing) if (task(t).taskId && !seen.has(task(t).taskId!)) out.push({ op: 'del', id: t.id });
    return out;
  },

  /** The host wrote a task to the source: remember what the source now holds. Not undoable. */
  pushed(doc, a: { id: string; taskId?: string; path?: string; hashes: Partial<Record<FieldName, string>> }) {
    const n = doc.get(a?.id);
    if (!isTask(n) || !a.hashes || typeof a.hashes !== 'object') return [];
    const t = task(n);
    const out: Change[] = [ns(n.id, 'base', { ...(t.base ?? {}), ...a.hashes })];
    if (isStr(a.taskId) && a.taskId !== t.taskId) out.push(ns(n.id, 'taskId', a.taskId));
    if (isStr(a.path) && a.path !== t.path) out.push(ns(n.id, 'path', a.path), set(n.id, 'file', a.path));
    return out;
  },

  /**
   * Drag on the board: tasks (or refs, which stand for their task) into column `status` at `index`.
   * A ref dropped on its board goes back into it (the ref is removed).
   */
  move(doc, a: { board: string; ids: string[]; status: string; index: number }) {
    const b = doc.get(a?.board);
    if (!isBoard(b) || !isIds(a.ids) || !isStr(a.status) || !isNum(a.index)) return [];
    const refs: string[] = [];
    const moving: string[] = [];
    for (const id of a.ids) {
      let n = doc.get(id);
      if (isRef(n)) {
        refs.push(id);
        n = doc.get(ref(n).task);
      }
      if (isTask(n) && task(n).board === b.id && !moving.includes(n.id)) moving.push(n.id);
    }
    if (!moving.length) return [];
    const changes = placeInColumn(doc, b.id, a.status, moving, a.index);
    const titles = moving.map((id) => task(doc.get(id)!).taskId ?? task(doc.get(id)!).title);
    return {
      changes: [...changes, ...refs.map((id): Change => ({ op: 'del', id }))],
      events: changes.some((c) => c.op === 'set' && c.key.endsWith('.status')) ? [{ type: 'kanban.move', text: `moved ${titles.join(', ')} to ${a.status}`, targets: moving }] : [],
    };
  },

  /** Edit a task's fields (title, labels, body...). */
  edit(doc, a: { id: string; patch: Partial<TaskFields> }) {
    let n = doc.get(a?.id);
    if (isRef(n)) n = doc.get(ref(n).task);
    if (!isTask(n)) return [];
    const p = cleanFields(a.patch);
    const t = task(n);
    return (Object.keys(p) as FieldName[]).filter((k) => JSON.stringify(t[k] ?? null) !== JSON.stringify(p[k] ?? null)).map((k) => ns(n!.id, k, p[k]));
  },

  /** A new task at the end of a column. The host gives it an id and a file. */
  newTask(doc, a: { board: string; status?: string; title: string }, ctx) {
    const b = doc.get(a?.board);
    if (!isBoard(b) || !isStr(a.title) || !a.title.trim()) return [];
    const status = isStr(a.status) ? a.status : board(b).defaultStatus;
    const last = column(doc, b.id, status).at(-1);
    const lastOrd = last ? task(last).ordinal : 0;
    const f: TaskField = { kind: 'task', board: b.id, title: a.title.trim(), status, labels: [], assignee: [], body: '', ordinal: lastOrd !== undefined ? lastOrd + 1000 : undefined };
    const id = ctx.newId();
    return {
      changes: [{ op: 'add', node: { id, type: 'file', file: '', x: b.x, y: b.y, width: CARD_W, height: CARD_H, [FIELD]: f } }],
      select: [id],
      events: [{ type: 'kanban.new', text: `added task "${f.title}" to ${status}`, targets: [id] }],
    };
  },

  /** A linked reference to a task, top-left at (x, y). */
  ref(doc, a: { task: string; x: number; y: number }, ctx) {
    let n = doc.get(a?.task);
    if (isRef(n)) n = doc.get(ref(n).task);
    if (!isTask(n) || !isNum(a.x) || !isNum(a.y)) return [];
    const id = ctx.newId();
    return { changes: [{ op: 'add', node: { id, type: 'file', file: n.file ?? '', x: Math.round(a.x), y: Math.round(a.y), width: REF_W, height: REF_H, z: doc.topZ + 1, [FIELD]: { kind: 'ref', task: n.id } } }], select: [id] };
  },

  /** Show all cards of a column, or only the first few. */
  expand(doc, a: { id: string; status: string; on: boolean }) {
    const b = doc.get(a?.id);
    if (!isBoard(b) || !isStr(a.status)) return [];
    const cur = board(b).expanded ?? [];
    const next = a.on ? [...new Set([...cur, a.status])] : cur.filter((s) => s !== a.status);
    return next.length === cur.length ? [] : [ns(b.id, 'expanded', next.length ? next : undefined)];
  },

  /** Comparison: the Backlog.md web UI in an iframe. */
  web(doc, a: { x: number; y: number; url: string }, ctx) {
    if (!isNum(a?.x) || !isNum(a?.y) || !isStr(a.url) || !/^https?:\/\//.test(a.url)) return [];
    const id = ctx.newId();
    return { changes: [{ op: 'add', node: { id, type: 'link', url: a.url, x: Math.round(a.x - 560), y: Math.round(a.y - 340), width: 1120, height: 680, z: doc.topZ + 1, [FIELD]: { kind: 'web', url: a.url } } }], select: [id] };
  },
};

/** Duplicate (⌘D): refs copy as refs; tasks and boards are refused. */
export function duplicateRule(n: CanvasNode): CanvasNode | null | undefined {
  // a second task node would be a second copy of one file; a second board would write the same source
  if (isTask(n) || isBoard(n)) return null;
  return undefined;
}

export { REF_W, REF_H };
