import { fold, type BoardDirectory } from '../core/directory';
import { DirError } from '../core/errors';
import { makeActor, type Actor } from '../core/host';
import type { Board } from '../core/board';

// MCP sessions of the service: one per connected agent (Claude Code session), each holding the
// boards it has joined. A join is a lease on the board plus a seat at its table (own cursor, undo
// history, log name). No node imports: the transport lives in server/node/mcp.ts.

export interface Join {
  /** The board's stored name. */
  name: string;
  board: Board;
  actor: Actor;
  release: () => void;
  /** Aborted when the session leaves this board: ends its pending waits. */
  abort: AbortController;
}

export const MAX_NAME = 32;

export interface McpOptions {
  /** A session with no open request for this long closes. Default 30 minutes. */
  idleMs?: number;
  /** Most sessions at once. Default 200. */
  max?: number;
  /** How often joined seats are kept at the table. Default 30 s. */
  touchMs?: number;
  /** A seat whose session has had no request for this long can be taken over by a new session joining under the same name (a dead client holds its seat until the idle sweep). Default 2 minutes. */
  takeoverMs?: number;
  now?: () => number;
}

export class McpSession {
  readonly joins = new Map<string, Join>();
  /** Requests and streams in flight: a session with any is not idle. */
  open = 0;
  lastSeen: number;
  readonly abort = new AbortController();
  closed = false;
  /** Set by the transport side: tear down what belongs to it. */
  onClose?: () => void;

  constructor(
    readonly id: string,
    readonly svc: McpService,
  ) {
    this.lastSeen = svc.now();
  }

  touch() {
    this.lastSeen = this.svc.now();
  }

  /** Seat this session at a board as `seat`. Errors are plain text for the agent. */
  async join(board: string, seat: string, o: { create?: boolean } = {}): Promise<Join> {
    const name = (seat ?? '').trim();
    if (!name) throw new Error('a seat name is required: the name the others see on your cursor and in the log');
    if (name.length > MAX_NAME) throw new Error(`the seat name can be at most ${MAX_NAME} characters (got ${name.length})`);
    let lease;
    try {
      lease = await this.svc.directory.acquire(board, { create: o.create });
    } catch (e) {
      if (e instanceof DirError && e.status === 404) throw new Error(`${e.message}; canvas_boards lists the canvases${o.create ? '' : ', create: true makes a new one'}`);
      throw e;
    }
    const key = fold(lease.board.name);
    const actor = makeActor(name);
    // checked after the await: two joins racing for one seat can't both pass
    const mine = this.joins.get(key);
    if (mine) {
      lease.release();
      if (mine.actor.id === actor.id) return mine;
      throw new Error(`already joined "${mine.name}" as ${mine.actor.name}; canvas_leave it first to join under another name`);
    }
    let other = this.svc.holder(key, actor.id, this);
    if (other && !this.closed && this.svc.quiet(other)) {
      // the agent behind that session is gone (or long silent): this one is the same name, so it takes the seat over, with a clean cursor and selection
      other.leave(lease.board.name);
      other = this.svc.holder(key, actor.id, this);
    }
    if (other || this.closed) {
      lease.release();
      throw new Error(this.closed ? 'this session is closed' : `the seat "${actor.name}" on "${lease.board.name}" is taken by another agent that is still active; join under another name`);
    }
    const join: Join = { name: lease.board.name, board: lease.board, actor, release: lease.release, abort: new AbortController() };
    this.joins.set(key, join);
    lease.board.host.seat(actor); // the cursor shows at once
    return join;
  }

  leave(board: string): Join {
    const key = fold(board);
    const join = this.joins.get(key);
    if (!join) throw new Error(`not joined to "${board}"${this.joinedText()}`);
    this.joins.delete(key);
    this.drop(join);
    return join;
  }

  /** The join a tool call is meant for: named, or the only one. */
  resolve(board?: string): Join {
    if (board !== undefined && board !== '') {
      const j = this.joins.get(fold(board));
      if (!j) throw new Error(`not joined to "${board}"${this.joinedText()}`);
      return j;
    }
    if (this.joins.size === 0) throw new Error('join a canvas first: canvas_boards lists them, canvas_join {board, name} seats you');
    if (this.joins.size === 1) return [...this.joins.values()][0];
    throw new Error(`you are joined to several canvases (${this.names()}): say which with the canvas argument`);
  }

  names(): string {
    return [...this.joins.values()].map((j) => j.name).join(', ');
  }

  private joinedText() {
    return this.joins.size ? ` (joined: ${this.names()})` : '; canvas_join {board, name} first';
  }

  private drop(j: Join) {
    j.abort.abort();
    j.board.host.unseat(j.actor);
    j.release();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const j of this.joins.values()) this.drop(j);
    this.joins.clear();
    this.svc.sessions.delete(this.id);
    this.onClose?.();
  }
}

export class McpService {
  readonly sessions = new Map<string, McpSession>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly idleMs: number;
  private readonly max: number;
  private readonly touchMs: number;
  private readonly takeoverMs: number;
  readonly now: () => number;

  constructor(
    readonly directory: BoardDirectory,
    opts: McpOptions = {},
  ) {
    this.idleMs = opts.idleMs ?? 30 * 60_000;
    this.max = opts.max ?? 200;
    this.touchMs = opts.touchMs ?? 30_000;
    this.takeoverMs = opts.takeoverMs ?? 120_000;
    this.now = opts.now ?? Date.now;
  }

  /** Start the timers (seat keep-alive, idle sweep). */
  start() {
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(this.touchMs, () => this.touchSeats());
    every(Math.max(50, Math.min(60_000, this.idleMs / 2)), () => this.sweep());
  }

  /** A new session. When full, the longest idle one makes room; else refused. */
  create(id: string): McpSession {
    if (this.sessions.size >= this.max) {
      const idle = [...this.sessions.values()].filter((s) => s.open === 0).sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!idle) throw new Error('too many MCP sessions');
      idle.close();
    }
    const s = new McpSession(id, this);
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): McpSession | undefined {
    return this.sessions.get(id);
  }

  /** Another session sitting at `board` (folded name) as `actorId`. */
  holder(board: string, actorId: string, except: McpSession): McpSession | undefined {
    for (const s of this.sessions.values()) if (s !== except && s.joins.get(board)?.actor.id === actorId) return s;
    return undefined;
  }

  /** No request in flight and none for `takeoverMs`: its seats may be taken over. */
  quiet(s: McpSession): boolean {
    return s.open === 0 && this.now() - s.lastSeen >= this.takeoverMs;
  }

  /** Joined seats stay at the table while the session lives, however quiet it is. */
  touchSeats() {
    for (const s of this.sessions.values()) for (const j of s.joins.values()) j.board.host.seat(j.actor);
  }

  /** Close sessions with no open request for `idleMs`. */
  sweep(now = this.now()) {
    for (const s of [...this.sessions.values()]) if (s.open === 0 && now - s.lastSeen > this.idleMs) s.close();
  }

  closeAll() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of [...this.sessions.values()]) s.close();
  }
}
