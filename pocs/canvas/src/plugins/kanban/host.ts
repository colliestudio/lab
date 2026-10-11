import type { Store } from '../../core';
import { hashFields, type FieldName, type TaskFields } from './markdown';
import { board, column, dirtyFields, fieldsOf, isBoard, task, tasksOf } from './model';
import type { Source } from './sources';

/**
 * The host side of one board: the tab that holds the folder (or reaches the service). It pulls the
 * source into the doc (outside edits by agents, the CLI, git) and pushes doc edits (anyone's, from
 * any peer) back to the source. Pull before push, one cycle at a time; everyone else just edits the
 * doc. Same shape as a future team server: it would run this loop instead of a browser tab.
 */
export class BoardHost {
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private off: (() => void) | undefined;
  private pulledOnce = false;
  stopped = false;
  /** Last error (shown on the board). */
  error: string | undefined;
  /** Writes made (for status/tests). */
  writes = 0;

  constructor(
    private store: Store,
    readonly boardId: string,
    readonly source: Source,
    private opts: { pollMs?: number; pushDelayMs?: number; now?: () => Date } = {},
  ) {}

  start() {
    const poll = this.opts.pollMs ?? 1500;
    this.cycle();
    if (poll > 0) this.timer = setInterval(() => this.cycle(), poll);
    this.off = this.store.subscribe(() => this.schedulePush());
    return this;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.pushTimer);
    this.off?.();
  }

  /** One pull + push, queued behind any running one. Resolves when it ran. */
  cycle(): Promise<void> {
    return this.enqueue(async () => {
      await this.pull();
      await this.push();
    });
  }

  private schedulePush() {
    if (this.stopped || !this.pulledOnce || !this.hasDirty()) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.enqueue(() => this.push()), this.opts.pushDelayMs ?? 250);
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        await fn();
        this.error = undefined;
      } catch (e) {
        this.error = (e as Error).message;
        console.warn('kanban host:', this.error);
        this.store.dispatch('kanban.pull', { board: this.boardId, tasks: [], error: this.error }, { undoable: false });
      }
    });
    this.queue = run;
    return run;
  }

  private hasDirty() {
    const doc = this.store.doc;
    return tasksOf(doc, this.boardId).some((t) => dirtyFields(task(t)).length > 0);
  }

  async pull() {
    if (!isBoard(this.store.doc.get(this.boardId))) return this.stop();
    const snap = await this.source.read();
    const now = (this.opts.now?.() ?? new Date()).getTime();
    if (!snap) {
      this.pulledOnce = true;
      // keep "synced at" fresh without a doc write every poll: only when it's a minute old
      const b = this.store.doc.get(this.boardId);
      if (b && (board(b).error || now - (board(b).syncedAt ?? 0) > 60_000)) this.store.dispatch('kanban.pull', { board: this.boardId, tasks: [], at: now }, { undoable: false });
      return;
    }
    this.store.dispatch('kanban.pull', { board: this.boardId, meta: snap.meta, tasks: snap.tasks, complete: true, at: now }, { undoable: false });
    this.pulledOnce = true;
  }

  async push() {
    if (!this.pulledOnce) return;
    for (;;) {
      const doc = this.store.doc;
      const t = tasksOf(doc, this.boardId).find((n) => dirtyFields(task(n)).length > 0);
      if (!t) return;
      const f = task(t);
      const dirty = dirtyFields(f);
      const fields: TaskFields = fieldsOf(f);
      const allIds = tasksOf(doc, this.boardId).flatMap((n) => (task(n).taskId ? [task(n).taskId!] : []));
      const res = await this.source.write({ taskId: f.taskId, path: f.path, fields }, dirty, {
        allIds,
        now: this.opts.now?.() ?? new Date(),
        columnOrder: (status) => column(this.store.doc, this.boardId, status).flatMap((n) => (task(n).taskId ? [task(n).taskId!] : [])),
      });
      this.writes++;
      // base = what we wrote; if the source normalised it, the next pull brings its version back
      const written: Partial<TaskFields> = {};
      for (const k of f.taskId ? dirty : (Object.keys(fields) as FieldName[])) (written as Record<string, unknown>)[k] = fields[k];
      const hashes = f.taskId ? hashFields(written) : hashFields(fields);
      this.store.dispatch('kanban.pushed', { id: t.id, taskId: res.taskId, path: res.path, hashes }, { undoable: false });
      if (this.stopped) return;
      // a node that is still dirty with the same fields after its push would loop: stop here
      const after = this.store.doc.get(t.id);
      if (after && JSON.stringify(dirtyFields(task(after))) === JSON.stringify(dirty) && JSON.stringify(fieldsOf(task(after))) === JSON.stringify(fields)) return;
    }
  }
}
