import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Store } from '../../src/core/store';
import { registerCoreCommands } from '../../src/core/commands';
import { registerPluginLogic } from '../../src/plugins/logic';
import type { Board } from './board';
import type { Conn } from './transport';

// A browser stand-in for tests: a Y.Doc and an Awareness speaking the y-websocket protocol to a board
// through an in-memory Conn (frames are delivered synchronously).

export interface FakeClient {
  doc: Y.Doc;
  store: Store;
  awareness: awarenessProtocol.Awareness;
  conn: Conn;
  closed: boolean;
  /** Send raw bytes as if the client wrote them. */
  raw(data: Uint8Array): void;
  /** The client goes away. */
  disconnect(): void;
}

export function fakeClient(board: Board, opts: { relay?: boolean } = {}): FakeClient {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const store = new Store({ ydoc: doc });
  registerCoreCommands(store);
  registerPluginLogic(store);
  let toBoard: (d: Uint8Array) => void = () => {};
  let boardClosed: () => void = () => {};
  const c: FakeClient = {
    doc,
    store,
    awareness,
    closed: false,
    raw: (d) => toBoard(d),
    disconnect: () => {
      if (c.closed) return;
      c.closed = true;
      boardClosed();
      awareness.destroy();
    },
    conn: {
      send(data) {
        if (c.closed) return;
        const dec = decoding.createDecoder(data);
        const type = decoding.readVarUint(dec);
        if (type === 0) {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, 0);
          syncProtocol.readSyncMessage(dec, enc, doc, 'board');
          if (encoding.length(enc) > 1) toBoard(encoding.toUint8Array(enc));
        } else if (type === 1) {
          awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), 'board');
        }
      },
      close() {
        c.closed = true;
        awareness.destroy();
      },
      onMessage: (fn) => (toBoard = fn),
      onClose: (fn) => (boardClosed = fn),
    },
  };
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'board' || c.closed) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    toBoard(encoding.toUint8Array(enc));
  });
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === 'board' || c.closed) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
    toBoard(encoding.toUint8Array(enc));
  });
  board.connect(c.conn, opts);
  // the client's hello: its state vector, so the board sends what it lacks
  const hello = encoding.createEncoder();
  encoding.writeVarUint(hello, 0);
  syncProtocol.writeSyncStep1(hello, doc);
  toBoard(encoding.toUint8Array(hello));
  return c;
}
