import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { parse } from '../../src/core/io';
import { resolveNode } from '../../src/core/query';
import { Store, type DispatchResult } from '../../src/core/store';
import { registerCoreCommands } from '../../src/core/commands';
import type { CanvasDoc, CanvasNode, Change } from '../../src/core/doc';
import type { LogActor } from '../../src/core/log';
import { registerPluginLogic } from '../../src/plugins/logic';
import { after, chatArray, chatMessages, sendChat, type ChatMessage } from '../../src/core/chat';
import { Redirect, type AgentCtx } from '../../src/core/agent';
import { catalog, type Catalog } from './catalog';
import { describeDiff, diffFile, stableSerialize } from './canonical';

// The server's document side, without network or disk (board.ts adds those): one Y.Doc that
// browsers sync with, a Store per actor on that doc (each agent its own undo history and log name),
// and the two-way mapping to the .canvas file text.

/** Who acts through the server. `id` is stable per agent (log, presence, future permissions). */
export interface Actor extends LogActor {
  kind: 'agent' | 'tool' | 'file';
}

/** The file itself as an actor: edits made in an editor, by git (checkout, pull) or a script. */
export const FILE_ACTOR: Actor = { id: 'file', name: 'File', color: '#8a8a8a', kind: 'file' };

/** What `Host.run` gives back: the command's result for the caller, or why it was refused. */
export type RunResult = { ok: true; result: unknown; text?: string; undescribed?: true; changed: number; touched: string[] } | { ok: false; error: string };

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
  /** Per actor: the last chat message it has been shown (outlives its seat, so a re-seated agent loses nothing). */
  private chatSeen = new Map<string, string>();
  /** The file as last written or read: a file edit = its diff from this (3-way merge with the live doc). */
  private base: CanvasDoc | null = null;
  readonly catalog: Catalog = catalog();

  constructor() {
    this.store = this.newStore();
  }

  private newStore() {
    const s = new Store({ ydoc: this.ydoc });
    registerCoreCommands(s);
    registerPluginLogic(s);
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
    for (const s of [...this.seats.values()]) if (now - s.last >= ms) this.unseat(s.actor);
  }

  /** An actor leaves the table now: cursor gone, undo history gone (what it has read of the chat stays). */
  unseat(actor: Actor) {
    const s = this.seats.get(actor.id);
    if (!s) return;
    s.awareness.setLocalState(null);
    for (const fn of this.seatListeners) fn(s.awareness, false);
    s.store.undoManager.destroy();
    s.awareness.destroy(); // its check interval would keep the process (and a closed board) alive
    this.seats.delete(actor.id);
  }

  seated(): Actor[] {
    return [...this.seats.values()].map((s) => s.actor);
  }

  /** Run a command as `actor`: logged under its name, undoable by it alone; its cursor moves to what it touched. */
  dispatch(actor: Actor, name: string, args: unknown): DispatchResult & { touched: string[] } {
    const seat = this.seat(actor);
    const res = seat.store.dispatch(name, args);
    const touched = [...new Set(res.changes.flatMap((c) => (c.op === 'add' ? [c.node.id] : c.op === 'set' || c.op === 'del' ? [c.id] : c.op === 'edge' ? [c.edge.fromNode, c.edge.toNode] : [])))];
    // a command that names what it acted on (a chess move: the piece) points there; else at what it touched
    this.point(seat, res.select?.length ? res.select : touched);
    return { ...res, touched };
  }

  undo(actor: Actor, redo = false): boolean {
    const seat = this.seat(actor);
    let why: string | undefined;
    seat.store.onUndoRefused = (w) => (why = w);
    const done = redo ? seat.store.redo() : seat.store.undo();
    if (!done && why) throw new Error(why);
    return done;
  }

  /**
   * An agent's call of a command by name: args checked against the plugin's spec (errors name the
   * field and give an example), node titles resolved to ids, the plugin's adapter turns them into the
   * command's own args, and the plugin shapes the answer. A command without a spec runs unchecked.
   */
  run(actor: Actor, name: string, args: unknown): RunResult {
    const spec = this.catalog.spec(name);
    if (!spec) {
      if (!this.store.has(name)) return { ok: false, error: this.catalog.unknownError(name, 'command') };
      const r = this.dispatch(actor, name, args ?? {});
      if (!r.ok) return { ok: false, error: r.error ?? 'failed' };
      return { ok: true, undescribed: true, result: { ...(r.select?.[0] ? { id: r.select[0] } : {}), changed: r.changes.length }, changed: r.changes.length, touched: r.touched };
    }
    const checked = this.catalog.validate(name, args);
    if (!checked.ok) return checked;
    this.seat(actor);
    const host = this;
    const ctx: AgentCtx = {
      get doc() {
        return host.store.doc;
      },
      actor,
    };
    let resolved: Record<string, unknown>;
    let target = name;
    let cmdArgs: unknown;
    try {
      resolved = this.catalog.resolveRefs(spec.args, checked.value, this.store.doc);
      const adapted = spec.toCommand ? spec.toCommand(resolved, ctx) : resolved;
      if (adapted instanceof Redirect) {
        target = adapted.command;
        cmdArgs = adapted.args;
      } else cmdArgs = adapted;
    } catch (e) {
      return { ok: false, error: `${name}: ${(e as Error).message}` };
    }
    const r = this.dispatch(actor, target, cmdArgs);
    if (!r.ok) return { ok: false, error: r.error ?? 'failed' };
    try {
      const result = spec.result ? spec.result(r, resolved, ctx) : { ...(r.select?.[0] ? { id: r.select[0] } : {}), changed: r.changes.length };
      return { ok: true, result, text: spec.text?.(result), changed: r.changes.length, touched: r.touched };
    } catch (e) {
      return { ok: false, error: `${name}: done, but reading the result failed: ${(e as Error).message}` };
    }
  }

  /**
   * A plugin's view of the doc for this actor (registered with `store.registerView`): `chess.state`
   * = the game. Reading seats the actor (keeps it at the table while it thinks or waits). Throws on
   * an unknown view or bad args.
   */
  view(actor: Actor, name: string, args: Record<string, unknown> = {}): unknown {
    const spec = this.store.viewSpec(name);
    if (!spec) throw new Error(this.catalog.unknownError(name, 'view'));
    const checked = this.catalog.validate(name, args, 'view');
    if (!checked.ok) throw new Error(checked.error);
    this.seat(actor);
    return spec.read(this.store.doc, this.catalog.resolveRefs(spec.args, checked.value, this.store.doc), actor);
  }

  /**
   * Resolve when `view` gives a value (a "ready" view returns undefined until then: `chess.turn` until
   * it's the actor's move), or with undefined after `ms`. Re-checked after every doc change.
   */
  wait(actor: Actor, name: string, args: Record<string, unknown>, ms: number, signal?: AbortSignal): Promise<unknown> {
    const first = this.view(actor, name, args);
    if (first !== undefined) return Promise.resolve(first);
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const done = (v: unknown, err?: Error) => {
        clearTimeout(timer);
        clearInterval(keep);
        signal?.removeEventListener('abort', onAbort);
        this.ydoc.off('afterTransaction', check);
        if (err) reject(err);
        else resolve(v);
      };
      const check = () => {
        try {
          const v = this.view(actor, name, args);
          if (v !== undefined) done(v);
        } catch (e) {
          done(undefined, e as Error);
        }
      };
      const onAbort = () => done(undefined);
      const timer = setTimeout(() => done(undefined), ms);
      const keep = setInterval(() => this.seat(actor), 30_000); // waiting is being at the table
      signal?.addEventListener('abort', onAbort, { once: true });
      this.ydoc.on('afterTransaction', check);
    });
  }

  // ------------------------------------------------------------ chat

  /** Say something at the table as `actor` (seats it); `node` = a node this is about (the cursor goes there). */
  say(actor: Actor, text: string, node?: string): ChatMessage {
    const seat = this.seat(actor);
    if (node) {
      try {
        node = resolveNode(this.store.doc, node).id; // an id, or a title
      } catch (e) {
        throw new Error((e as Error).message.includes('matches') ? (e as Error).message : `no such node: ${node}`);
      }
    }
    this.chatCursor(actor); // first contact: what was said before isn't "new" to it
    const msg = sendChat(this.ydoc, { id: actor.id, name: actor.name, color: actor.color, kind: actor.kind === 'tool' ? 'tool' : 'agent' }, text, { node });
    if (!msg) throw new Error('nothing to say: the message is empty');
    if (node) this.point(seat, [node]);
    return msg;
  }

  /** The last message the actor has been shown; first contact starts at the end of the chat. */
  private chatCursor(actor: Actor): string {
    if (!this.chatSeen.has(actor.id)) this.chatSeen.set(actor.id, chatMessages(this.ydoc).at(-1)?.id ?? ''); // '' = before the first message
    return this.chatSeen.get(actor.id)!;
  }

  private markSeen(actor: Actor) {
    const last = chatMessages(this.ydoc).at(-1);
    if (last) this.chatSeen.set(actor.id, last.id);
  }

  /** Others' messages since the actor last looked (does not move the cursor). */
  private chatNew(actor: Actor): ChatMessage[] {
    const seen = this.chatCursor(actor);
    return after(chatMessages(this.ydoc), seen).filter((m) => m.from.id !== actor.id);
  }

  /**
   * Read the chat as `actor`: the last `limit` messages, or only the new ones (`onlyNew`). Either
   * way the actor has now seen everything up to the end (what `waitChat` goes by).
   */
  readChat(actor: Actor, opts: { limit?: number; onlyNew?: boolean } = {}): ChatMessage[] {
    this.seat(actor);
    const out = opts.onlyNew ? this.chatNew(actor) : chatMessages(this.ydoc).slice(-Math.max(1, opts.limit ?? 20));
    this.markSeen(actor);
    return out;
  }

  /** How many messages from others the actor has not been shown (does not move its cursor). */
  unreadChat(actor: Actor): number {
    return this.chatNew(actor).length;
  }

  /** Resolve with new messages from others (and mark them seen), or undefined after `ms` or when `signal` aborts (nothing is marked seen then). */
  waitChat(actor: Actor, ms: number, signal?: AbortSignal): Promise<ChatMessage[] | undefined> {
    this.seat(actor);
    const first = this.chatNew(actor);
    if (first.length) {
      this.markSeen(actor);
      return Promise.resolve(first);
    }
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const arr = chatArray(this.ydoc);
      const done = (v?: ChatMessage[]) => {
        clearTimeout(timer);
        clearInterval(keep);
        signal?.removeEventListener('abort', onAbort);
        arr.unobserve(check);
        resolve(v);
      };
      const check = () => {
        const n = this.chatNew(actor);
        if (!n.length) return;
        this.markSeen(actor);
        done(n);
      };
      const onAbort = () => done(undefined);
      const timer = setTimeout(() => done(undefined), ms);
      const keep = setInterval(() => this.seat(actor), 30_000);
      signal?.addEventListener('abort', onAbort, { once: true });
      arr.observe(check);
    });
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
  applyFile(text: string, actor: Actor = FILE_ACTOR, loading = false): string | null {
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
    const line = `${loading ? 'loaded the file' : 'edited the file'}: ${describeDiff(d.summary)}`; // a load is not an edit by anyone
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
