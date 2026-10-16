import type { WebSocket } from 'ws';
import type { Conn } from '../core/transport';

/** A WebSocket as a board connection. Text frames are dropped (the room relay's pong). */
export function wsConn(ws: WebSocket): Conn {
  ws.binaryType = 'arraybuffer';
  ws.on('error', () => {}); // a reset socket also closes: that is handled there
  return {
    send(data) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close: (code, reason) => ws.close(code, reason),
    onMessage(fn) {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        fn(data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? new Uint8Array(Buffer.concat(data)) : new Uint8Array(data));
      });
    },
    onClose: (fn) => ws.on('close', fn),
  };
}
