import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, renameSync, type FSWatcher } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { WebSocket } from 'ws';
import { Host } from '../../bridge/host';

// One open .canvas file inside the desktop service: the same logic as bridge/server.ts (live Y.Doc,
// file ⇄ doc sync with 3-way merge, .canvas-bridge/<name>.ystate sidecar, y-websocket relay), as a
// class so one process can host many files. Spike: copied from server.ts rather than refactoring it,
// so the agent-bridge branch stays untouched.

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export const boardId = (file: string) => createHash('sha1').update(file).digest('hex').slice(0, 10);

type Log = (...m: unknown[]) => void;

export class Board {
  readonly id: string;
  readonly name: string;
  readonly host = new Host();
  readonly awareness: awarenessProtocol.Awareness;
  readonly conns = new Map<WebSocket, Set<number>>();
  readonly opened = Date.now();
  private readonly statePath: string;
  private readonly stateDir: string;
  private lastText = '';
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private readTimer: ReturnType<typeof setTimeout> | undefined;
  private watcher: FSWatcher;
  private seatAwareness = new Set<awarenessProtocol.Awareness>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    readonly file: string,
    private log: Log,
  ) {
    this.id = boardId(file);
    this.name = basename(file);
    this.stateDir = join(dirname(file), '.canvas-bridge');
    this.statePath = join(this.stateDir, `${basename(file)}.ystate`);
    const host = this.host;

    // start: state, then the file (its edits since the state merge in)
    if (existsSync(this.statePath)) Y.applyUpdate(host.ydoc, readFileSync(this.statePath));
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (host.store.nodes.size) host.written(host.fileText());
      const line = host.applyFile(text);
      if (line) this.log(`${this.name}: ${line}`);
      host.written(text);
      this.lastText = text;
    } else {
      this.writeOut();
    }
    host.store.undoManager.clear();

    host.ydoc.on('afterTransaction', (tr: Y.Transaction) => {
      if (!tr.changed.size && !tr.deleteSet.clients.size) return;
      clearTimeout(this.writeTimer);
      this.writeTimer = setTimeout(
        () => {
          this.writeOut();
          this.saveState();
        },
        Host.fromFile(tr.origin) ? 50 : 300,
      );
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

    // WebSocket relay (y-websocket protocol)
    this.awareness = new awarenessProtocol.Awareness(host.ydoc);
    this.awareness.setLocalState(null);
    host.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const ws of this.conns.keys()) if (ws !== origin) send(ws, msg);
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
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
        a.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
          const msg = awarenessMsg(a, [...added, ...updated, ...removed]);
          for (const ws of this.conns.keys()) send(ws, msg);
        });
      } else {
        const msg = awarenessMsg(a, [a.clientID]);
        for (const ws of this.conns.keys()) send(ws, msg);
        this.seatAwareness.delete(a);
      }
    });
    this.sweepTimer = setInterval(() => host.sweep(3 * 60_000), 10_000);
  }

  connect(ws: WebSocket) {
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

  /** People in the room (browser/window presence with a user), not counting agent seats. */
  people(): string[] {
    return [...this.awareness.getStates().values()].map((s: any) => s?.user?.name).filter(Boolean);
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
    clearInterval(this.sweepTimer);
    for (const ws of this.conns.keys()) ws.close();
  }

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
      if (line) this.log(`${this.name}: file: ${line}`);
      return true;
    } catch (e) {
      this.log(`${this.name}: file not applied (${(e as Error).message})`);
      return false;
    }
  }
}

const send = (ws: WebSocket, data: Uint8Array) => {
  if (ws.readyState === ws.OPEN) ws.send(data);
};
const awarenessMsg = (a: awarenessProtocol.Awareness, clients: number[]) => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(a, clients));
  return encoding.toUint8Array(enc);
};
