import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { parse } from '../../src/core/io';
import { FORMAT_KEY, FORMAT_VERSION, FormatError, checkFormat, migrateFormat } from '../../src/core/format';
import { newId } from '../../src/core/store';
import type { ServeBoard } from '../../src/core/serveExtra';
import { Host, type Actor } from './host';
import { stableSerialize } from './canonical';
import { BoardFileError, DirError } from './errors';
import type { BoardStorage } from './storage';
import type { Conn, Log } from './transport';
import type { ShotProvider } from './shots';

// One loaded board: the live document (Host) kept in step with its stored text, and the y-websocket
// protocol over any Conn. The storage and the transport are interfaces (storage.ts, transport.ts): this
// file knows no file system and no socket library.
//  - doc -> storage: debounced, canonical text (clean git diffs); the Yjs history goes to a sidecar
//  - storage -> doc: edits from outside (editor, git, iCloud) merge into the open doc
//  - a board whose format is newer than this code knows is refused and never written

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;
/** Origin of the format stamp: not a player's edit, not the file's. */
const STAMP = Symbol('stamp');

export interface BoardOptions {
  log?: Log;
  /** Seated actors idle longer than this leave the table. Default 3 minutes. */
  seatIdleMs?: number;
  /** Takes screenshots of this board (see shots.ts); without one the board has none. */
  shots?: ShotProvider;
}

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

interface ConnState {
  /** Awareness client ids this connection introduced (removed when it closes). */
  ids: Set<number>;
  /** The room relay: many browsers behind one socket. Never echo a frame back to it. */
  relay: boolean;
}

export class Board {
  readonly host = new Host();
  readonly awareness: awarenessProtocol.Awareness;
  /** Last time something happened here (a change, a connection, a lease released). */
  lastActive = Date.now();
  readonly seatIdleMs: number;
  readonly log: Log;
  readonly shots: ShotProvider | undefined;
  private conns = new Map<Conn, ConnState>();
  private holds = 0;
  private seatAwareness = new Set<awarenessProtocol.Awareness>();
  /** The stored text as last written or read. */
  private lastText = '';
  private stateDirty = false;
  /** The doc changed since the stored text was written or read. Loading and looking never write. */
  private docDirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private readTimer: ReturnType<typeof setTimeout> | undefined;
  private normTimer: ReturnType<typeof setTimeout> | undefined;
  /** Reads, ingests and writes of the stored text run one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private unwatch: (() => void) | undefined;
  private unseat: (() => void) | undefined;
  private closers: (() => void)[] = [];
  private closed = false;

  private constructor(
    readonly name: string,
    private storage: BoardStorage,
    opts: BoardOptions,
  ) {
    this.log = opts.log ?? ((...m) => console.log(new Date().toISOString().slice(11, 19), ...m));
    this.seatIdleMs = opts.seatIdleMs ?? 3 * 60_000;
    this.shots = opts.shots;
    this.awareness = new awarenessProtocol.Awareness(this.host.ydoc);
    this.awareness.setLocalState(null); // the server itself is no player
  }

  /**
   * Load a board from storage: its history sidecar first, then the stored text merged over it.
   * Throws FormatError (newer or invalid format: nothing is loaded, watched or written), DirError 404
   * (missing, unless `create`) or BoardFileError (a text that is not a canvas at all).
   */
  static async load(name: string, storage: BoardStorage, opts: BoardOptions & { create?: boolean } = {}): Promise<Board> {
    const text = await storage.read(name);
    if (text === undefined && !opts.create) throw new DirError(404, `no canvas "${name}"`);
    let apply: string | undefined; // refuses before any state is touched
    try {
      apply = text === undefined ? undefined : prepare(text);
    } catch (e) {
      throw e instanceof FormatError ? e : new BoardFileError(name, e as Error);
    }
    const state = await storage.readState(name);
    const b = new Board(name, storage, opts);
    try {
      await b.start(text, apply, state);
    } catch (e) {
      b.closed = true;
      clearTimeout(b.writeTimer);
      b.unwatch?.();
      b.awareness.destroy();
      b.host.ydoc.destroy();
      throw e;
    }
    return b;
  }

  private async start(text: string | undefined, apply: string | undefined, state: Uint8Array | undefined) {
    const host = this.host;
    if (state) {
      Y.applyUpdate(host.ydoc, state);
      this.log(`restored live state of ${this.location()}`);
    }
    if (text !== undefined) {
      if (host.store.nodes.size) host.written(host.fileText()); // base = what the state says; the file's edits since merge in
      const line = host.applyFile(apply!, undefined, true);
      if (line) this.log(line);
      host.written(text);
      this.lastText = text;
    }
    host.store.undoManager.clear();
    this.wire();
    if (text === undefined) {
      this.docDirty = true; // a new board: write it now
      await this.flush();
    }
    this.unwatch = this.storage.watch(this.name, () => this.onExternal());
  }

  // ------------------------------------------------------------ leases and status

  /** A lease: keeps the board loaded (a request in flight, a joined session). Call the result to release. */
  hold(): () => void {
    this.holds++;
    this.lastActive = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.lastActive = Date.now();
    };
  }

  /** Connections plus holds: a board with any is in use (not idle, not renamable). */
  get leases(): number {
    return this.conns.size + this.holds;
  }
  /** Live connections (the relay counts as one). */
  get connections(): number {
    return this.conns.size;
  }
  /** Browsers connected: the relay stands for many and is not counted. */
  get browsers(): number {
    let n = 0;
    for (const c of this.conns.values()) if (!c.relay) n++;
    return n;
  }
  /** A write or an unapplied edit from outside is waiting. */
  get pending(): boolean {
    return !!this.writeTimer || !!this.readTimer || !!this.normTimer || this.queued > 0;
  }

  status(): { name: string; nodes: number; edges: number; browsers: number; actors: Actor[] } {
    return { name: this.name, nodes: this.host.store.nodes.size, edges: this.host.store.edges.size, browsers: this.browsers, actors: this.host.seated() };
  }

  location(): string {
    return this.storage.location?.(this.name) ?? this.name;
  }

  // ------------------------------------------------------------ doc <-> storage

  private wire() {
    const host = this.host;
    host.ydoc.on('afterTransaction', (tr: Y.Transaction) => {
      if (this.closed || (!tr.changed.size && !tr.deleteSet.clients.size)) return;
      this.lastActive = Date.now();
      this.stateDirty = true;
      this.docDirty = true;
      clearTimeout(this.writeTimer);
      this.writeTimer = setTimeout(() => {
        this.writeTimer = undefined;
        this.flush().catch((e) => this.log(`could not save ${this.name}: ${(e as Error).message}`));
      }, Host.fromFile(tr.origin) ? 50 : 300);
    });

    host.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns.keys()) if (c !== origin) c.send(msg);
    });

    // browsers' presence: relay between them
    this.awareness.on('update', ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      const mine = origin instanceof Object ? this.conns.get(origin as Conn) : undefined;
      if (mine) {
        for (const c of added) mine.ids.add(c);
        for (const c of removed) mine.ids.delete(c);
      }
      const msg = awarenessMsg(this.awareness, [...added, ...updated, ...removed]);
      for (const [c, s] of this.conns) if (!(s.relay && c === origin)) c.send(msg);
    });

    // agents' presence: each actor has its own awareness (own client id): relay its updates too
    this.unseat = host.onSeat((a, joined) => {
      if (joined) {
        this.seatAwareness.add(a);
        a.on('update', ({ added, updated, removed }: AwarenessChange) => {
          const msg = awarenessMsg(a, [...added, ...updated, ...removed]);
          for (const c of this.conns.keys()) c.send(msg);
        });
      } else {
        const msg = awarenessMsg(a, [a.clientID]);
        for (const c of this.conns.keys()) c.send(msg);
        this.seatAwareness.delete(a);
      }
    });
  }

  /** Mark the doc with the format version it is written in (a file from before the field gets it on its next write). */
  private stamp() {
    const meta = this.host.store.meta;
    if (meta.get(FORMAT_KEY) === undefined) this.host.ydoc.transact(() => meta.set(FORMAT_KEY, FORMAT_VERSION), STAMP);
  }

  private run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.queued++;
    const p = this.chain.then(fn, fn);
    this.chain = p.finally(() => this.queued--).catch(() => {});
    return p;
  }

  /** Write the doc to storage now (and its history sidecar). Resolves when done. */
  flush(): Promise<void> {
    return this.run(() => this.writeOut());
  }

  private async writeOut() {
    try {
      // The text changed in storage since we last wrote or read it (an edit the watcher hasn't applied
      // yet): merge it in first, never write over it. If it can't be applied (invalid JSON, a newer
      // format), leave it. The write itself only goes through if the stored text is still what we
      // merged; an edit that lands meanwhile is merged on the next round.
      for (let round = 0; round < 5; round++) {
        const disk = await this.storage.read(this.name).catch(() => undefined);
        if (disk !== undefined && disk !== this.lastText && !this.ingest(disk)) return;
        if (!this.docDirty) return;
        // a board from before the format field gets it with its first real write
        this.stamp();
        const text = this.host.fileText();
        if (text === this.lastText) {
          this.docDirty = false;
          return;
        }
        this.docDirty = false;
        let written = false;
        try {
          written = await this.storage.write(this.name, text, { from: disk });
        } finally {
          if (!written) this.docDirty = true;
        }
        if (written) {
          this.lastText = text;
          this.host.written(text);
          return;
        }
      }
      this.log(`could not save ${this.name}: it keeps changing underneath; will retry on the next edit`);
    } finally {
      await this.saveState();
    }
  }

  private async saveState() {
    if (!this.stateDirty) return;
    this.stateDirty = false;
    await this.storage.writeState(this.name, Y.encodeStateAsUpdate(this.host.ydoc));
  }

  /** Apply stored text to the live doc (3-way merge). False when it can't be (invalid, or a newer format). */
  private ingest(text: string): boolean {
    try {
      const line = this.host.applyFile(prepare(text));
      this.lastText = text;
      this.docDirty = true; // the stored text gets normalized to canonical form after an edit from outside
      if (line) this.log(`file: ${line}`);
      return true;
    } catch (e) {
      this.log(`file: not applied (${(e as Error).message}); fix the file and save again`);
      return false;
    }
  }

  private onExternal() {
    if (this.closed) return;
    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      this.readTimer = undefined;
      void this.run(async () => {
        const text = await this.storage.read(this.name).catch(() => undefined);
        if (this.closed || text === undefined || text === this.lastText) return; // gone, or our own write
        // normalize the stored text to canonical form (after the doc settled)
        if (this.ingest(text)) {
          clearTimeout(this.normTimer);
          this.normTimer = setTimeout(() => {
            this.normTimer = undefined;
            this.flush().catch((e) => this.log(`could not save ${this.name}: ${(e as Error).message}`));
          }, 100);
        }
      });
    }, 80);
  }

  // ------------------------------------------------------------ connections (y-websocket protocol)

  /**
   * Serve one connection speaking the y-websocket protocol: a browser, or (relay) the socket the
   * bridge opened to the room's relay, which stands for every browser in the room.
   */
  connect(conn: Conn, opts: { relay?: boolean } = {}) {
    const relay = !!opts.relay;
    if (this.closed) return conn.close(1001, 'canvas closed');
    this.conns.set(conn, { ids: new Set(), relay });
    this.lastActive = Date.now();
    conn.onMessage((data) => {
      // A joined room's peers reach this through the relay: a malformed frame must not take the server down.
      try {
        const dec = decoding.createDecoder(data);
        const enc = encoding.createEncoder();
        const type = decoding.readVarUint(dec);
        if (type === MSG_SYNC) {
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.readSyncMessage(dec, enc, this.host.ydoc, conn);
          if (encoding.length(enc) > 1) conn.send(encoding.toUint8Array(enc));
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), conn);
        } else if (type === MSG_QUERY_AWARENESS) {
          // the relay sends this when a browser connects to it: introduce ourselves (our state vector makes
          // it send everything we lack) and our presence
          this.sendStep1(conn);
          this.sendPresence(conn);
        }
      } catch (e) {
        this.log(`dropped a malformed frame${relay ? ' from the room' : ''}: ${(e as Error).message}`);
      }
    });
    conn.onClose(() => {
      const mine = this.conns.get(conn);
      if (!mine) return;
      this.conns.delete(conn);
      this.lastActive = Date.now();
      if (mine.ids.size && !this.closed) awarenessProtocol.removeAwarenessStates(this.awareness, [...mine.ids], null);
    });
    // hello: our state vector, everyone's presence (browsers and seated agents)
    this.sendStep1(conn);
    this.sendPresence(conn);
    if (relay) {
      // and ask the room who is there
      const q = encoding.createEncoder();
      encoding.writeVarUint(q, MSG_QUERY_AWARENESS);
      conn.send(encoding.toUint8Array(q));
    }
  }

  private sendStep1(conn: Conn) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.host.ydoc);
    conn.send(encoding.toUint8Array(enc));
  }

  private sendPresence(conn: Conn) {
    const others = [...this.awareness.getStates().keys()];
    if (others.length) conn.send(awarenessMsg(this.awareness, others));
    for (const a of this.seatAwareness) conn.send(awarenessMsg(a, [a.clientID]));
  }

  // ------------------------------------------------------------ serve extras

  /** Run `fn` when the board closes, before its final flush (a serve extra's watcher or timer). */
  addCloser(fn: () => void) {
    if (this.closed) fn();
    else this.closers.push(fn);
  }

  /** This board as a serve extra sees it (src/core/serveExtra.ts). */
  serveHandle(): ServeBoard {
    const host = this.host;
    return {
      name: this.name,
      doc: () => host.store.doc,
      apply: (changes, events) => {
        if (!this.closed) host.applySystem(changes, events);
      },
      newId,
      onDocChange: (fn) => {
        const h = (tr: Y.Transaction) => {
          if (!Host.fromSystem(tr.origin)) fn();
        };
        host.ydoc.on('afterTransaction', h);
        return () => host.ydoc.off('afterTransaction', h);
      },
      onClose: (fn) => this.addCloser(fn),
      log: (m) => this.log(m),
    };
  }

  // ------------------------------------------------------------ end of life

  /** Flush, then let go of everything: timers, the watcher, connections, seats, the doc. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; // from here nothing re-arms a timer or reaches a new connection
    for (const fn of this.closers.splice(0)) {
      try {
        fn();
      } catch (e) {
        this.log(`close: ${(e as Error).message}`);
      }
    }
    clearTimeout(this.writeTimer);
    clearTimeout(this.readTimer);
    clearTimeout(this.normTimer);
    this.writeTimer = this.readTimer = this.normTimer = undefined;
    this.unwatch?.();
    try {
      await this.flush();
    } finally {
      for (const c of [...this.conns.keys()]) c.close(1001, 'canvas closed');
      this.conns.clear();
      this.unseat?.();
      this.host.sweep(-Infinity); // seats leave: their awareness intervals stop
      this.awareness.destroy();
      this.host.ydoc.destroy();
    }
  }
}

/** The text to apply to the doc: refuses a newer or invalid format, brings an older one up to date. */
function prepare(text: string): string {
  const doc = parse(text);
  return checkFormat(doc) < FORMAT_VERSION ? stableSerialize(migrateFormat(doc)) : text;
}

function awarenessMsg(a: awarenessProtocol.Awareness, clients: number[]) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(a, clients));
  return encoding.toUint8Array(enc);
}
