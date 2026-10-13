import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync, renameSync, type FSWatcher } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { WebSocket } from 'ws';
import { Host, makeActor, type Actor } from './host';
import { queryNodes } from './query';

// One hosted .canvas file: its live Y.Doc (Host), the two-way file sync, the browsers connected to
// it (y-websocket protocol) and its HTTP API. No server of its own: BridgeService (service.ts) routes
// WebSocket connections and requests to it, so one process can host many files.
//  - doc → file: canonical text after every change (debounced); never over an unapplied file edit.
//  - file → doc: fs.watch on the directory (editors and git replace the file), 3-way field merge.
//  - <dir>/.canvas-bridge/<name>.ystate keeps the Yjs history across restarts; the file wins.

export const ROUTES = 'GET /doc /query /log /status /view/<name> /wait/<name>?timeout=S /chat/read?new=1&limit=N /chat/wait?timeout=S; POST /chat/say {as,text,node} POST /cmd {as,name,args} /undo {as} /redo {as}';

export type Log = (...m: unknown[]) => void;

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/** The canonical path (symlinks resolved, e.g. /tmp → /private/tmp): one file = one board. */
export function canonicalPath(file: string): string {
  const abs = resolve(file);
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

/** Stable id for a file path: readable name + short hash of the full path. */
export function boardId(file: string): string {
  file = canonicalPath(file);
  const slug = basename(file).replace(/\.canvas$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'board';
  return `${slug.slice(0, 40)}-${createHash('sha1').update(file).digest('hex').slice(0, 6)}`;
}

export class BoardFile {
  readonly host = new Host();
  readonly file: string;
  readonly id: string;
  readonly name: string;
  readonly awareness: awarenessProtocol.Awareness;
  private readonly statePath: string;
  private readonly stateDir: string;
  private conns = new Map<WebSocket, Set<number>>();
  private seatAwareness = new Set<awarenessProtocol.Awareness>();
  private lastText = '';
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private readTimer: ReturnType<typeof setTimeout> | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private watcher: FSWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private diskSig = '';
  private changeListeners = new Set<() => void>();

  constructor(
    file: string,
    private log: Log = () => {},
    private idleMs = 3 * 60_000,
    /** Where the Yjs history sidecar lives; default `<dir>/.canvas-bridge`. The desktop keeps it out of the boards folder (iCloud would sync it). */
    stateDir?: string,
  ) {
    this.file = canonicalPath(file);
    this.id = boardId(this.file);
    this.name = basename(this.file);
    this.stateDir = stateDir ?? join(dirname(this.file), '.canvas-bridge');
    this.statePath = join(this.stateDir, `${basename(this.file)}.ystate`);
    this.awareness = new awarenessProtocol.Awareness(this.host.ydoc);
    this.awareness.setLocalState(null); // the bridge itself is no player
    this.start();
  }

  /** Called after each doc change (debounced with the file write). */
  onChange(fn: () => void) {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private start() {
    const { host, file } = this;
    if (existsSync(this.statePath)) {
      Y.applyUpdate(host.ydoc, readFileSync(this.statePath));
      this.log(`${this.name}: restored live state from ${this.statePath}`);
    }
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (host.store.nodes.size) host.written(host.fileText()); // base = what the state says; the file's edits since merge in
      const line = host.applyFile(text);
      if (line) this.log(`${this.name}: ${line}`);
      host.written(text);
      this.lastText = text;
    } else {
      mkdirSync(dirname(file), { recursive: true });
      this.writeOut();
    }
    host.store.undoManager.clear();

    // doc → file (debounced) and state sidecar
    host.ydoc.on('afterTransaction', (tr: Y.Transaction) => {
      if (!tr.changed.size && !tr.deleteSet.clients.size) return;
      clearTimeout(this.writeTimer);
      this.writeTimer = setTimeout(
        () => {
          this.writeOut();
          this.saveState();
          for (const fn of this.changeListeners) fn();
        },
        Host.fromFile(tr.origin) ? 50 : 300,
      );
    });

    // file → doc: watch the directory (editors and git replace the file instead of writing in place)
    this.watcher = watch(dirname(file), (_ev, name) => {
      if (name === basename(file)) this.fileTouched();
    });

    // fs.watch can miss changes on network and iCloud folders (files arriving from another Mac): look again now and then
    this.pollTimer = setInterval(() => {
      try {
        const st = statSync(file);
        const sig = `${st.mtimeMs}:${st.size}`;
        if (sig !== this.diskSig) {
          this.diskSig = sig;
          this.fileTouched();
        }
      } catch {}
    }, 5_000);

    // agents' presence: each actor has its own awareness (own client id): relay its updates too
    host.onSeat((a, joined) => {
      if (joined) {
        this.seatAwareness.add(a);
        a.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
          this.broadcast(awarenessMsg(a, [...added, ...updated, ...removed]));
        });
      } else {
        this.broadcast(awarenessMsg(a, [a.clientID]));
        this.seatAwareness.delete(a);
      }
    });
    this.sweepTimer = setInterval(() => host.sweep(this.idleMs), 10_000);

    host.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const ws of this.conns.keys()) if (ws !== origin) send(ws, msg);
    });

    // browsers' presence: relay between them
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      if (origin instanceof Object && this.conns.has(origin as WebSocket)) {
        const mine = this.conns.get(origin as WebSocket)!;
        for (const c of added) mine.add(c);
        for (const c of removed) mine.delete(c);
      }
      this.broadcast(awarenessMsg(this.awareness, changed));
    });
  }

  private fileTouched() {
    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      const text = this.readDisk();
      if (text === undefined || text === this.lastText) return; // gone, or our own write
      // normalize the file to canonical form (after the doc settled)
      if (this.ingest(text)) setTimeout(() => this.writeOut(), 100);
    }, 80);
  }

  private broadcast(msg: Uint8Array) {
    for (const ws of this.conns.keys()) send(ws, msg);
  }

  writeOut() {
    // The file changed on disk since we last wrote or read it (an edit the watcher hasn't applied
    // yet): merge it in first, never write over it. If it can't be read (invalid JSON), leave it.
    const disk = this.readDisk();
    if (disk !== undefined && disk !== this.lastText && !this.ingest(disk)) return;
    const text = this.host.fileText();
    if (text === this.lastText) return;
    // a dotfile: iCloud Drive doesn't sync those, so no half-written copy ever reaches another Mac
    const tmp = join(dirname(this.file), `.${basename(this.file)}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, this.file);
    this.lastText = text;
    this.host.written(text);
  }

  saveState() {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.statePath, Y.encodeStateAsUpdate(this.host.ydoc));
  }

  private readDisk(): string | undefined {
    try {
      return existsSync(this.file) ? readFileSync(this.file, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  }

  /** Apply the file's text to the live doc (3-way merge). False when it isn't valid. */
  private ingest(text: string): boolean {
    try {
      const line = this.host.applyFile(text);
      this.lastText = text;
      if (line) this.log(`${this.name}: file: ${line}`);
      return true;
    } catch (e) {
      this.log(`${this.name}: file not applied (${(e as Error).message}); fix the JSON and save again`);
      return false;
    }
  }

  /** A browser joined (y-websocket protocol). */
  connect(ws: WebSocket) {
    const { host, awareness } = this;
    this.conns.set(ws, new Set());
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data: ArrayBuffer) => {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const enc = encoding.createEncoder();
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, host.ydoc, ws);
        if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
      }
    });
    ws.on('close', () => {
      const mine = this.conns.get(ws);
      this.conns.delete(ws);
      if (mine?.size) awarenessProtocol.removeAwarenessStates(awareness, [...mine], null);
    });
    // hello: our state vector, everyone's presence (browsers and seated agents)
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, host.ydoc);
    send(ws, encoding.toUint8Array(enc));
    const others = [...awareness.getStates().keys()];
    if (others.length) send(ws, awarenessMsg(awareness, others));
    for (const a of this.seatAwareness) send(ws, awarenessMsg(a, [a.clientID]));
  }

  get browsers() {
    return this.conns.size;
  }

  status() {
    return { id: this.id, file: this.file, nodes: this.host.store.nodes.size, edges: this.host.store.edges.size, browsers: this.conns.size, actors: this.host.seated() };
  }

  /** HTTP API for this board (`path` is relative: /doc /query /log /status /view /wait /chat /cmd /undo /redo). */
  async api(req: IncomingMessage, res: ServerResponse, path: string, url: URL, extra: Record<string, unknown> = {}) {
    const { host } = this;
    const reply = (code: number, v: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v, null, 2) + '\n');
    };
    try {
      if (req.method === 'GET' && path === '/doc') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(host.fileText());
      }
      if (req.method === 'GET' && path === '/query') {
        return reply(200, queryNodes(host.store.doc, Object.fromEntries(url.searchParams)));
      }
      if (req.method === 'GET' && path === '/log') {
        return reply(200, this.logEntries(Number(url.searchParams.get('limit')) || 20));
      }
      if (req.method === 'GET' && path === '/status') {
        return reply(200, { ...this.status(), ...extra });
      }
      const viewMatch = req.method === 'GET' && /^\/(view|wait)\/([\w.-]+)$/.exec(path);
      if (viewMatch) {
        const q = Object.fromEntries(url.searchParams) as Record<string, string | undefined>;
        const actor = actorOf({ as: q.as, kind: q.kind }, req);
        try {
          if (viewMatch[1] === 'view') return reply(200, this.view(actor, viewMatch[2], q));
          const ms = Math.min(Math.max(Number(q.timeout ?? 50), 1), 290) * 1000;
          const v = await this.wait(actor, viewMatch[2], q, ms);
          return reply(200, v === undefined ? { waiting: true, error: `still not ready after ${ms / 1000}s; wait again` } : v);
        } catch (e) {
          return reply(400, { error: (e as Error).message });
        }
      }
      // chat: say / read / wait as an actor; the messages live in the doc
      if (req.method === 'POST' && path === '/chat/say') {
        const b = await body(req);
        try {
          return reply(200, { ok: true, message: this.say(actorOf(b, req), String(b.text ?? ''), b.node ? String(b.node) : undefined) });
        } catch (e) {
          return reply(400, { ok: false, error: (e as Error).message });
        }
      }
      if (req.method === 'GET' && path === '/chat/read') {
        const q = Object.fromEntries(url.searchParams) as Record<string, string | undefined>;
        return reply(200, this.readChat(actorOf({ as: q.as, kind: q.kind }, req), { limit: Number(q.limit) || undefined, onlyNew: q.new === '1' || q.new === 'true' }));
      }
      if (req.method === 'GET' && path === '/chat/wait') {
        const q = Object.fromEntries(url.searchParams) as Record<string, string | undefined>;
        const ms = Math.min(Math.max(Number(q.timeout ?? 50), 1), 290) * 1000;
        const msgs = await this.waitChat(actorOf({ as: q.as, kind: q.kind }, req), ms);
        return reply(200, msgs ?? { waiting: true, error: `no new messages after ${ms / 1000}s; wait again` });
      }
      if (req.method === 'POST' && path === '/cmd') {
        const b = await body(req);
        const r = this.cmd(actorOf(b, req), String(b.name), b.args ?? {});
        return reply(r.ok ? 200 : 400, r);
      }
      if (req.method === 'POST' && (path === '/undo' || path === '/redo')) {
        const b = await body(req);
        try {
          return reply(200, this.undo(actorOf(b, req), path === '/redo'));
        } catch (e) {
          return reply(400, { ok: false, error: (e as Error).message });
        }
      }
      reply(404, { error: ROUTES });
    } catch (e) {
      reply(500, { error: (e as Error).message });
    }
  }

  // ---------------------------------------------------------------- in-process API (desktop MCP)

  cmd(actor: Actor, name: string, args: unknown) {
    const r = this.host.dispatch(actor, name, args);
    if (r.ok && r.changes.length) this.log(`${this.name}: ${actor.name}: ${name} ${JSON.stringify(args ?? {}).slice(0, 120)}`);
    return { ok: r.ok, error: r.error, changed: r.changes.length, touched: r.touched, select: r.select };
  }

  view(actor: Actor, name: string, args: Record<string, string | undefined> = {}) {
    return this.host.view(actor, name, args);
  }

  wait(actor: Actor, name: string, args: Record<string, string | undefined>, ms: number) {
    return this.host.wait(actor, name, args, ms);
  }

  say(actor: Actor, text: string, node?: string) {
    const m = this.host.say(actor, text, node);
    this.log(`${this.name}: ${actor.name}: said ${JSON.stringify(m.text.slice(0, 80))}`);
    return m;
  }

  readChat(actor: Actor, opts: { limit?: number; onlyNew?: boolean } = {}) {
    return this.host.readChat(actor, opts);
  }

  waitChat(actor: Actor, ms: number) {
    return this.host.waitChat(actor, ms);
  }

  undo(actor: Actor, redo = false) {
    const done = this.host.undo(actor, redo);
    const what = redo ? 'redo' : 'undo';
    return { ok: done, error: done ? undefined : `nothing to ${what} for ${actor.name} (each actor undoes only its own steps, while it stays seated)` };
  }

  logEntries(n = 20) {
    return this.host.store.log
      .toArray()
      .slice(-n)
      .map((e) => ({ time: new Date(e.time).toISOString(), actor: e.actor?.name ?? null, actorId: e.actor?.id ?? null, text: e.text, targets: e.targets }));
  }

  /** Flush the file and state, stop watching, drop browsers. */
  close() {
    clearTimeout(this.writeTimer);
    clearTimeout(this.readTimer);
    clearInterval(this.sweepTimer);
    clearInterval(this.pollTimer);
    this.watcher?.close();
    this.writeOut();
    this.saveState();
    for (const ws of this.conns.keys()) ws.close();
    this.host.sweep(-1);
  }
}

function send(ws: WebSocket, data: Uint8Array) {
  if (ws.readyState === ws.OPEN) ws.send(data);
}

function awarenessMsg(a: awarenessProtocol.Awareness, clients: number[]) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(a, clients));
  return encoding.toUint8Array(enc);
}

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}

function actorOf(b: { as?: string; kind?: string } | undefined, req: IncomingMessage): Actor {
  const name = b?.as ?? (req.headers['x-canvas-as'] as string | undefined) ?? 'Agent';
  return makeActor(String(name).slice(0, 32), b?.kind === 'tool' ? 'tool' : 'agent');
}
