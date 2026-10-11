import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Room } from './room';
import { canvasTools } from './tools';

// canvas-service: the desktop app's invisible back end (a Tauri sidecar). One process for the whole
// app: hosts every open .canvas file (agent-bridge rooms), one HTTP API + y-websocket endpoint per
// board under /b/<id>/, and ONE MCP endpoint (/mcp, streamable HTTP) for all agents.
//
//   canvas-service serve [--shell] [--state-dir D] [--port 0]   the service (the app runs this)
//   canvas-service mcp [--as Name]                               stdio MCP shim → the running app
//
// --shell: the Tauri shell talks to it over stdin/stdout, one JSON object per line:
//   service → shell  {t:'ready',port} · {t:'req',rid,op:'screenshot'|'show',…} · {t:'res',rid,…}
//   shell → service  {t:'req',rid,op:'open',file} · {t:'res',rid,ok,png?,error?}
// Logs go to stderr.

const argv = process.argv.slice(2).filter((a) => !a.endsWith('canvas-service') && !a.endsWith('main.ts') && !a.endsWith('.cjs'));
const mode = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'serve';
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const stateDir = resolve(opt('state-dir') ?? process.env.CANVAS_STATE_DIR ?? join(homedir(), 'Library/Application Support/studio.collie.canvas.spike'));
const infoPath = join(stateDir, 'service.json');
const log = (...m: unknown[]) => console.error(new Date().toISOString().slice(11, 23), ...m);

if (mode === 'mcp') void shim();
else serve();

// ------------------------------------------------------------------ stdio shim
async function shim() {
  const base = () => {
    if (process.env.CANVAS_URL) return process.env.CANVAS_URL;
    if (!existsSync(infoPath)) throw new Error('the Canvas app is not running (no service.json); open it first');
    return `http://127.0.0.1:${JSON.parse(readFileSync(infoPath, 'utf8')).port}`;
  };
  const as = opt('as') ?? process.env.CANVAS_AS ?? 'Claude';
  const server = new McpServer({ name: 'canvas', version: '0.1.0' });
  canvasTools(server, base, () => as);
  await server.connect(new StdioServerTransport());
}

// ------------------------------------------------------------------ service
function serve() {
  const shell = argv.includes('--shell');
  const rooms = new Map<string, Room>();
  let port = 0;

  const boardId = (file: string) => createHash('sha1').update(file).digest('hex').slice(0, 8);
  function open(fileArg: string): Room {
    const file = resolve(fileArg);
    if (!file.endsWith('.canvas')) throw new Error(`not a .canvas file: ${file}`);
    const id = boardId(file);
    let r = rooms.get(id);
    if (!r) {
      r = new Room(id, file, log);
      rooms.set(id, r);
      log(`opened ${file} as ${id}`);
    }
    return r;
  }

  // ---- shell channel
  let rid = 0;
  const pending = new Map<number, (m: any) => void>();
  const toShell = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
  const askShell = (op: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<any> =>
    new Promise((res, rej) => {
      if (!shell) return rej(new Error('no desktop shell attached (screenshots need the Canvas app; this service runs standalone)'));
      const id = ++rid;
      const t = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`desktop shell: ${op} timed out`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(t);
        m.ok ? res(m) : rej(new Error(m.error ?? `${op} failed`));
      });
      toShell({ t: 'req', rid: id, op, ...args });
    });
  if (shell) {
    createInterface({ input: process.stdin }).on('line', (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return log(`shell: bad line ${line.slice(0, 80)}`);
      }
      if (m.t === 'res') pending.get(m.rid)?.(m), pending.delete(m.rid);
      else if (m.t === 'req') {
        try {
          if (m.op === 'open') {
            const r = open(m.file);
            toShell({ t: 'res', rid: m.rid, ok: true, id: r.id, name: r.name, file: r.file });
          } else if (m.op === 'close') {
            rooms.get(m.id)?.close();
            rooms.delete(m.id);
            toShell({ t: 'res', rid: m.rid, ok: true });
          } else toShell({ t: 'res', rid: m.rid, ok: false, error: `unknown op ${m.op}` });
        } catch (e) {
          toShell({ t: 'res', rid: m.rid, ok: false, error: (e as Error).message });
        }
      }
    });
    process.stdin.on('end', () => stop()); // the app quit (or crashed): don't outlive it
  }

  // ---- MCP over streamable HTTP: one session = one agent seat
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; as: string }>();
  const seatName = (wanted: string) => {
    const taken = new Set([...sessions.values()].map((s) => s.as));
    if (!taken.has(wanted)) return wanted;
    for (let i = 2; ; i++) if (!taken.has(`${wanted} ${i}`)) return `${wanted} ${i}`;
  };
  async function mcp(req: IncomingMessage, res: ServerResponse, url: URL) {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    let s = sid ? sessions.get(sid) : undefined;
    if (!s) {
      if (sid || req.method !== 'POST' || body?.method !== 'initialize') {
        res.writeHead(sid ? 404 : 400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sid ? 'unknown session' : 'no session' }, id: null }));
      }
      const as = seatName(url.searchParams.get('as') ?? (req.headers['x-canvas-as'] as string | undefined) ?? 'Claude');
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, { transport, as }),
        enableDnsRebindingProtection: true,
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      });
      transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
      const server = new McpServer({ name: 'canvas', version: '0.1.0' });
      canvasTools(server, () => `http://127.0.0.1:${port}`, () => as);
      await server.connect(transport);
      s = { transport, as };
      log(`mcp: new session for seat "${as}"`);
    }
    await s.transport.handleRequest(req, res, body);
  }

  // ---- HTTP
  const reply = (res: ServerResponse, code: number, v: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v, null, 2) + '\n');
  };
  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      // loopback only, and refuse browser pages from other sites (DNS rebinding / drive-by fetches)
      const origin = req.headers.origin;
      if (origin && origin !== 'tauri://localhost' && origin !== `http://127.0.0.1:${port}`) return reply(res, 403, { error: `origin ${origin} not allowed` });
      if (url.pathname === '/mcp') return await mcp(req, res, url);
      if (url.pathname === '/health') return reply(res, 200, { ok: true, port, pid: process.pid, boards: rooms.size, mcpSessions: sessions.size });
      if (url.pathname === '/canvases' && req.method === 'GET') return reply(res, 200, [...rooms.values()].map((r) => r.summary()));
      if (url.pathname === '/canvases' && req.method === 'POST') {
        const b = await readBody(req);
        const r = open(String(b.file));
        if (b.show) askShell('show', { id: r.id, file: r.file, name: r.name }).catch((e) => log(`show: ${e.message}`));
        return reply(res, 200, r.summary());
      }
      const m = url.pathname.match(/^\/b\/([0-9a-f]{8})(\/.*)$/);
      if (m) {
        const room = rooms.get(m[1]);
        if (!room) return reply(res, 404, { error: `no open canvas ${m[1]}` });
        if (m[2] === '/screenshot' && req.method === 'POST') {
          const b = await readBody(req);
          const t0 = Date.now();
          const r = await askShell('screenshot', { id: room.id, seat: String(b.as ?? 'Claude'), nodes: b.nodes, x: b.x, y: b.y, zoom: b.zoom, width: b.width ?? 1000, height: b.height ?? 750, scale: b.scale }, 30_000);
          return reply(res, 200, { png: r.png, width: r.width, height: r.height, ms: Date.now() - t0, timings: r.timings });
        }
        const b = req.method === 'POST' ? await readBody(req) : undefined;
        const r = room.api(req.method ?? 'GET', m[2], url.searchParams, b, req.headers['x-canvas-as'] as string | undefined);
        if (r.raw !== undefined) {
          res.writeHead(r.code, { 'content-type': 'application/json' });
          return res.end(r.raw);
        }
        return reply(res, r.code, r.body);
      }
      reply(res, 404, { error: 'GET /health /canvases /b/<id>/{doc,query,log,status}; POST /canvases {file,show} /b/<id>/{cmd,undo,redo,screenshot}; /mcp' });
    } catch (e) {
      reply(res, 500, { error: (e as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const m = (req.url ?? '').match(/^\/b\/([0-9a-f]{8})\/canvas/);
    const room = m && rooms.get(m[1]);
    const origin = req.headers.origin;
    if (!room || (origin && origin !== 'tauri://localhost' && origin !== `http://127.0.0.1:${port}`)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => room.join(ws));
  });

  http.listen(Number(opt('port') ?? 0), '127.0.0.1', () => {
    port = (http.address() as { port: number }).port;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(infoPath, JSON.stringify({ port, pid: process.pid, started: new Date().toISOString() }) + '\n');
    log(`canvas-service on http://127.0.0.1:${port} (mcp: /mcp; state ${stateDir})`);
    for (const f of argv.filter((a, i) => a.endsWith('.canvas') && argv[i - 1] !== '--state-dir')) open(f);
    if (shell) toShell({ t: 'ready', port, pid: process.pid });
  });

  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    for (const r of rooms.values()) r.close();
    try {
      if (JSON.parse(readFileSync(infoPath, 'utf8')).pid === process.pid) unlinkSync(infoPath);
    } catch {}
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function readBody(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}
