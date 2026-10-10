import * as Y from 'yjs';
import { makeView, type CanvasDoc, type CanvasEdge, type CanvasNode, type Change, type DocView, type LayoutRule, type ParentOf } from './doc';

/** Everything non-deterministic a command may use; injectable for tests / replay. */
export interface CommandCtx {
  newId(): string;
  random(): number;
}

export interface CommandResult {
  changes: Change[];
  /** New selection, if the command wants to set one. */
  select?: string[];
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

/** Origin of transactions made by this client's own commands (undo tracks only these). */
const LOCAL = Symbol('local');
/** Origin of whole-document loads (file open, new table): not undoable. */
const LOAD = Symbol('load');

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
  readonly undoManager: Y.UndoManager;
  private parentRules: ParentOf[] = [];
  private layouts: LayoutRule[] = [];
  readonly importFilters: DocFilter[] = [];
  readonly exportFilters: DocFilter[] = [];
  /** Commands that upgrade older docs in place; run (not undoable) after every load. Must be idempotent. */
  readonly migrations: Command[] = [];
  selection: ReadonlySet<string> = new Set();
  private commands = new Map<string, Command>();
  private listeners = new Set<() => void>();
  private view: DocView | null = null;
  private mergeAll = false;

  ctx: CommandCtx;

  constructor(opts: { ydoc?: Y.Doc; ctx?: CommandCtx } = {}) {
    this.ctx = opts.ctx ?? defaultCtx;
    this.ydoc = opts.ydoc ?? new Y.Doc();
    this.nodes = this.ydoc.getMap('nodes');
    this.edges = this.ydoc.getMap('edges');
    this.meta = this.ydoc.getMap('meta');
    // captureTimeout: we decide grouping ourselves (each dispatch = one undo step unless merged)
    this.undoManager = new Y.UndoManager([this.nodes, this.edges], {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: Number.MAX_SAFE_INTEGER,
    });
    this.ydoc.on('afterTransaction', () => {
      this.view = null;
      this.pruneSelection();
      this.emit();
    });
  }

  // ------------------------------------------------------------ reading

  /** Current read-only snapshot (cached until the next transaction). */
  get doc(): DocView {
    if (!this.view) {
      const nodes = [...this.nodes.values()].map((m) => m.toJSON() as CanvasNode);
      this.view = makeView({ nodes, edges: [...this.edges.values()], extra: this.meta.toJSON() }, this.parentRules, this.layouts);
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

  /** Layouts place contained nodes (derived on read, never stored). */
  addLayout(rule: LayoutRule) {
    this.layouts.push(rule);
    this.view = null;
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
   */
  dispatch<A>(name: string, args: A, opts: { merge?: boolean } = {}): DispatchResult {
    const cmd = this.commands.get(name);
    if (!cmd) return fail(`unknown command: ${name}`);
    let res: CommandResult;
    try {
      const r = cmd(this.doc, args, this.ctx);
      res = Array.isArray(r) ? { changes: r } : r;
    } catch (e) {
      return fail(`${name}: ${(e as Error).message}`);
    }
    if (!opts.merge && !this.mergeAll) this.undoManager.stopCapturing();
    this.apply(res.changes);
    if (res.select) this.select(res.select);
    return { ...res, ok: true };
  }

  /** Apply changes in one local (undoable) transaction. */
  apply(changes: readonly Change[], origin: unknown = LOCAL) {
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
    }, LOAD);
    this.migrate();
    this.undoManager.clear();
    this.selection = new Set();
    this.emit();
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

  undo() {
    this.undoManager.undo();
  }
  redo() {
    this.undoManager.redo();
  }

  // ------------------------------------------------------------ selection (local, not shared)

  select(ids: Iterable<string>) {
    const v = this.doc;
    this.selection = new Set([...ids].filter((id) => v.isVisible(id)));
    this.emit();
  }

  private pruneSelection() {
    if (!this.selection.size) return;
    const v = this.doc;
    const next = [...this.selection].filter((id) => v.isVisible(id));
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
