import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, renameSync, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { WebSocket } from 'ws';
import { Host, makeActor, type Actor } from '../../bridge/host';
import { queryNodes } from '../../bridge/query';

// One open .canvas file inside the desktop service: the agent-bridge's server.ts logic (doc ⇄ file
// two-way sync, y-websocket peers, per-actor seats) as a class, so one process hosts many files.
// Differences from bridge/server.ts: no own HTTP server (the service routes /b/<id>/… here), and it
// can be closed.

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export interface Reply {
  code: number;
  body: unknown;
  raw?: string;
}

export class Room {
  readonly host = new Host();
  readonly awareness: awarenessProtocol.Awareness;
  readonly conns = new Map<WebSocket, Set<number>>();
  private seatAwareness = new Set<awarenessProtocol.Awareness>();
  private lastText = '';
  private writeTimer?: ReturnType<typeof setTimeout>;
  private readTimer?: ReturnType<typeof setTimeout>;
  private watcher: FSWatcher;
  private sweeper: ReturnType<typeof setInterval>;
  private statePath: string;
  private stateDir: string;

  constructor(
    readonly id: string,
    readonly file: string,
    private log: (...m: unknown[]) => void,
  ) {
    const host = this.host;
    this.stateDir = join(dirname(file), '.canvas-bridge');
    this.statePath = join(this.stateDir, `${basename(file)}.ystate`);
    if (existsSync(this.statePath)) Y.applyUpdate(host.ydoc, readFileSync(this.statePath));
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (host.store.nodes.size) host.written(host.fileText());
      const line = host.applyFile(text);
      if (line) log(`[${id}] ${line}`);
      host.written(text);
      this.lastText = text;
    } else {
      this.writeOut();
    }
    host.store.undoManager.clear();

    host.ydoc.on('afterTransaction', (tr: Y.Transaction) => {
      if (!tr.changed.size && !tr.deleteSet.clients.size) return;
      clearTimeout(this.writeTimer);
      this.writeTimer = setTimeout(() => {
        this.writeOut();
        this.saveState();
      }, Host.fromFile(tr.origin) ? 50 : 300);
    });

    this.watcher = watch(dirname(file), (_ev, name) => {
      if (name !== basename(file)) return;
      clearTimeout(this.readTimer);
      this.readTimer = setTimeout(() => {
        const text = this.readDisk();
        if (text === undefined || text === this.lastText) return;
        if (this.ingest(text)) setTimeout(() => this.writeOut(), 100);
      }, 80);
    });

    // presence
    this.awareness = new awarenessProtocol.Awareness(host.ydoc);
    this.awareness.setLocalState(null);
    host.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const ws of this.conns.keys()) if (ws !== origin) send(ws, msg);
    });
    this.awareness.on('update', ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      if (origin instanceof Object && this.conns.has(origin as WebSocket)) {
        const mine = this.conns.get(origin as WebSocket)!;
        for (const c of added) mine.add(c);
        for (const c of removed) mine.delete(c);
      }
      const msg = awarenessMsg(this.awareness, [...added, ...updated, ...removed]);
      for (const ws of this.conns.keys()) send(ws, msg);
    });
    host.onSeat((a, joined) => {
      if (joined) {
        this.seatAwareness.add(a);
        a.on('update', ({ added, updated, removed }: AwarenessChange) => {
          const msg = awarenessMsg(a, [...added, ...updated, ...removed]);
          for (const ws of this.conns.keys()) send(ws, msg);
        });
      } else {
        const msg = awarenessMsg(a, [a.clientID]);
        for (const ws of this.conns.keys()) send(ws, msg);
        this.seatAwareness.delete(a);
      }
    });
    this.sweeper = setInterval(() => host.sweep(3 * 60_000), 10_000);
  }

  get name() {
    return basename(this.file);
  }

  summary() {
    return { id: this.id, name: this.name, file: this.file, nodes: this.host.store.nodes.size, edges: this.host.store.edges.size, browsers: this.conns.size, actors: this.host.seated().map((a) => a.name) };
  }

  // ------------------------------------------------------------ file
  private readDisk(): string | undefined {
    try {
      return existsSync(this.file) ? readFileSync(this.file, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  }

  private ingest(text: string): boolean {
    try {
      const line = this.host.applyFile(text);
      this.lastText = text;
      if (line) this.log(`[${this.id}] file: ${line}`);
      return true;
    } catch (e) {
      this.log(`[${this.id}] file: not applied (${(e as Error).message})`);
      return false;
    }
  }

  writeOut() {
    const disk = this.readDisk();
    if (disk !== undefined && disk !== this.lastText && !this.ingest(disk)) return;
    const text = this.host.fileText();
    if (text === this.lastText) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.file);
    this.lastText = text;
    this.host.written(text);
  }

  saveState() {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.statePath, Y.encodeStateAsUpdate(this.host.ydoc));
  }

  close() {
    clearTimeout(this.writeTimer);
    this.writeOut();
    this.saveState();
    this.watcher.close();
    clearInterval(this.sweeper);
    for (const ws of this.conns.keys()) ws.close();
  }

  // ------------------------------------------------------------ WebSocket peers (y-websocket protocol)
  join(ws: WebSocket) {
    this.conns.set(ws, new Set());
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data: ArrayBuffer) => {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const enc = encoding.createEncoder();
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, this.host.ydoc, ws);
        if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), ws);
      }
    });
    ws.on('close', () => {
      const mine = this.conns.get(ws);
      this.conns.delete(ws);
      if (mine?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...mine], null);
    });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.host.ydoc);
    send(ws, encoding.toUint8Array(enc));
    const others = [...this.awareness.getStates().keys()];
    if (others.length) send(ws, awarenessMsg(this.awareness, others));
    for (const a of this.seatAwareness) send(ws, awarenessMsg(a, [a.clientID]));
  }

  // ------------------------------------------------------------ HTTP API (same routes as the bridge, under /b/<id>)
  api(method: string, path: string, params: URLSearchParams, b: any, headerAs?: string): Reply {
    const host = this.host;
    const actorOf = (): Actor => makeActor(String(b?.as ?? headerAs ?? 'Agent').slice(0, 32), b?.kind === 'tool' ? 'tool' : 'agent');
    if (method === 'GET' && path === '/doc') return { code: 200, body: null, raw: host.fileText() };
    if (method === 'GET' && path === '/query') return { code: 200, body: queryNodes(host.store.doc, Object.fromEntries(params)) };
    if (method === 'GET' && path === '/log') {
      const n = Number(params.get('limit')) || 20;
      return { code: 200, body: host.store.log.toArray().slice(-n).map((e) => ({ time: new Date(e.time).toISOString(), actor: e.actor?.name ?? null, actorId: e.actor?.id ?? null, text: e.text, targets: e.targets })) };
    }
    if (method === 'GET' && path === '/status') return { code: 200, body: this.summary() };
    if (method === 'POST' && path === '/cmd') {
      const actor = actorOf();
      const r = host.dispatch(actor, String(b.name), b.args ?? {});
      if (r.ok && r.changes.length) this.log(`[${this.id}] ${actor.name}: ${b.name} ${JSON.stringify(b.args ?? {}).slice(0, 120)}`);
      return { code: r.ok ? 200 : 400, body: { ok: r.ok, error: r.error, changed: r.changes.length, touched: r.touched, select: r.select } };
    }
    if (method === 'POST' && (path === '/undo' || path === '/redo')) {
      const actor = actorOf();
      const done = host.undo(actor, path === '/redo');
      return { code: 200, body: { ok: done, error: done ? undefined : `nothing to ${path.slice(1)} for ${actor.name}` } };
    }
    return { code: 404, body: { error: 'GET /doc /query /log /status; POST /cmd /undo /redo /screenshot' } };
  }
}

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

const send = (ws: WebSocket, data: Uint8Array) => {
  if (ws.readyState === ws.OPEN) ws.send(data);
};

function awarenessMsg(a: awarenessProtocol.Awareness, clients: number[]) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(a, clients));
  return encoding.toUint8Array(enc);
}
