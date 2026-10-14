import { WebSocket } from 'ws';
import * as encoding from 'lib0/encoding';

// The bridge as a peer of an existing room. Browsers in a room sync over WebRTC, which Node doesn't
// have; the signaling Worker therefore also offers a WebSocket path, /r/<room>?relay=bridge, that
// forwards y-websocket frames between a room's bridges and its browsers (signaling/src/hub.ts).
// This keeps one such connection open (reconnecting with backoff) and hands each socket to `attach`,
// which treats it like any browser connection.

export interface RelayLink {
  stop(): void;
  /** Is the socket to the relay open right now? */
  online(): boolean;
}

/** An awareness message with no clients: changes nothing, but y-websocket peers count any frame as a sign of life. */
export const HEARTBEAT = (() => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, 0);
  encoding.writeVarUint8Array(e, encoding.toUint8Array(inner));
  return encoding.toUint8Array(e);
})();

export function relayUrl(signal: string, room: string): string {
  return `${signal.replace(/\/+$/, '')}/r/${encodeURIComponent(room)}?relay=bridge`;
}

export function joinRelay(opts: {
  url: string;
  /** A new socket: wire it up (and send the hello). Called again after each reconnect. */
  attach(ws: WebSocket): void;
  log?(msg: string): void;
  /** Timings, overridable for tests. */
  heartbeatMs?: number;
  pingMs?: number;
  silenceMs?: number;
  maxBackoffMs?: number;
}): RelayLink {
  const log = opts.log ?? (() => {});
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const pingMs = opts.pingMs ?? 20_000;
  const silenceMs = opts.silenceMs ?? 70_000;
  const maxBackoff = opts.maxBackoffMs ?? 15_000;
  let ws: WebSocket | undefined;
  let stopped = false;
  let backoff = 500;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let timers: ReturnType<typeof setInterval>[] = [];

  const open = () => {
    if (stopped) return;
    const sock = new WebSocket(opts.url, { maxPayload: 64 * 1024 * 1024 });
    sock.binaryType = 'arraybuffer';
    ws = sock;
    let seen = Date.now();
    sock.on('message', () => (seen = Date.now()));
    sock.on('open', () => {
      backoff = 500;
      log(`relay: joined ${opts.url.replace(/\?.*$/, '')}`);
      opts.attach(sock);
      timers = [
        setInterval(() => sock.readyState === sock.OPEN && sock.send(HEARTBEAT), heartbeatMs),
        // the relay answers this itself without waking: proof the path is alive
        setInterval(() => {
          if (Date.now() - seen > silenceMs) return sock.terminate();
          if (sock.readyState === sock.OPEN) sock.send('{"type":"ping"}');
        }, pingMs),
      ];
    });
    sock.on('error', (e) => log(`relay: ${e.message}`));
    sock.on('close', () => {
      timers.forEach(clearInterval);
      timers = [];
      if (ws === sock) ws = undefined;
      if (stopped) return;
      log(`relay: disconnected, retrying in ${(backoff / 1000).toFixed(1)}s`);
      retry = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    });
  };
  open();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      timers.forEach(clearInterval);
      ws?.close();
    },
    online: () => ws?.readyState === WebSocket.OPEN,
  };
}
