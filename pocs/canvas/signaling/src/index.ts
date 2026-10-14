import { DurableObject } from 'cloudflare:workers';
import { handle, relay, relayRecipients, relayRole, MAX_RELAY, QUERY_AWARENESS, type RelayRole } from './hub';
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

  async fetch(req: Request): Promise<Response> {
    const role = relayRole(new URL(req.url));
    if (role && this.ctx.getWebSockets(`relay-${role}`).length >= MAX_RELAY[role]) return new Response('room relay is full\n', { status: 429 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role ? `relay-${role}` : 'signal']);
    pair[1].serializeAttachment({ topics: [] as string[] });
    if (role === 'bridge') this.announceBridge();
    // a browser reaching the bridge: ask the bridges to introduce everyone present
    if (role === 'peer') for (const b of this.ctx.getWebSockets('relay-bridge')) b.send(QUERY_AWARENESS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private roleOf(ws: WebSocket): RelayRole | null {
    const tag = this.ctx.getTags(ws)[0];
    return tag === 'relay-bridge' ? 'bridge' : tag === 'relay-peer' ? 'peer' : null;
  }

  /** Tell the signaling sockets whether a bridge is in the room (`except`: one that is closing). */
  private announceBridge(except?: WebSocket) {
    const online = this.ctx.getWebSockets('relay-bridge').some((b) => b !== except);
    const msg = JSON.stringify({ type: 'bridge', online });
    for (const c of this.ctx.getWebSockets('signal')) {
      try {
        c.send(msg);
      } catch {
        /* closing socket */
      }
    }
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const role = this.roleOf(ws);
    if (role) {
      if (typeof data === 'string') return; // pings are answered by the runtime
      const all = this.ctx.getWebSockets().flatMap((conn) => {
        const r = this.roleOf(conn);
        return r ? [{ conn, role: r }] : [];
      });
      for (const to of relayRecipients({ conn: ws, role }, all)) {
        try {
          to.send(data);
        } catch {
          /* closing socket */
        }
      }
      return;
    }
    if (typeof data !== 'string') return;
    const topics = (ws.deserializeAttachment() as { topics: string[] } | null)?.topics ?? [];
    const out = handle(data, topics);
    switch (out.kind) {
      case 'topics':
        ws.serializeAttachment({ topics: out.topics });
        // the current bridge state, for a browser that just (re)connected
        ws.send(JSON.stringify({ type: 'bridge', online: this.ctx.getWebSockets('relay-bridge').length > 0 }));
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
    if (this.roleOf(ws) === 'bridge') this.announceBridge(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket) {
    if (this.roleOf(ws) === 'bridge') this.announceBridge(ws);
  }
}
