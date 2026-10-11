import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { parse } from '../src/core/io';
import { Store, type DispatchResult } from '../src/core/store';
import { registerCoreCommands } from '../src/core/commands';
import type { CanvasDoc, CanvasNode, Change } from '../src/core/doc';
import type { LogActor } from '../src/core/log';
import { registerBoardLogic } from '../src/plugins/board/logic';
import { describeDiff, diffFile, stableSerialize } from './canonical';

// The bridge's document side, without network or disk (server.ts adds those): one Y.Doc that
// browsers sync with, a Store per actor on that doc (each agent its own undo history and log name),
// and the two-way mapping to the .canvas file text.

/** Who acts through the bridge. `id` is stable per agent (log, presence, future permissions). */
export interface Actor extends LogActor {
  kind: 'agent' | 'tool' | 'file';
}

/** The file itself as an actor: edits made in an editor, by git (checkout, pull) or a script. */
export const FILE_ACTOR: Actor = { id: 'file', name: 'File', color: '#8a8a8a', kind: 'file' };

const FILE = Symbol('file');
const AGENT_COLORS = ['#d97757', '#6a5acd', '#2e8b57', '#c71585', '#1e90ff'];

export function makeActor(name: string, kind: Actor['kind'] = 'agent'): Actor {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { id: `${kind}:${slug}`, name, color: AGENT_COLORS[h % AGENT_COLORS.length], kind };
}

/** An actor's seat at the table: its own store (undo) and presence (cursor, selection). */
interface Seat {
  actor: Actor;
  store: Store;
  awareness: Awareness;
  last: number;
}

export class Host {
  readonly ydoc = new Y.Doc();
  /** For reads and file applies; never dispatches (agents use their seats). */
  readonly store: Store;
  private seats = new Map<string, Seat>();
  private seatListeners = new Set<(a: Awareness, joined: boolean) => void>();
  /** The file as last written or read: a file edit = its diff from this (3-way merge with the live doc). */
  private base: CanvasDoc | null = null;

  constructor() {
    this.store = this.newStore();
  }

  private newStore() {
    const s = new Store({ ydoc: this.ydoc });
    registerCoreCommands(s);
    registerBoardLogic(s);
    return s;
  }

  /** Called with an actor's awareness when it joins or leaves (the server relays it to browsers). */
  onSeat(fn: (a: Awareness, joined: boolean) => void) {
    this.seatListeners.add(fn);
    return () => this.seatListeners.delete(fn);
  }

  seat(actor: Actor): Seat {
    let s = this.seats.get(actor.id);
    if (!s) {
      const store = this.newStore();
      store.actor = () => actor;
      // its own (empty) doc just for a separate awareness client id: one cursor per agent
      const awareness = new Awareness(new Y.Doc());
      awareness.setLocalState({ user: { id: actor.id, name: actor.name, color: actor.color }, cursor: null, sel: [], held: [] });
      s = { actor, store, awareness, last: Date.now() };
      this.seats.set(actor.id, s);
      for (const fn of this.seatListeners) fn(awareness, true);
    }
    s.last = Date.now();
    return s;
  }

  /** Actors idle longer than `ms` leave the table (their undo history goes with them). */
  sweep(ms: number, now = Date.now()) {
    for (const [id, s] of this.seats) {
      if (now - s.last < ms) continue;
      s.awareness.setLocalState(null);
      for (const fn of this.seatListeners) fn(s.awareness, false);
      s.store.undoManager.destroy();
      this.seats.delete(id);
    }
  }

  seated(): Actor[] {
    return [...this.seats.values()].map((s) => s.actor);
  }

  /** Run a command as `actor`: logged under its name, undoable by it alone; its cursor moves to what it touched. */
  dispatch(actor: Actor, name: string, args: unknown): DispatchResult & { touched: string[] } {
    const seat = this.seat(actor);
    const res = seat.store.dispatch(name, args);
    const touched = [...new Set(res.changes.flatMap((c) => (c.op === 'add' ? [c.node.id] : c.op === 'set' || c.op === 'del' ? [c.id] : c.op === 'edge' ? [c.edge.fromNode, c.edge.toNode] : [])))];
    this.point(seat, touched);
    return { ...res, touched };
  }

  undo(actor: Actor, redo = false): boolean {
    const seat = this.seat(actor);
    const um = seat.store.undoManager;
    const n = (redo ? um.redoStack : um.undoStack).length;
    if (redo) seat.store.redo();
    else seat.store.undo();
    return (redo ? um.redoStack : um.undoStack).length < n;
  }

  /** Show the actor's cursor on (the middle of) the first node it touched, and select them. */
  private point(seat: Seat, ids: string[]) {
    const doc = this.store.doc;
    const ns = ids.map((id) => doc.get(id)).filter((n): n is CanvasNode => !!n);
    const n = ns.find((x) => x.type !== 'group') ?? ns[0];
    if (!n) return;
    seat.awareness.setLocalStateField('cursor', { x: Math.round(n.x + n.width * 0.6), y: Math.round(n.y + n.height * 0.6) });
    seat.awareness.setLocalStateField('sel', ns.map((x) => x.id));
  }

  // ------------------------------------------------------------ the file

  /** Canonical file text for the current doc. */
  fileText(): string {
    return stableSerialize(this.store.exportDoc());
  }

  /** The server wrote (or read) this text: it's the base for the next file edit. */
  written(text: string) {
    this.base = withZ(parse(text));
  }

  /**
   * Bring a file's content into the live doc as field-level changes (not undoable by anyone, logged
   * as the File). Returns the log line, or null when the file says nothing new.
   */
  applyFile(text: string, actor: Actor = FILE_ACTOR): string | null {
    const next = parse(text);
    const v = this.store.doc;
    const cur: CanvasDoc = { nodes: v.nodes, edges: v.edges, extra: v.extra };
    const d = mergeFile(this.base ?? cur, cur, next);
    this.base = withZ(next);
    if (!d.changes.length && !d.extra) return null;
    this.ydoc.transact(() => {
      this.store.apply(d.changes, FILE);
      if (d.extra) {
        const meta = this.store.meta;
        for (const k of [...meta.keys()]) if (!(k in d.extra)) meta.delete(k);
        for (const [k, val] of Object.entries(d.extra)) meta.set(k, val);
      }
    }, FILE);
    const touched = [...d.summary.added, ...d.summary.changed];
    const line = `edited the file: ${describeDiff(d.summary)}`;
    this.store.appendLog([{ type: 'bridge.file', text: line, targets: touched.slice(0, 20), cue: 'pulse', actor }]);
    return line;
  }

  /** Did this transaction come from the file (so writing it back would only echo)? */
  static fromFile(origin: unknown) {
    return origin === FILE;
  }
}

const withZ = (d: CanvasDoc): CanvasDoc => ({ ...d, nodes: d.nodes.map((n, i) => ({ ...n, z: i + 1 })) });

/**
 * A file edit as a 3-way merge: what changed from `base` (the file as the bridge last saw it) to
 * `next` is applied to `cur` (the live doc), so fields players changed meanwhile and the file didn't
 * touch stay. Stacking order comes from the live doc (z values differ between the two).
 */
export function mergeFile(base: CanvasDoc, cur: CanvasDoc, next: CanvasDoc) {
  const fromBase = diffFile(base, next);
  const fromCur = diffFile(cur, next);
  const isZ = (c: Change) => c.op === 'set' && c.key === 'z';
  const reordered = fromBase.changes.some(isZ);
  const addZ = new Map(fromCur.changes.flatMap((c) => (c.op === 'add' ? [[c.node.id, c.node.z] as const] : [])));
  const changes = fromBase.changes
    .filter((c) => !isZ(c))
    .map((c) => (c.op === 'add' && addZ.has(c.node.id) ? { ...c, node: { ...c.node, z: addZ.get(c.node.id) } } : c));
  if (reordered) changes.push(...fromCur.changes.filter(isZ));
  return { ...fromBase, changes };
}
