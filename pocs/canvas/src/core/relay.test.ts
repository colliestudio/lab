import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import { openRelay, type RelayConnection } from './relay';

// A stand-in for the bridge's end: a y-websocket style server for one doc.
async function bridge() {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState({ user: { id: 'agent:claude', name: 'Claude' } });
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const sockets = new Set<NodeWebSocket>();
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (data: Buffer, isBinary) => {
      if (!isBinary) return;
      const dec = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(dec);
      const enc = encoding.createEncoder();
      if (type === 0) {
        encoding.writeVarUint(enc, 0);
        syncProtocol.readSyncMessage(dec, enc, doc, ws);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      } else if (type === 1) awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
    });
    const hello = encoding.createEncoder();
    encoding.writeVarUint(hello, 0);
    syncProtocol.writeSyncStep1(hello, doc);
    ws.send(encoding.toUint8Array(hello));
    const a = encoding.createEncoder();
    encoding.writeVarUint(a, 1);
    encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
    ws.send(encoding.toUint8Array(a));
  });
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    for (const s of sockets) if (s !== origin) s.send(encoding.toUint8Array(enc));
  });
  await new Promise((r) => wss.once('listening', r));
  const url = () => `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  return { doc, awareness, wss, sockets, url };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

const open: { destroy(): void }[] = [];
afterEach(() => {
  while (open.length) open.pop()!.destroy();
});

function client(url: string, extra: Partial<Parameters<typeof openRelay>[0]> = {}) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState({ user: { id: 'p1', name: 'Alex' } });
  const conn: RelayConnection = openRelay({ url, doc, awareness, WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket, ...extra });
  open.push(conn, { destroy: () => awareness.destroy() });
  return { doc, awareness, conn };
}

describe('browser relay connection', () => {
  it('syncs the doc both ways and shows the bridge’s agents in awareness', async () => {
    const b = await bridge();
    open.push({ destroy: () => b.wss.close() });
    b.doc.getMap('m').set('fromBridge', 1);
    const c = client(b.url());
    await until(() => c.doc.getMap('m').get('fromBridge') === 1);
    c.doc.getMap('m').set('fromBrowser', 2);
    await until(() => b.doc.getMap('m').get('fromBrowser') === 2);
    b.doc.getMap('m').set('later', 3);
    await until(() => c.doc.getMap('m').get('later') === 3);
    await until(() => c.awareness.getStates().get(b.doc.clientID)?.user?.name === 'Claude');
    await until(() => b.awareness.getStates().get(c.doc.clientID)?.user?.name === 'Alex');
  });

  it('leaves the awareness of players seen over WebRTC alone when the relay drops, but removes the bridge’s', async () => {
    const b = await bridge();
    open.push({ destroy: () => b.wss.close() });
    const c = client(b.url(), { maxBackoffMs: 50 });
    await until(() => c.awareness.getStates().has(b.doc.clientID));
    // a player that arrived by another route
    const other = new Y.Doc();
    const oa = new awarenessProtocol.Awareness(other);
    oa.setLocalState({ user: { id: 'p2', name: 'Sam' } });
    awarenessProtocol.applyAwarenessUpdate(c.awareness, awarenessProtocol.encodeAwarenessUpdate(oa, [other.clientID]), 'webrtc');
    for (const s of b.sockets) s.terminate();
    await until(() => !c.awareness.getStates().has(b.doc.clientID));
    expect(c.awareness.getStates().has(other.clientID)).toBe(true);
    // and it comes back by itself
    await until(() => c.awareness.getStates().has(b.doc.clientID));
    oa.destroy();
  });

  it('does not echo what came through the relay back into it, and treats silence as a lost connection', async () => {
    const b = await bridge();
    open.push({ destroy: () => b.wss.close() });
    const c = client(b.url(), { silenceMs: 300, maxBackoffMs: 50 });
    await until(() => c.conn.connected());
    const first = [...b.sockets][0];
    b.doc.getMap('m').set('k', 1);
    await until(() => c.doc.getMap('m').get('k') === 1);
    // the stand-in sends no heartbeat: after silenceMs the client reconnects on its own
    await until(() => b.sockets.size === 1 && ![...b.sockets].includes(first), 4000);
  });

  it('destroy closes the socket and stops reconnecting', async () => {
    const b = await bridge();
    open.push({ destroy: () => b.wss.close() });
    const c = client(b.url());
    await until(() => b.sockets.size === 1);
    c.conn.destroy();
    await until(() => b.sockets.size === 0);
    await new Promise((r) => setTimeout(r, 700));
    expect(b.sockets.size).toBe(0);
  });
});
