import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import { BoardFile, ROUTES, boardId, canonicalPath, type Log } from './board';
import { makeGuard, type Guard } from './guard';

// The bridge as one service for many .canvas files: one HTTP + WebSocket server, one BoardFile per
// open file. Used by `pnpm bridge <file>` (one board, legacy routes) and by the desktop app (many
// boards, the built web app served from the same origin, the MCP endpoint plugged in as a handler).
//
// Routes
//   GET  /boards                    open boards
//   *    /b/<id>/doc|query|log|status|cmd|undo|redo   a board's HTTP API (see board.ts)
//   WS   /b/<id>/…                  a board's live doc (y-websocket; the app joins ?bridge=ws://…/b/<id>)
//   *    /doc /query … and WS /…    the default (first) board: what the CLI and old links use
//   GET  /…                         static files (the web app), when `staticDir` is set

export interface ServiceOptions {
  port?: number;
  /** Interface to bind; undefined = all. Pass 127.0.0.1 (both callers do). */
  host?: string;
  /** Serve this directory (the built web app) for other GETs. */
  staticDir?: string;
  /** Extra headers on static HTML (e.g. a CSP). */
  htmlHeaders?: Record<string, string>;
  /** Page origins besides the service's own that may use it from a browser (the vite dev server); see guard.ts. */
  allowOrigins?: string[];
  /** Where each board keeps its Yjs sidecar, given the board's file; default `<dir>/.canvas-bridge`. */
  stateDir?: (file: string) => string | undefined;
  log?: Log;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

export class BridgeService {
  readonly boards = new Map<string, BoardFile>();
  readonly http: Server;
  private wss = new WebSocketServer({ noServer: true });
  private handlers: Handler[] = [];
  private boardListeners = new Set<(b: BoardFile, opened: boolean) => void>();
  port = 0;
  /** Set once listening (it needs the port). Every request and WebSocket goes through it. */
  guard: Guard = makeGuard({ port: 0 });
  readonly log: Log;

  constructor(private opts: ServiceOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.http = createServer((req, res) => void this.route(req, res));
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const board = this.boardForPath(url.pathname);
      const why = this.guard.check(req.headers, 'GET');
      if (why) this.log(`refused WebSocket ${req.url ?? ''}: ${why}`);
      if (!board || why) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => board.connect(ws));
    });
  }

  listen(): Promise<number> {
    return new Promise((ok, fail) => {
      this.http.once('error', fail);
      this.http.listen(this.opts.port ?? 0, this.opts.host, () => {
        const a = this.http.address();
        this.port = typeof a === 'object' && a ? a.port : 0;
        this.guard = makeGuard({ port: this.port, allowOrigins: this.opts.allowOrigins });
        ok(this.port);
      });
    });
  }

  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Plug in more routes (e.g. /mcp); a handler returns true when it answered. */
  use(h: Handler) {
    this.handlers.push(h);
  }

  onBoard(fn: (b: BoardFile, opened: boolean) => void) {
    this.boardListeners.add(fn);
    return () => this.boardListeners.delete(fn);
  }

  /** Host a file (idempotent: the same path = the same board). Creates the file when missing. */
  open(file: string): BoardFile {
    const id = boardId(file);
    let b = this.boards.get(id);
    if (!b) {
      b = new BoardFile(file, this.log, undefined, this.opts.stateDir?.(canonicalPath(file)));
      this.boards.set(id, b);
      this.log(`opened ${b.file} as ${id}`);
      for (const fn of this.boardListeners) fn(b, true);
    }
    return b;
  }

  close(id: string) {
    const b = this.boards.get(id);
    if (!b) return;
    b.close();
    this.boards.delete(id);
    this.log(`closed ${b.file}`);
    for (const fn of this.boardListeners) fn(b, false);
  }

  closeAll() {
    for (const id of [...this.boards.keys()]) this.close(id);
    this.http.close();
  }

  /** A board by id, file path, or file name (unique prefix). Without a ref: the only open board. */
  find(ref?: string): BoardFile {
    const all = [...this.boards.values()];
    if (!ref) {
      if (all.length === 1) return all[0];
      throw new Error(all.length ? `${all.length} boards open: pass board (${all.map((b) => b.id).join(', ')})` : 'no board open: open_canvas first');
    }
    const byId = this.boards.get(ref) ?? all.find((b) => b.file === canonicalPath(ref));
    if (byId) return byId;
    const r = ref.toLowerCase();
    const hits = all.filter((b) => b.name.toLowerCase().startsWith(r) || b.id.startsWith(r));
    if (hits.length === 1) return hits[0];
    throw new Error(hits.length ? `"${ref}" matches ${hits.map((b) => b.id).join(', ')}` : `no open board "${ref}" (open: ${all.map((b) => b.id).join(', ') || 'none'})`);
  }

  wsUrl(b: BoardFile) {
    return `ws://127.0.0.1:${this.port}/b/${b.id}`;
  }

  private boardForPath(path: string): BoardFile | undefined {
    const m = /^\/b\/([^/]+)/.exec(path);
    if (m) return this.boards.get(m[1]);
    return this.boards.values().next().value; // legacy: the default (first) board
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const why = this.guard.check(req.headers, req.method);
    if (why) {
      this.log(`refused ${req.method ?? 'request'} ${req.url ?? ''}: ${why}`);
      res.writeHead(403, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: why }) + '\n');
    }
    try {
      for (const h of this.handlers) if (await h(req, res, url)) return;
      if (url.pathname === '/boards') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify([...this.boards.values()].map((b) => b.status()), null, 2) + '\n');
      }
      const m = /^\/b\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (m) {
        const b = this.boards.get(m[1]);
        if (!b) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no such board"}\n');
        return b.api(req, res, m[2] ?? '/status', url);
      }
      if (/^\/(doc|query|log|status|cmd|undo|redo|view\/[\w.-]+|wait\/[\w.-]+|chat\/(say|read|wait))$/.test(url.pathname)) {
        const b = this.boards.values().next().value;
        if (!b) return void res.writeHead(404).end('{"error":"no board open"}\n');
        return b.api(req, res, url.pathname, url, { port: this.port });
      }
      if (this.opts.staticDir && req.method === 'GET') return this.serveStatic(res, url.pathname);
      res.writeHead(404, { 'content-type': 'application/json' }).end('' + JSON.stringify({ error: `GET /boards, /b/<id>/…; default board: ${ROUTES}` }) + '\n');
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }) + '\n');
    }
  }

  private serveStatic(res: ServerResponse, path: string) {
    const root = this.opts.staticDir!;
    let p = normalize(join(root, decodeURIComponent(path)));
    if (!p.startsWith(root)) return void res.writeHead(403).end();
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(root, 'index.html');
    const type = TYPES[extname(p)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, ...(type.startsWith('text/html') ? this.opts.htmlHeaders : {}) });
    res.end(readFileSync(p));
  }
}
