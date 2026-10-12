import { DurableObject } from 'cloudflare:workers';
import { handle, relay } from './hub';
import { sandboxResponse } from './sandbox';

export interface Env {
  ROOMS: DurableObjectNamespace<SignalRoom>;
  /** Sandbox origin: frames are served on `<label>.<SANDBOX_HOST>` (unset: no sandbox host). */
  SANDBOX_HOST?: string;
  /** Space-separated origins allowed to embed sandbox frames, e.g. `https://canvas.lab.collie.studio`. */
  APP_ORIGINS?: string;
}

/**
 * Worker: `GET /r/<room>` (WebSocket upgrade) -> the Durable Object for that room. One DO per room
 * keeps rooms independent and lets a room-level DO later also hold the doc (y-websocket peer,
 * persistence, dealer) without changing the URL scheme. `/` = health check.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // the sandbox origin: same Worker, chosen by host name (see ideas/prototype.md § Security model)
    const sandbox = sandboxResponse(url, env);
    if (sandbox) return sandbox;
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('canvas signaling: connect with a WebSocket to /r/<room>\n', { headers: { 'content-type': 'text/plain' } });
    }
    const m = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{1,64})$/);
    const room = m ? m[1] : 'lobby';
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return stub.fetch(req);
  },
} satisfies ExportedHandler<Env>;

/**
 * Signaling relay for one room. Uses the WebSocket Hibernation API: subscriptions live in each
 * socket's attachment, so the object can sleep between messages and nothing is kept in memory.
 */
export class SignalRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // answered by the runtime without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ topics: [] as string[] });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== 'string') return;
    const topics = (ws.deserializeAttachment() as { topics: string[] } | null)?.topics ?? [];
    const out = handle(data, topics);
    switch (out.kind) {
      case 'topics':
        ws.serializeAttachment({ topics: out.topics });
        return;
      case 'reply':
        ws.send(JSON.stringify(out.message));
        return;
      case 'publish':
        relay(
          this.ctx.getWebSockets(),
          (c) => (c.deserializeAttachment() as { topics: string[] } | null)?.topics ?? [],
          out.topic,
          out.message,
          (c, s) => {
            try {
              c.send(s);
            } catch {
              /* closing socket */
            }
          },
        );
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      /* already closed */
    }
  }
}
