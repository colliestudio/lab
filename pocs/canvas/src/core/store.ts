import * as Y from 'yjs';
import { makeView, type CanvasDoc, type CanvasEdge, type CanvasNode, type Change, type CarrierOf, type DocView, type DuplicateRule, type LayoutRule, type ParentOf } from './doc';
import { KEY_WINDOW, LOG_CAP, cleanEvent, type EventSpec, type Events, type LogActor, type LogEvent } from './log';

/** Everything non-deterministic a command may use; injectable for tests / replay. */
export interface CommandCtx {
  newId(): string;
  random(): number;
  /** Clock for log entries (ms epoch); default Date.now. */
  now?(): number;
  /**
   * Who runs this command (set by `dispatch` from `Store.actor`): lets a plugin enforce seats, e.g.
   * only the player seated as white moves white. Absent when nobody is known (tests, repairs).
   */
  actor?: LogActor | null;
}

export interface CommandResult {
  changes: Change[];
  /** New selection, if the command wants to set one. */
  select?: string[];
  /** What to log (see log.ts). Appended after the changes, never an undo step of its own. */
  events?: Events;
  /**
   * Changes that go with this command but stay when it is undone (time: a game clock that a table
   * reset put back must not come back running with a stale start time). Applied first, not undoable.
   */
  untracked?: Change[];
}

/**
 * A command reads a read-only DocView and returns changes. It never mutates and should not throw:
 * bad args → return [] (the store also catches throws and turns them into a failed result).
 */
export type Command<A = any> = (doc: DocView, args: A, ctx: CommandCtx) => CommandResult | Change[];

export interface DispatchResult extends CommandResult {
  ok: boolean;
  error?: string;
}

/** Transform a plain doc on import (repair) or export (e.g. place hidden children). */
export type DocFilter = (doc: CanvasDoc, ctx: CommandCtx) => CanvasDoc;

export function newId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export const defaultCtx: CommandCtx = { newId, random: Math.random };

/** Origin of whole-document loads (file open, new table): not undoable. */
const LOAD = Symbol('load');
/** Origin of local commands that can't be undone (a game clock: time doesn't go back). */
const UNDOABLE_NOT = Symbol('not-undoable');
/** Origin of log appends (not tracked by undo: the log is outside the undo scope anyway). */
const LOG = Symbol('log');
/** Origin of repairs after an undo/redo or a remote change (see `repairs`): not undoable, never repaired again. */
const REPAIR = Symbol('repair');
/** Undo stack item meta: the public texts / targets of the events logged in that step. */
const STEP_EVENTS = 'events';
/** Undo stack item meta: ids of the nodes the step changed (for `undoGuards`). */
const STEP_IDS = 'ids';
/** Undo stack item meta: the step restores a whole table (reset), whatever it touched. */
const STEP_WHOLE = 'whole';
type StepEvent = { text: string; targets?: string[] };

type YNode = Y.Map<unknown>;

/** Plugin namespace fields that hold plain objects are stored as nested Y.Maps (per-field merges). */
const isNested = (key: string, v: unknown): v is Record<string, unknown> =>
  key.startsWith('x-') && !!v && typeof v === 'object' && !Array.isArray(v);

function toY(node: CanvasNode): YNode {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(node)) {
    if (v === undefined) continue;
    if (isNested(k, v)) {
      const sub = new Y.Map<unknown>();
      for (const [sk, sv] of Object.entries(v)) if (sv !== undefined) sub.set(sk, sv);
      m.set(k, sub);
    } else m.set(k, v);
  }
  return m;
}

export class Store {
  readonly ydoc: Y.Doc;
  readonly nodes: Y.Map<YNode>;
  readonly edges: Y.Map<CanvasEdge>;
  readonly meta: Y.Map<unknown>;
  /** The event log, synced like the doc (newest last, capped at LOG_CAP). */
  readonly log: Y.Array<LogEvent>;
  /** Who is acting on this device (log entries); null = nobody known. Set by App. */
  actor: () => LogActor | null = () => null;
  readonly undoManager: Y.UndoManager;
  private parentRules: ParentOf[] = [];
  private riderRules: CarrierOf[] = [];
  private layouts: LayoutRule[] = [];
  readonly importFilters: DocFilter[] = [];
  readonly exportFilters: DocFilter[] = [];
  /** How `core.duplicate` copies plugin objects (see DuplicateRule). */
  readonly duplicateRules: DuplicateRule[] = [];
  /** Per-plugin "back to the starting state" commands, run together by `core.reset` (one undo step). */
  readonly resets: Command[] = [];
  /**
   * Per-plugin fixes for states no command makes but a merge can: an undo/redo that could only
   * partly restore its step (Yjs never overwrites what another player, or a not-undoable command,
   * changed since: a piece gets its square back but stays where the other player moved the board),
   * or two players' concurrent changes (two pieces dropped on one square). Run after every undo/redo
   * and remote change with the ids of the nodes it touched; changes apply not undoable. `undo` says
   * which: after a remote change every peer runs them, so they must depend on the doc only
   * (deterministic, idempotent) and leave alone what another player is in the middle of (a drag).
   */
  readonly repairs: Command<{ ids: string[]; undo: boolean }>[] = [];
  /**
   * A plugin can guard nodes it keeps consistent itself (a chess game: undoing one side's move after
   * the other replied leaves the game fields wrong). Return the reason (shown to the player) for a
   * guarded node. An undo whose top step changed only guarded nodes skips that step and goes on to
   * the one below; `core.reset` is always undone whole.
   */
  readonly undoGuards: ((id: string, doc: DocView) => string | undefined)[] = [];
  /** Told why an undo/redo was refused (the app shows it). */
  onUndoRefused?: (reason: string) => void;
  /** Commands that upgrade older docs in place; run (not undoable) after every load. Must be idempotent. */
  readonly migrations: Command[] = [];
  /** Selected node ids, and edge ids (an edge can be picked; commands that take node ids ignore it). */
  selection: ReadonlySet<string> = new Set();
  private commands = new Map<string, Command>();
  private listeners = new Set<() => void>();
  private view: DocView | null = null;
  /** Plain copies of nodes, kept until that node changes (a drag rewrites one node, not all of them). */
  private json = new Map<string, CanvasNode>();
  private mergeAll = false;
  /** Ids of the nodes the current transaction touched (for `repairs`). */
  private touched = new Set<string>();

  ctx: CommandCtx;
  /**
   * Origin of transactions made by this store's own commands (undo tracks only these). Per store, so
   * several stores can share one Y.Doc with separate undo histories (the bridge: one per agent).
   */
  private readonly local = Symbol('local');

  constructor(opts: { ydoc?: Y.Doc; ctx?: CommandCtx } = {}) {
    this.ctx = opts.ctx ?? defaultCtx;
    this.ydoc = opts.ydoc ?? new Y.Doc();
    this.nodes = this.ydoc.getMap('nodes');
    this.edges = this.ydoc.getMap('edges');
    this.meta = this.ydoc.getMap('meta');
    this.log = this.ydoc.getArray('log');
    // captureTimeout: we decide grouping ourselves (each dispatch = one undo step unless merged)
    this.undoManager = new Y.UndoManager([this.nodes, this.edges], {
      trackedOrigins: new Set([this.local]),
      captureTimeout: Number.MAX_SAFE_INTEGER,
    });
    // observers run before afterTransaction: drop the plain copies of nodes that changed
    this.nodes.observeDeep((events) => {
      for (const e of events) {
        const ids = e.target === this.nodes ? [...e.changes.keys.keys()] : [e.path[0] as string];
        for (const id of ids) {
          this.json.delete(id);
          this.touched.add(id);
        }
      }
    });
    this.ydoc.on('afterTransaction', (tr: Y.Transaction) => {
      this.view = null;
      const ids = [...this.touched];
      this.touched.clear();
      // a remote change: every peer repairs (a transaction made here runs right after this one)
      if (ids.length && !tr.local) this.apply(this.repair(ids, false), REPAIR);
      this.pruneSelection();
      this.emit();
    });
  }

  // ------------------------------------------------------------ reading

  /** Current read-only snapshot (cached until the next transaction). */
  get doc(): DocView {
    if (!this.view) {
      const nodes: CanvasNode[] = [];
      for (const [id, m] of this.nodes) {
        let n = this.json.get(id);
        if (!n) this.json.set(id, (n = m.toJSON() as CanvasNode));
        nodes.push(n);
      }
      this.view = makeView({ nodes, edges: [...this.edges.values()], extra: this.meta.toJSON() }, this.parentRules, this.layouts, this.riderRules);
    }
    return this.view;
  }

  /** Plain JSON Canvas document: nodes in z order without `z`, export filters applied. */
  exportDoc(): CanvasDoc {
    const v = this.doc;
    let doc: CanvasDoc = { nodes: v.nodes, edges: v.edges, extra: v.extra };
    for (const f of this.exportFilters) doc = f(doc, this.ctx);
    return { ...doc, nodes: doc.nodes.map(({ z: _z, ...n }) => n) };
  }

  addParentRule(rule: ParentOf) {
    this.parentRules.push(rule);
    this.view = null;
  }

  addRiderRule(rule: CarrierOf) {
    this.riderRules.push(rule);
    this.view = null;
  }

  /** Layouts place contained nodes (derived on read, never stored). */
  addLayout(rule: LayoutRule) {
    this.layouts.push(rule);
    this.view = null;
  }

  /**
   * Read another doc the way this app reads its own: a store over a second Y.Doc (a portal into
   * another room) takes the containment, rider and layout rules from `from` (the app's store).
   * Commands, repairs and migrations stay behind: such a store is for reading.
   */
  adoptViewRules(from: Store) {
    this.parentRules = from.parentRules;
    this.riderRules = from.riderRules;
    this.layouts = from.layouts;
    this.view = null;
  }

  /** Rules changed without a transaction (e.g. a rule that reads local state): rebuild the snapshot and redraw. */
  invalidate() {
    this.view = null;
    this.emit();
  }

  // ------------------------------------------------------------ commands

  register(name: string, cmd: Command) {
    if (this.commands.has(name)) throw new Error(`command already registered: ${name}`);
    this.commands.set(name, cmd);
  }

  has(name: string) {
    return this.commands.has(name);
  }

  /**
   * Run a command and apply its changes in one transaction (one undo step).
   * `merge: true` folds this into the previous undo step (e.g. the moves of one drag).
   * `undoable: false` keeps it out of undo history (it syncs like any change).
   */
  dispatch<A>(name: string, args: A, opts: { merge?: boolean; undoable?: boolean } = {}): DispatchResult {
    const cmd = this.commands.get(name);
    if (!cmd) return fail(`unknown command: ${name}`);
    let res: CommandResult;
    try {
      const r = cmd(this.doc, args, { ...this.ctx, actor: this.actor() });
      res = Array.isArray(r) ? { changes: r } : r;
    } catch (e) {
      return fail(`${name}: ${(e as Error).message}`);
    }
    const merge = !!opts.merge || this.mergeAll;
    const top = this.undoManager.undoStack.at(-1);
    if (res.untracked?.length) this.apply(res.untracked, UNDOABLE_NOT);
    if (opts.undoable === false) this.apply(res.changes, UNDOABLE_NOT);
    else {
      if (!merge) this.undoManager.stopCapturing();
      this.apply(res.changes);
    }
    // the undo step this dispatch made (or joined), if it made one
    const item = this.undoManager.undoStack.at(-1);
    const step = opts.undoable !== false && res.changes.length > 0 && !!item && (item !== top || merge) ? item : undefined;
    if (item && opts.undoable !== false && res.changes.length > 0 && (item !== top || merge)) {
      const ids = new Set((item.meta.get(STEP_IDS) as string[] | undefined) ?? []);
      for (const c of res.changes) {
        if (c.op === 'add') ids.add(c.node.id);
        else if (c.op === 'set' || c.op === 'del') ids.add(c.id);
      }
      item.meta.set(STEP_IDS, [...ids]);
    }
    if (name === 'core.reset' && item && (item !== top || merge)) item.meta.set(STEP_WHOLE, true);
    if (res.events) this.record(res.events, step);
    if (res.select) this.select(res.select);
    return { ...res, ok: true };
  }

  /** Log a command's events (computed against the doc after its changes); `step`: remember them on the undo step. */
  private record(events: Events, step: { meta: Map<string, unknown> } | undefined) {
    let specs: EventSpec[];
    try {
      specs = typeof events === 'function' ? events(this.doc) : events;
    } catch (e) {
      console.warn(`event: ${(e as Error).message}`);
      return;
    }
    if (!specs.length) return;
    if (step) {
      const prev = (step.meta.get(STEP_EVENTS) as StepEvent[] | undefined) ?? [];
      step.meta.set(STEP_EVENTS, [...prev, ...specs.map((e) => ({ text: e.text, targets: e.targets }))]);
    }
    this.appendLog(specs);
  }

  /** Append entries to the log (one transaction, not undoable), dropping repeats of a recent `key` and the oldest past the cap. */
  appendLog(specs: EventSpec[]) {
    const me = this.actor();
    const now = this.ctx.now?.() ?? Date.now();
    const recent = this.log.slice(Math.max(0, this.log.length - 20));
    const items: LogEvent[] = [];
    for (const { actor, ...s } of specs) {
      const who = actor === undefined ? me : actor;
      if (s.key && [...recent, ...items].some((e) => e.key === s.key && e.actor?.id === who?.id && now - e.time < KEY_WINDOW)) continue;
      items.push(cleanEvent({ ...s, id: this.ctx.newId(), time: now, actor: who ? { id: who.id, name: who.name, color: who.color } : null }));
    }
    if (!items.length) return;
    this.ydoc.transact(() => {
      this.log.push(items);
      const over = this.log.length - LOG_CAP;
      if (over > 0) this.log.delete(0, over);
    }, LOG);
  }

  /** Apply changes in one local (undoable) transaction. */
  apply(changes: readonly Change[], origin: unknown = this.local) {
    if (!changes.length) return;
    this.ydoc.transact(() => {
      for (const c of changes) this.applyOne(c);
    }, origin);
  }

  private applyOne(c: Change) {
    switch (c.op) {
      case 'add':
        this.nodes.set(c.node.id, toY(c.node));
        return;
      case 'del':
        this.nodes.delete(c.id);
        for (const [id, e] of this.edges) if (e.fromNode === c.id || e.toNode === c.id) this.edges.delete(id);
        return;
      case 'edge': {
        const e = c.edge;
        if (!this.nodes.has(e.fromNode) || !this.nodes.has(e.toNode)) return;
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(e)) if (v !== undefined) clean[k] = v;
        this.edges.set(e.id, clean as unknown as CanvasEdge);
        return;
      }
      case 'unedge':
        this.edges.delete(c.id);
        return;
      case 'set': {
        // A node deleted (maybe concurrently) stays deleted: never resurrect it through a set.
        const node = this.nodes.get(c.id);
        if (!node) return;
        const dot = c.key.indexOf('.');
        if (dot < 0) {
          if (c.value === undefined) node.delete(c.key);
          else node.set(c.key, c.value);
          return;
        }
        const ns = c.key.slice(0, dot);
        const field = c.key.slice(dot + 1);
        let sub = node.get(ns);
        if (!(sub instanceof Y.Map)) {
          if (c.value === undefined) return;
          sub = new Y.Map<unknown>();
          node.set(ns, sub);
        }
        const m = sub as Y.Map<unknown>;
        if (c.value === undefined) m.delete(field);
        else m.set(field, c.value);
        return;
      }
    }
  }

  /** Replace the whole document (file open, new table). Not undoable; clears undo history. */
  load(doc: CanvasDoc) {
    let d = doc;
    for (const f of this.importFilters) d = f(d, this.ctx);
    this.ydoc.transact(() => {
      this.nodes.clear();
      this.edges.clear();
      this.meta.clear();
      d.nodes.forEach((n, i) => this.nodes.set(n.id, toY({ ...n, z: n.z ?? i + 1 })));
      for (const e of d.edges) this.edges.set(e.id, e);
      for (const [k, v] of Object.entries(d.extra ?? {})) this.meta.set(k, v);
      if (this.log.length) this.log.delete(0, this.log.length); // a new table starts a new log
    }, LOAD);
    this.migrate();
    this.undoManager.clear();
    this.selection = new Set();
    this.emit();
  }

  /** The changes `repairs` want for nodes `ids` (against the current doc). */
  private repair(ids: string[], undo: boolean): Change[] {
    return this.repairs.flatMap((cmd) => {
      try {
        const r = cmd(this.doc, { ids, undo }, this.ctx);
        return Array.isArray(r) ? r : r.changes;
      } catch (e) {
        console.warn(`repair: ${(e as Error).message}`);
        return [];
      }
    });
  }

  /** Ids of the nodes a transaction (still open) changed so far. */
  private changedIds(tr: Y.Transaction): string[] {
    const ids = new Set<string>();
    for (const [type, keys] of tr.changed) {
      if (type === (this.nodes as unknown)) {
        for (const k of keys) if (k !== null) ids.add(k);
        continue;
      }
      // a node's own map, or a plugin namespace map inside it: walk up to the node
      let t: Y.AbstractType<unknown> | null = type as Y.AbstractType<unknown>;
      while (t && t._item && t._item.parent !== this.nodes) t = t._item.parent as Y.AbstractType<unknown>;
      if (t?._item?.parentSub) ids.add(t._item.parentSub);
    }
    return [...ids];
  }

  /** Run migrations on the current doc (after loading from a file or local storage). */
  migrate() {
    for (const m of this.migrations) {
      const r = m(this.doc, {}, this.ctx);
      this.apply(Array.isArray(r) ? r : r.changes, LOAD);
    }
  }

  /** Start a new undo step: the next dispatches with `merge: true` join it. */
  newUndoStep() {
    this.undoManager.stopCapturing();
  }
  /** Run `fn`; every dispatch inside joins the current undo step. */
  merged(fn: () => void) {
    const prev = this.mergeAll;
    this.mergeAll = true;
    try {
      fn();
    } finally {
      this.mergeAll = prev;
    }
  }

  /**
   * Undo / redo my last step. A step that logged events logs "undid: …" / "redid: …" (public texts),
   * so the log keeps telling what happened; the original entries stay.
   */
  undo(): boolean {
    return this.step('undo');
  }
  redo(): boolean {
    return this.step('redo');
  }
  /**
   * Why a step is not undoable (see `undoGuards`), if it is. Only a step whose every changed node is
   * guarded counts: a step that also changed other things (a table reset) is restored as a whole.
   */
  private guardedStep(item: { meta: Map<string, unknown> } | undefined): string | undefined {
    const ids = item?.meta.get(STEP_IDS) as string[] | undefined;
    if (!ids?.length || item?.meta.get(STEP_WHOLE)) return;
    let why: string | undefined;
    for (const id of ids) {
      const w = this.undoGuards.map((g) => g(id, this.doc)).find(Boolean);
      if (!w) return;
      why ??= w;
    }
    return why;
  }
  /** Why the next undo/redo would skip the top step, if it would. */
  undoBlocked(kind: 'undo' | 'redo' = 'undo'): string | undefined {
    return this.guardedStep((kind === 'undo' ? this.undoManager.undoStack : this.undoManager.redoStack).at(-1));
  }
  /**
   * Undoes exactly the top step. Yjs would pop on until a step changes something, so a step whose
   * edits another player overwrote would be dropped silently and the one before it undone instead:
   * hide the rest of the stack, and report false when the top step had nothing left to revert.
   */
  private step(kind: 'undo' | 'redo'): boolean {
    const um = this.undoManager;
    const [from, to] = kind === 'undo' ? [um.undoStack, um.redoStack] : [um.redoStack, um.undoStack];
    // Steps a plugin guards are skipped (dropped from this history), so they don't block the ones below.
    let skipped: string | undefined;
    for (let top = from.at(-1), why = this.guardedStep(top); top && why; top = from.at(-1), why = this.guardedStep(top)) {
      skipped ??= why;
      from.pop();
    }
    if (skipped) this.onUndoRefused?.(skipped);
    if (!from.length) return false;
    const events = from.at(-1)?.meta.get(STEP_EVENTS) as StepEvent[] | undefined;
    const stepIds = from.at(-1)?.meta.get(STEP_IDS);
    let done = false;
    const rest = from.splice(0, Math.max(from.length - 1, 0));
    // The undo and its repairs in one transaction: one update for the other players (they never see
    // the half-restored state and repair it their own way) and one step on the redo (undo) stack.
    try {
      this.ydoc.transact((tr) => {
        done = !!(kind === 'undo' ? um.undo() : um.redo());
        if (!done) return;
        // the undo manager files this transaction when it ends: as the undo (redo) of the step it just popped
        um.undoing = kind === 'undo';
        um.redoing = kind === 'redo';
        if (!this.repairs.length) return;
        const ids = this.changedIds(tr);
        for (const id of ids) this.json.delete(id);
        this.view = null; // read the restored state
        for (const c of this.repair(ids, true)) this.applyOne(c);
      }, um);
    } finally {
      um.undoing = false;
      um.redoing = false;
      from.unshift(...rest);
    }
    if (!done) return false;
    if (stepIds) to.at(-1)?.meta.set(STEP_IDS, stepIds);
    if (!events?.length) return true;
    to.at(-1)?.meta.set(STEP_EVENTS, events);
    const targets = [...new Set(events.flatMap((e) => e.targets ?? []))];
    this.appendLog([{ type: `core.${kind}`, text: `${kind === 'undo' ? 'undid' : 'redid'}: ${events.map((e) => e.text).join('; ')}`, targets }]);
    return true;
  }

  // ------------------------------------------------------------ selection (local, not shared)

  select(ids: Iterable<string>) {
    const v = this.doc;
    this.selection = new Set([...ids].filter((id) => v.isVisible(id) || !!v.edge(id)));
    this.emit();
  }

  private pruneSelection() {
    if (!this.selection.size) return;
    const v = this.doc;
    const next = [...this.selection].filter((id) => v.isVisible(id) || !!v.edge(id));
    if (next.length !== this.selection.size) this.selection = new Set(next);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

function fail(error: string): DispatchResult {
  console.warn(error);
  return { ok: false, error, changes: [] };
}
