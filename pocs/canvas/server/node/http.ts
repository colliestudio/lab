import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { boardApi, errorReply, serviceApi, type ApiReply, type ApiRequest } from '../core/api';
import type { BoardDirectory } from '../core/directory';
import type { Log } from '../core/transport';
import type { Guard } from './guard';
import { wsConn } from './ws';

// The HTTP and WebSocket front of a BoardDirectory on node:http.
//  /api/...                  the service API (core/api.ts)
//  WS /ws/<board>[/...]      a board's live document (y-websocket)
// With `defaultBoard` (bridge mode) the old single-board routes work too: /doc, /status, ... and a
// WebSocket on any other path go to that board.

export interface NodeServerOptions {
  directory: BoardDirectory;
  guard: Guard;
  log: Log;
  defaultBoard?: string;
  /** Bridge mode: more fields on the default board's /status (port, room). */
  statusExtra?: () => Record<string, unknown>;
}

export interface NodeServer {
  http: Server;
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

const WS_PATH = /^\/ws\/([^/]+)(?:\/|$)/;

export function createNodeServer(o: NodeServerOptions): NodeServer {
  const { directory, guard, log } = o;
  const http = createServer((req, res) => void handle(req, res));
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => void upgrade(req, socket, head));

  // the query may carry the pairing token: never log it
  const refuse = (what: string, req: IncomingMessage, why: string) => log(`refused ${what} ${(req.url ?? '').replace(/\?.*$/, '')}: ${why}`);
  const info = (req: IncomingMessage) => ({ url: req.url, remote: req.socket.remoteAddress });

  function send(res: ServerResponse, reply: ApiReply) {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.raw ?? JSON.stringify(reply.json, null, 2) + '\n');
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const why = guard.check(req.headers, req.method, info(req));
    if (why) {
      refuse(req.method ?? 'request', req, why);
      return send(res, { status: 403, json: { error: why } });
    }
    try {
      const url = new URL(req.url ?? '/', 'http://service');
      const headers: ApiRequest['headers'] = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const api: ApiRequest = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers, body: () => readJson(req) };
      let reply = await serviceApi(directory, api);
      if (!reply && o.defaultBoard) {
        reply = await directory.use(o.defaultBoard, (b) => boardApi(b, api));
        if (api.method === 'GET' && api.path === '/status' && reply.status === 200) {
          const { name: _name, ...rest } = reply.json as Record<string, unknown>;
          const extra = o.statusExtra?.() ?? {};
          reply = { status: 200, json: { file: extra.file, port: extra.port, ...rest, ...extra } };
        }
      }
      send(res, reply ?? { status: 404, json: { error: 'GET /api/info /api/boards; a board: /api/boards/<name>/doc /status … (WebSocket: /ws/<name>)' } });
    } catch (e) {
      send(res, errorReply(e));
    }
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const deny = (code: number, text: string) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    };
    socket.on('error', () => {});
    const why = guard.check(req.headers, 'GET', info(req));
    if (why) {
      refuse('WebSocket', req, why);
      return deny(403, 'Forbidden');
    }
    const path = (req.url ?? '/').replace(/\?.*$/, '');
    let name = o.defaultBoard;
    const m = WS_PATH.exec(path);
    if (m) {
      try {
        name = decodeURIComponent(m[1]);
      } catch {
        return deny(400, 'Bad Request');
      }
    }
    if (name === undefined) {
      refuse('WebSocket', req, 'no board in the path (use /ws/<board>)');
      return deny(404, 'Not Found');
    }
    let lease;
    try {
      lease = await directory.acquire(name);
    } catch (e) {
      const r = errorReply(e);
      refuse('WebSocket', req, (r.json as { error: string }).error);
      return deny(r.status, r.status === 404 ? 'Not Found' : r.status === 409 ? 'Conflict' : r.status === 400 ? 'Bad Request' : 'Internal Server Error');
    }
    if (socket.destroyed) return lease.release();
    // a handshake ws rejects (bad headers) never calls back: the lease must not outlive the socket
    socket.once('close', lease.release);
    wss.handleUpgrade(req, socket, head, (ws) => {
      lease.board.connect(wsConn(ws)); // the connection now keeps the board loaded: the lease has done its job
      lease.release();
    });
  }

  return {
    http,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => {
          http.off('error', reject);
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}

async function readJson(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}
