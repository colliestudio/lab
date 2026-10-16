import { FORMAT_KEY, FORMAT_VERSION, FormatError } from '../../src/core/format';
import { Board } from './board';
import { stableSerialize } from './canonical';
import { DirError } from './errors';
import type { BoardStorage } from './storage';
import type { Log } from './transport';

export { DirError } from './errors';

// All the boards of one storage: listed from storage, loaded on first use, unloaded when idle.
// One Board per name in memory, so two clients of a board always share one document.

export interface DirectoryOptions {
  /** A board with no connection, lease or pending write for this long is unloaded. Default 10 minutes. */
  idleMs?: number;
  /** How often idle boards are looked for. Default 10 s; 0 = never (call `sweep`). */
  sweepMs?: number;
  /** Passed to each board. */
  seatIdleMs?: number;
  log?: Log;
  /** Start each board's log lines with [name]. Default true (false when there is only one board). */
  prefix?: boolean;
  /** Boards that never unload (bridge mode: the one board it serves). */
  pinned?: string[];
}

export interface BoardEntry {
  name: string;
  loaded: boolean;
  browsers: number;
  modified?: number;
  /** Why the board can't be opened (a newer format), once an open has failed. */
  error?: string;
}

const fold = (name: string) => name.toLowerCase();

/** Why `name` can't be a board name, or undefined when it can. Names are file stems, never paths. */
export function validName(name: string): string | undefined {
  if (typeof name !== 'string' || !name.trim()) return 'a board name can not be empty';
  if (name !== name.trim()) return 'a board name can not start or end with a space';
  if (name.length > 100) return 'a board name can be at most 100 characters';
  if (/[/\\:\u0000-\u001f\u007f]/.test(name)) return 'a board name can not contain / \\ : or control characters';
  if (name.startsWith('.')) return 'a board name can not start with a dot';
  return undefined;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export class BoardDirectory {
  private boards = new Map<string, Board>();
  /** Per name: operations that load, unload or move a board run one at a time. */
  private locks = new Map<string, Promise<unknown>>();
  private errors = new Map<string, { error: string; at: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly idleMs: number;
  private readonly pinned: Set<string>;
  private readonly log: Log;

  constructor(
    private storage: BoardStorage,
    private opts: DirectoryOptions = {},
  ) {
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.pinned = new Set((opts.pinned ?? []).map(fold));
    this.log = opts.log ?? ((...m) => console.log(new Date().toISOString().slice(11, 19), ...m));
    const every = opts.sweepMs ?? 10_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.sweep().catch((e) => this.log(`sweep: ${(e as Error).message}`)), every);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  get mutable(): boolean {
    return this.storage.mutable;
  }

  // ------------------------------------------------------------ reading

  /** Every board in storage with its loaded state. Reads no board. */
  async list(): Promise<BoardEntry[]> {
    const infos = await this.storage.list();
    return infos
      .map((i): BoardEntry => {
        const b = this.boards.get(fold(i.name));
        const err = this.errors.get(fold(i.name));
        return {
          name: i.name,
          loaded: !!b,
          browsers: b?.browsers ?? 0,
          modified: i.modified,
          ...(err && !(i.modified && i.modified > err.at) ? { error: err.error } : {}),
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The loaded board, if any (no load). */
  loaded(name: string): Board | undefined {
    return this.boards.get(fold(name));
  }

  /** The loaded boards. */
  all(): Board[] {
    return [...this.boards.values()];
  }

  // ------------------------------------------------------------ opening

  /** The board, loaded on first use. Throws DirError 404 (unless `create`) and FormatError. No lease: see `use` and `Board.hold`. */
  async open(name: string, o: { create?: boolean } = {}): Promise<Board> {
    const { board, release } = await this.acquire(name, o);
    release();
    return board;
  }

  /** Open a board and hold it for the duration of `fn` (an HTTP request), so it can't unload meanwhile. */
  async use<T>(name: string, fn: (b: Board) => Promise<T>): Promise<T> {
    const { board, release } = await this.acquire(name, {});
    try {
      return await fn(board);
    } finally {
      release();
    }
  }

  /** Open and take a lease in one step: nothing can unload the board between the two. */
  async acquire(name: string, o: { create?: boolean } = {}): Promise<{ board: Board; release: () => void }> {
    const key = fold(name);
    const bad = this.pinned.has(key) ? undefined : validName(name); // a pinned name is a file the operator chose
    if (bad) throw new DirError(400, bad);
    const hit = this.boards.get(key);
    if (hit) return { board: hit, release: hit.hold() };
    return this.locked([key], async () => {
      const again = this.boards.get(key);
      if (again) return { board: again, release: again.hold() };
      let board: Board;
      try {
        board = await Board.load(name, this.storage, { create: o.create, log: this.prefixed(name), seatIdleMs: this.opts.seatIdleMs });
      } catch (e) {
        if (e instanceof FormatError) this.errors.set(key, { error: e.message, at: Date.now() });
        throw e;
      }
      this.errors.delete(key);
      this.boards.set(key, board);
      return { board, release: board.hold() };
    });
  }

  private prefixed(name: string): Log {
    const log = this.log;
    return this.opts.prefix === false ? log : (...m) => log(`[${name}]`, ...m);
  }

  // ------------------------------------------------------------ changing the set of boards

  /** A new empty board. DirError 400 (bad name), 405 (storage has one fixed board), 409 (exists, in any letter case). */
  async create(name: string): Promise<string> {
    name = name.trim();
    const bad = validName(name);
    if (bad) throw new DirError(400, bad);
    this.mustBeMutable();
    return this.locked([fold(name)], async () => {
      await this.mustNotExist(name);
      const empty = stableSerialize({ nodes: [], edges: [], extra: { [FORMAT_KEY]: FORMAT_VERSION } });
      if (!(await this.storage.create(name, empty))) throw new DirError(409, `a board named "${name}" already exists`);
      return name;
    });
  }

  /** DirError 404 (no such board), 409 (target exists, or the board is open). */
  async rename(from: string, to: string): Promise<string> {
    to = to.trim();
    const bad = validName(to);
    if (bad) throw new DirError(400, bad);
    this.mustBeMutable();
    return this.locked([fold(from), fold(to)], async () => {
      const actual = await this.mustExist(from);
      if (to === actual) return to;
      await this.mustNotExist(to, actual);
      await this.unloadForChange(actual);
      await this.storage.rename(actual, to);
      this.errors.delete(fold(actual));
      return to;
    });
  }

  /** The folder driver moves the board to its trash. DirError 404, 409 (the board is open). */
  async remove(name: string): Promise<void> {
    this.mustBeMutable();
    await this.locked([fold(name)], async () => {
      const actual = await this.mustExist(name);
      await this.unloadForChange(actual);
      await this.storage.remove(actual);
      this.errors.delete(fold(actual));
    });
  }

  private mustBeMutable() {
    if (!this.storage.mutable) throw new DirError(405, 'this server serves one fixed board: it can not create, rename or delete boards');
  }

  private async mustExist(name: string): Promise<string> {
    const found = (await this.storage.list()).find((i) => fold(i.name) === fold(name));
    if (!found) throw new DirError(404, `no board "${name}"`);
    return found.name;
  }

  private async mustNotExist(name: string, except?: string) {
    const clash = (await this.storage.list()).find((i) => fold(i.name) === fold(name) && i.name !== except);
    if (clash) throw new DirError(409, `a board named "${clash.name}" already exists`);
  }

  /** A board about to be renamed or deleted: refused while anyone has it open, else flushed and unloaded. */
  private async unloadForChange(name: string) {
    const b = this.boards.get(fold(name));
    if (!b) return;
    if (this.pinned.has(fold(name))) throw new DirError(409, `${name} is open (pinned)`);
    if (b.leases > 0) {
      const sessions = b.leases - b.connections;
      const who = [b.connections ? plural(b.connections, 'browser') : '', sessions ? plural(sessions, 'session') : ''].filter(Boolean).join(' / ');
      throw new DirError(409, `${name} is open (${who}); close it first`);
    }
    this.boards.delete(fold(name));
    await b.close();
  }

  // ------------------------------------------------------------ idle boards

  /** Seats that left the table, and idle boards unloaded (flushed first). The interval calls this; tests pass a `now`. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [key, b] of [...this.boards]) {
      b.host.sweep(b.seatIdleMs, now);
      if (this.pinned.has(key) || !this.idle(b, now)) continue;
      await this.locked([key], async () => {
        // checked again inside the lock: a request may have taken the board since
        if (this.boards.get(key) !== b || !this.idle(b, now)) return;
        this.boards.delete(key);
        this.log(`unloading ${b.name} (idle)`);
        await b.close().catch((e) => this.log(`could not save ${b.name}: ${(e as Error).message}`));
      });
    }
  }

  private idle(b: Board, now: number) {
    return b.leases === 0 && !b.pending && now - b.lastActive >= this.idleMs;
  }

  /** Flush and close every board (the process is ending). */
  async closeAll(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const [key, b] of [...this.boards]) {
      await this.locked([key], async () => {
        this.boards.delete(key);
        await b.close().catch((e) => this.log(`could not save ${b.name}: ${(e as Error).message}`));
      });
    }
  }

  // ------------------------------------------------------------ locking

  /** Run `fn` with the named boards locked (in a fixed order, so two callers can't deadlock). */
  private locked<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const [first, ...rest] = [...new Set(keys)].sort();
    const run = (): Promise<T> => (rest.length ? this.locked(rest, fn) : fn());
    const prev = this.locks.get(first) ?? Promise.resolve();
    const p = prev.then(run, run);
    const tail = p.catch(() => {});
    this.locks.set(first, tail);
    void tail.then(() => this.locks.get(first) === tail && this.locks.delete(first));
    return p;
  }
}
