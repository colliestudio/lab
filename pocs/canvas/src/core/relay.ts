import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

// The browser's side of the room relay (signaling/src/hub.ts): a WebSocket to /r/<room>?relay=peer
// that carries y-websocket frames to the bridges in the room. It is opened only while a bridge is
// there, next to the WebRTC mesh, on the same Y.Doc and Awareness.
//
// Why not y-websocket's WebsocketProvider: on every disconnect it wipes the awareness of everyone
// but this client, which here would drop the players seen over WebRTC. This one removes only the
// states that arrived through the relay (the bridge's agents), and a lost frame stream (the bridge
// sends a heartbeat every 10 s) counts as a lost connection.

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;

export interface RelayConnection {
  destroy(): void;
  connected(): boolean;
}

export function openRelay(opts: { url: string; doc: Y.Doc; awareness: awarenessProtocol.Awareness; WebSocketImpl?: typeof WebSocket; silenceMs?: number; maxBackoffMs?: number }): RelayConnection {
  const { url, doc, awareness } = opts;
  const WS = opts.WebSocketImpl ?? WebSocket;
  const silenceMs = opts.silenceMs ?? 35_000;
  const maxBackoff = opts.maxBackoffMs ?? 10_000;
  const origin = {}; // marks what came in through the relay, so it is not sent back
  const remote = new Set<number>(); // awareness client ids that arrived through the relay
  let ws: WebSocket | undefined;
  let destroyed = false;
  let backoff = 500;
  let lastFrame = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  // forget the bridge's players, and their clocks, so a reconnect shows them again at once
  const dropRemote = () => {
    const ids = [...remote];
    awarenessProtocol.removeAwarenessStates(awareness, ids, origin);
    for (const id of ids) awareness.meta.delete(id);
    remote.clear();
  };
  const send = (e: encoding.Encoder) => {
    if (ws?.readyState === WS.OPEN) ws.send(encoding.toUint8Array(e));
  };
  const sync = (write: (e: encoding.Encoder) => void) => {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    write(e);
    send(e);
  };
  const sendOwnAwareness = () => {
    if (awareness.getLocalState() === null) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_AWARENESS);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]));
    send(e);
  };

  const onDoc = (update: Uint8Array, from: unknown) => {
    if (from !== origin) sync((e) => syncProtocol.writeUpdate(e, update));
  };
  const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, from: unknown) => {
    if (from === origin) {
      for (const id of added) remote.add(id);
      for (const id of removed) remote.delete(id);
      return;
    }
    if ([...added, ...updated, ...removed].includes(awareness.clientID)) sendOwnAwareness();
  };
  doc.on('update', onDoc);
  awareness.on('update', onAwareness);

  const open = () => {
    if (destroyed) return;
    const sock = new WS(url);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => {
      backoff = 500;
      lastFrame = Date.now();
      sync((e) => syncProtocol.writeSyncStep1(e, doc));
      sendOwnAwareness();
    };
    sock.onmessage = (ev) => {
      lastFrame = Date.now();
      if (typeof ev.data === 'string') return;
      const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, e, doc, origin);
        if (encoding.length(e) > 1) send(e);
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), origin);
      } else if (type === MSG_QUERY_AWARENESS) {
        sendOwnAwareness();
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = undefined;
      // what the bridge showed (its agents) is gone with the connection
      dropRemote();
      if (destroyed) return;
      retry = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    };
    sock.onerror = () => {}; // onclose follows
  };
  open();
  const watchdog = setInterval(() => {
    if (ws?.readyState === WS.OPEN && Date.now() - lastFrame > silenceMs) ws.close();
  }, Math.max(100, Math.floor(silenceMs / 7)));

  return {
    connected: () => ws?.readyState === WS.OPEN,
    destroy() {
      destroyed = true;
      clearTimeout(retry);
      clearInterval(watchdog);
      doc.off('update', onDoc);
      awareness.off('update', onAwareness);
      const sock = ws;
      ws = undefined;
      sock?.close();
      dropRemote();
    },
  };
}
