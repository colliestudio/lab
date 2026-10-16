import type { CanvasNode, Change, DocView } from '../../core';
import { set } from '../../core/doc';
import type { EventSpec, LogActor } from '../../core/log';
import { FIELDS, hashOf, type FieldName } from './markdown';
import { CARD_H, CARD_W, FIELD, board, dirtyFields, isBoard, isTask, syncValues, task, tasksOf, type BoardField, type TaskField } from './model';
import { SourceError, type Card, type CardPatch, type SourceInfo, type TrackerSource } from './source';

// KanbanSync keeps one board node in step with its tracker. It runs where the files are (the canvas
// serve, server/kanban/attach.ts); a browser never has a source. Both directions are field-level:
//
//   base[f]  = hash of what the source held for field f at the last sync
//   doc[f]   = what the board shows (viewers and agents edit this)
//   source[f]= what the tracker holds now
//
//   pull: source changed (hash != base): the source wins; if the doc held a different unsaved value,
//         that is a conflict (kept the file's, said so). Doc != base with the source unchanged = a
//         local edit, left for the push.
//   push: a doc field whose hash != base is written, as one patch per task; base becomes the hash of
//         the card read back, and a value the tracker normalised replaces the doc's, so nothing loops.
//
// The doc is changed only through `host.apply` (one system transaction: not undoable, logged as the
// tracker); commands that viewers run never touch files.

export interface SyncHost {
  doc(): DocView;
  /** Apply changes as the tracker: one transaction, not undoable; the events go to the log. */
  apply(changes: Change[], events: EventSpec[]): void;
  newId(): string;
  /** Runs after every doc change that did not come from `apply`. Returns the stop function. */
  onDocChange(fn: () => void): () => void;
  log?(msg: string): void;
}

export const TRACKER_ACTOR: LogActor = { id: 'file:backlog', name: 'Backlog.md', color: '#8a8a8a' };

const MAX_TEXT = 200_000;
const MAX_COMMENTS = 200;

const ns = (id: string, key: string, v: unknown) => set(id, `${FIELD}.${key}`, v);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const label = (t: TaskField) => t.taskId ?? t.title;

/** A card from a tracker made safe for the doc: bounded sizes, plain values. */
export function cleanCard(c: Card): Card {
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 100) : []);
  return {
    id: s(c.id, 80),
    title: s(c.title, 500),
    column: s(c.column, 100),
    order: typeof c.order === 'number' && Number.isFinite(c.order) ? c.order : undefined,
    labels: strs(c.labels),
    assignee: strs(c.assignee),
    priority: c.priority ? s(c.priority, 20) : undefined,
    parent: c.parent ? s(c.parent, 80) : undefined,
    created: c.created ? s(c.created, 40) : undefined,
    updated: c.updated ? s(c.updated, 40) : undefined,
    url: undefined,
    sections: { description: s(c.sections?.description, MAX_TEXT), plan: s(c.sections?.plan, MAX_TEXT), notes: s(c.sections?.notes, MAX_TEXT) },
    checklist: (c.checklist ?? []).slice(0, 200).map((a) => ({ text: s(a.text, 1000), done: a.done === true })),
    comments: (c.comments ?? []).slice(-MAX_COMMENTS).map((m) => ({ ...(m.author ? { author: s(m.author, 80) } : {}), ...(m.created ? { created: s(m.created, 40) } : {}), text: s(m.text, 20_000) })),
  };
}

/** The synced fields of a card, as the doc holds them. */
export function cardValues(c: Card): Record<FieldName, unknown> {
  return {
    title: c.title,
    status: c.column,
    labels: c.labels,
    assignee: c.assignee,
    priority: c.priority,
    ordinal: c.order,
    description: c.sections.description ?? '',
    plan: c.sections.plan ?? '',
    notes: c.sections.notes ?? '',
    ac: c.checklist,
  };
}

export const hashesOf = (v: Record<FieldName, unknown>) => Object.fromEntries(FIELDS.map((k) => [k, hashOf(v[k])])) as Record<FieldName, string>;

/** What a patch of `fields` of this task writes (the full values; the adapter writes the minimal change). */
export function patchFor(t: TaskField, fields: FieldName[]): CardPatch {
  const v = syncValues(t);
  const p: CardPatch = {};
  for (const k of fields) {
    if (k === 'title') p.title = v.title as string;
    else if (k === 'status') p.column = v.status as string;
    else if (k === 'labels') p.labels = v.labels as string[];
    else if (k === 'assignee') p.assignee = v.assignee as string[];
    else if (k === 'priority') p.priority = (v.priority as string | undefined) ?? null;
    else if (k === 'ordinal') p.order = (v.ordinal as number | undefined) ?? null;
    else if (k === 'ac') p.checklist = v.ac as TaskField['ac'];
    else (p.sections ??= {})[k] = v[k] as string;
  }
  return p;
}

const cardNode = (card: Card, b: CanvasNode, boardId: string, id: string): Change => {
  const vals = cardValues(card);
  const f: TaskField = {
    kind: 'task',
    board: boardId,
    taskId: card.id,
    title: card.title,
    status: card.column,
    ...(card.order !== undefined ? { ordinal: card.order } : {}),
    labels: card.labels,
    assignee: card.assignee,
    ...(card.priority ? { priority: card.priority } : {}),
    description: card.sections.description ?? '',
    plan: card.sections.plan ?? '',
    notes: card.sections.notes ?? '',
    ac: card.checklist,
    ...(card.parent ? { parent: card.parent } : {}),
    ...(card.created ? { created: card.created } : {}),
    ...(card.updated ? { updated: card.updated } : {}),
    comments: card.comments,
    base: hashesOf(vals),
  };
  return { op: 'add', node: { id, type: 'file', file: card.id, x: b.x, y: b.y, width: CARD_W, height: CARD_H, [FIELD]: f } };
};

export interface Pulled {
  changes: Change[];
  events: EventSpec[];
  /** Fields where a board edit lost against the file, per task id. */
  conflicts: { taskId: string; node: string; fields: FieldName[] }[];
}

/**
 * Bring the doc in line with what the source holds now (see the header). `quiet`: the first read of a
 * board, which makes no log entries. Pure: reads the doc, returns changes.
 */
export function pullChanges(doc: DocView, boardId: string, info: SourceInfo, cards: Card[], newId: () => string, quiet = false): Pulled {
  const b = doc.get(boardId);
  const out: Pulled = { changes: [], events: [], conflicts: [] };
  if (!isBoard(b)) return out;
  const bf = board(b);
  const meta: Partial<BoardField> = { name: info.name, columns: info.columns, defaultColumn: info.defaultColumn, doneColumn: info.doneColumn, labels: info.labels, priorities: info.priorities, caps: info.caps };
  for (const [k, v] of Object.entries(meta)) if (!same((bf as unknown as Record<string, unknown>)[k], v)) out.changes.push(ns(b.id, k, v));
  if (info.name !== bf.name) out.changes.push(set(b.id, 'label', info.name));
  if (!bf.state?.live || bf.state.error) out.changes.push(ns(b.id, 'state', { live: true }));

  const nodes = tasksOf(doc, boardId);
  const byId = new Map(nodes.filter((n) => !task(n).pending && task(n).taskId).map((n) => [task(n).taskId!.toUpperCase(), n]));
  const seen = new Set<string>();
  const say = (spec: EventSpec) => !quiet && out.events.push({ ...spec, actor: TRACKER_ACTOR });

  for (const raw of cards) {
    const card = cleanCard(raw);
    if (!card.id) continue;
    const key = card.id.toUpperCase();
    seen.add(key);
    const n = byId.get(key);
    const vals = cardValues(card);
    if (!n) {
      const id = newId();
      out.changes.push(cardNode(card, b, boardId, id));
      say({ type: 'kanban.file', text: `added ${card.id} "${card.title}" (${card.column})`, targets: [id] });
      continue;
    }
    const t = task(n);
    const cur = syncValues(t);
    const hs = hashesOf(vals);
    const base = { ...(t.base ?? {}) } as Partial<Record<FieldName, string>>;
    const changed: FieldName[] = [];
    const lost: FieldName[] = [];
    for (const k of FIELDS) {
      if (t.base && hs[k] === t.base[k]) continue; // the source did not change it since the last sync
      const hd = hashOf(cur[k]);
      base[k] = hs[k];
      if (hd === hs[k]) continue; // the board already shows it
      out.changes.push(ns(n.id, k === 'status' ? 'status' : k, vals[k]));
      if (!t.base) continue; // a node from a reopened file: the source fills it, no quarrel
      changed.push(k);
      if (hd !== t.base[k]) lost.push(k); // the board held a different unsaved value
    }
    if (!same(base, t.base)) out.changes.push(ns(n.id, 'base', base));
    // what only the source knows
    for (const [k, v] of [['parent', card.parent], ['created', card.created], ['updated', card.updated]] as const) if (t[k] !== v) out.changes.push(ns(n.id, k, v));
    if (!same(t.comments ?? [], card.comments)) out.changes.push(ns(n.id, 'comments', card.comments));
    if (n.file !== card.id) out.changes.push(set(n.id, 'file', card.id));
    if (lost.length) {
      const text = `${card.id} ${lost.join(', ')}: changed in the file meanwhile; kept the file's`;
      out.conflicts.push({ taskId: card.id, node: n.id, fields: lost });
      out.changes.push(ns(n.id, 'note', `${lost.join(', ')}: the file changed it meanwhile; kept the file's`));
      say({ type: 'kanban.conflict', text, targets: [n.id], cue: 'pulse' });
    } else if (changed.length) {
      say({
        type: 'kanban.file',
        text: changed.includes('status') ? `moved ${card.id} to ${card.column}${changed.length > 1 ? ` (and ${changed.filter((x) => x !== 'status').join(', ')})` : ''}` : `edited ${card.id} (${changed.join(', ')})`,
        targets: [n.id],
        cue: 'pulse',
      });
    }
  }
  // tasks that left the folder (archived, deleted, a bad git checkout): their cards go
  for (const [key, n] of byId) {
    if (seen.has(key)) continue;
    out.changes.push({ op: 'del', id: n.id });
    say({ type: 'kanban.file', text: `removed ${task(n).taskId} (archived or deleted in the files)`, targets: [] });
  }
  if (out.events.length > 6) {
    const extra = out.events.length - 5;
    out.events = [...out.events.slice(0, 5), { type: 'kanban.file', text: `and ${extra} more changes in the files`, actor: TRACKER_ACTOR }];
  }
  return out;
}

export interface SyncOptions {
  /** Quiet time after a board edit before it is written. Default 150 ms. */
  pushDelayMs?: number;
  now?: () => Date;
}

export class KanbanSync {
  private queue: Promise<void> = Promise.resolve();
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private offDoc: (() => void) | undefined;
  private offWatch: (() => void) | undefined;
  private stopped = false;
  private firstDone = false;
  /** Writes made (tests). */
  writes = 0;
  /** How many full cycles ran (tests). */
  cycles = 0;
  /** Last error told to the board (so it is told once). */
  private told: string | undefined;

  constructor(
    private host: SyncHost,
    readonly boardId: string,
    readonly source: TrackerSource,
    private opts: SyncOptions = {},
  ) {}

  start() {
    this.stopped = false;
    this.offWatch = this.source.watch(() => this.request());
    this.offDoc = this.host.onDocChange(() => this.schedulePush());
    void this.cycle();
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pushTimer);
    this.offDoc?.();
    this.offWatch?.();
    this.offDoc = this.offWatch = undefined;
  }

  /** Resolves when everything queued so far has run (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  private request() {
    if (!this.stopped) void this.cycle();
  }

  private schedulePush() {
    if (this.stopped || !this.firstDone) return;
    const doc = this.host.doc();
    const nodes = tasksOf(doc, this.boardId);
    if (!nodes.some((n) => task(n).pending || task(n).outbox?.length || dirtyFields(task(n)).length)) return;
    clearTimeout(this.pushTimer);
    // pull first: an outside edit of the same field since the last read wins (a full cycle)
    this.pushTimer = setTimeout(() => void this.cycle(), this.opts.pushDelayMs ?? 150);
  }

  /** One pull and one push, behind any running one. */
  cycle(): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        await this.pull();
        await this.push();
        this.cycles++;
      } catch (e) {
        this.fail(e);
      }
    });
    this.queue = run;
    return run;
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  private boardNode() {
    const b = this.host.doc().get(this.boardId);
    return isBoard(b) ? b : undefined;
  }

  /** The board shows a problem (once per message) and nothing else changes. */
  private fail(e: unknown) {
    const msg = e instanceof SourceError ? e.message : `the sync failed: ${(e as Error).message}`;
    this.host.log?.(`kanban ${this.boardId}: ${msg}`);
    const b = this.boardNode();
    if (!b || this.told === msg) return;
    this.told = msg;
    this.host.apply([ns(b.id, 'state', { error: msg })], []);
  }

  async pull() {
    if (!this.boardNode()) return this.stop();
    const { info, cards } = await this.source.list();
    this.told = undefined;
    const b = this.boardNode();
    if (!b) return this.stop();
    const quiet = !board(b).state?.live;
    const res = pullChanges(this.host.doc(), this.boardId, info, cards, () => this.host.newId(), quiet);
    if (info.caps.nextId && this.source.nextId) {
      const next = await this.source.nextId().catch(() => undefined);
      if (next && next !== board(b).nextId) res.changes.push(ns(b.id, 'nextId', next));
    }
    if (res.changes.length || res.events.length) this.host.apply(res.changes, res.events);
    this.firstDone = true;
  }

  async push() {
    for (let guard = 0; guard < 500; guard++) {
      const doc = this.host.doc();
      const b = doc.get(this.boardId);
      if (!isBoard(b) || this.stopped) return;
      const nodes = tasksOf(doc, this.boardId);
      const fresh = nodes.filter((n) => task(n).pending).sort((x, y) => (task(x).ordinal ?? 0) - (task(y).ordinal ?? 0))[0];
      if (fresh) {
        await this.create(fresh);
        continue;
      }
      const dirty = nodes.find((n) => dirtyFields(task(n)).length > 0);
      if (dirty) {
        await this.writeFields(dirty);
        continue;
      }
      const mailed = nodes.find((n) => task(n).outbox?.length);
      if (mailed) {
        await this.sendComment(mailed);
        continue;
      }
      return;
    }
  }

  private error(n: CanvasNode, text: string): EventSpec {
    return { type: 'kanban.error', text, targets: isTask(n) ? [n.id] : [], cue: 'pulse', actor: TRACKER_ACTOR };
  }

  /** A task made on the board: write its file; the id may change if it was taken meanwhile. */
  private async create(n: CanvasNode) {
    const t = task(n);
    const doc = this.host.doc();
    const b = doc.get(this.boardId)!;
    try {
      const card = cleanCard(
        await this.source.create(
          {
            title: t.title,
            column: t.status,
            labels: t.labels,
            assignee: t.assignee,
            priority: t.priority,
            parent: t.parent,
            order: t.ordinal,
            sections: { description: t.description, plan: t.plan, notes: t.notes },
            checklist: t.ac,
            preferId: t.taskId,
          },
          { now: this.now() },
        ),
      );
      this.writes++;
      const cur = this.host.doc().get(n.id);
      if (!isTask(cur)) return; // removed from the board while it was being written: the file stays, the next pull shows it
      const ct = task(cur);
      const mine = syncValues(ct);
      const vals = cardValues(card);
      const changes: Change[] = [ns(n.id, 'pending', undefined), ns(n.id, 'taskId', card.id), set(n.id, 'file', card.id), ns(n.id, 'base', hashesOf(vals))];
      // what the user typed meanwhile stays a local edit (dirty against the new base); the rest takes the stored form
      for (const k of FIELDS) if (hashOf(mine[k]) === hashOf(syncValues({ ...t })[k]) && hashOf(vals[k]) !== hashOf(mine[k])) changes.push(ns(n.id, k, vals[k]));
      for (const [k, v] of [['parent', card.parent], ['created', card.created], ['updated', card.updated]] as const) if (ct[k] !== v) changes.push(ns(n.id, k, v));
      const events: EventSpec[] = [];
      if (card.id !== t.taskId) events.push({ type: 'kanban.file', text: `${t.taskId} was taken meanwhile: "${t.title}" is ${card.id}`, targets: [n.id], actor: TRACKER_ACTOR });
      this.host.apply(changes, events);
    } catch (e) {
      const msg = e instanceof SourceError ? e.message : (e as Error).message;
      this.host.log?.(`kanban ${this.boardId}: could not create "${t.title}": ${msg}`);
      // the task never existed: its card goes, and everyone is told
      this.host.apply([{ op: 'del', id: n.id }], [this.error(n, `could not add "${t.title}": ${msg}`)]);
    }
    void b;
  }

  /** The dirty fields of one task, as one write. */
  private async writeFields(n: CanvasNode) {
    const t = task(n);
    const fields = dirtyFields(t);
    if (!t.taskId || !fields.length) return;
    const wrote = syncValues(t);
    try {
      const card = cleanCard(await this.source.write(t.taskId, patchFor(t, fields), { now: this.now() }));
      this.writes++;
      const cur = this.host.doc().get(n.id);
      if (!isTask(cur)) return;
      const ct = task(cur);
      const vals = cardValues(card);
      const base = { ...(ct.base ?? {}) } as Partial<Record<FieldName, string>>;
      const changes: Change[] = [];
      const now = syncValues(ct);
      for (const k of fields) {
        base[k] = hashOf(vals[k]);
        // still what we wrote (not edited again meanwhile) and the tracker stored it differently: take its form
        if (hashOf(now[k]) === hashOf(wrote[k]) && hashOf(vals[k]) !== hashOf(wrote[k])) changes.push(ns(n.id, k, vals[k]));
      }
      changes.push(ns(n.id, 'base', base));
      for (const [k, v] of [['updated', card.updated]] as const) if (ct[k] !== v) changes.push(ns(n.id, k, v));
      this.host.apply(changes, []);
    } catch (e) {
      await this.revert(n, e, `could not write ${t.taskId}`);
    }
  }

  /** A write failed: the card goes back to the state of the file, everyone is told. */
  private async revert(n: CanvasNode, e: unknown, what: string) {
    const msg = e instanceof SourceError ? e.message : (e as Error).message;
    this.host.log?.(`kanban ${this.boardId}: ${what}: ${msg}`);
    const t = task(n);
    let card: Card | null = null;
    try {
      card = t.taskId ? await this.source.read(t.taskId) : null;
    } catch {
      /* the next pull sorts it out */
    }
    const changes: Change[] = [];
    if (card) {
      const c = cleanCard(card);
      const vals = cardValues(c);
      for (const k of FIELDS) changes.push(ns(n.id, k, vals[k]));
      changes.push(ns(n.id, 'base', hashesOf(vals)));
    } else {
      // nothing to go back to: forget the edits so the push does not retry forever
      const v = syncValues(t);
      changes.push(ns(n.id, 'base', hashesOf(v)));
    }
    this.host.apply(changes, [this.error(n, msg.startsWith('could not') ? msg : `${what}: ${msg}`)]);
  }

  private async sendComment(n: CanvasNode) {
    const t = task(n);
    const next = t.outbox?.[0];
    if (!next || !t.taskId) return;
    let failed: string | undefined;
    let card: Card | undefined;
    try {
      card = cleanCard(await this.source.write(t.taskId, { comment: { author: next.author, text: next.text } }, { now: this.now() }));
      this.writes++;
    } catch (e) {
      failed = e instanceof SourceError ? e.message : (e as Error).message;
      this.host.log?.(`kanban ${this.boardId}: could not comment on ${t.taskId}: ${failed}`);
    }
    const cur = this.host.doc().get(n.id);
    if (!isTask(cur)) return;
    const rest = (task(cur).outbox ?? []).filter((m) => m.key !== next.key);
    const changes: Change[] = [ns(n.id, 'outbox', rest.length ? rest : undefined)];
    if (card) {
      if (!same(task(cur).comments ?? [], card.comments)) changes.push(ns(n.id, 'comments', card.comments));
      if (card.updated && task(cur).updated !== card.updated) changes.push(ns(n.id, 'updated', card.updated));
    }
    this.host.apply(changes, failed ? [this.error(n, `could not comment on ${label(t)}: ${failed}`)] : []);
  }
}
