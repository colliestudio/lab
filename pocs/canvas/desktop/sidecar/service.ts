import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Board, boardId } from './board';
import { makeActor } from '../../bridge/host';
import { queryNodes } from '../../bridge/query';
import { makeMcpServer, type Service } from './mcp';

// The desktop app's backend: ONE local service for every open .canvas file (the agent-bridge logic,
// multi-file), started and supervised by the Go shell.
//  - Windows join a board over WebSocket: ws://127.0.0.1:<port>/<token>/b/<board>/canvas
//  - Agents: one MCP endpoint for the whole app: http://127.0.0.1:<port>/<token>/mcp (streamable HTTP);
//    `canvas-bridge mcp` is a stdio shim to it (reads the endpoint file). Each MCP session = a seat.
//  - HTTP API per board (same shape as bridge/server.ts, so bridge/cli.ts works with
//    CANVAS_BRIDGE=http://127.0.0.1:<port>/<token>/b/<board>).
//  - Control channel with the Go shell: JSON lines on stdin/stdout (logs go to stderr).
//    shell → service: open/close/list; service → shell: screenshot (hidden window per agent seat), show.
// Binds 127.0.0.1 only; every URL carries a random token (capability URL), written to
// <home>/endpoint.json (0600) for the shim.

const log = (...m: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...m);
const HOME = process.env.CANVAS_HOME ?? join(homedir(), 'Library', 'Application Support', 'Canvas');
const TOKEN = process.env.CANVAS_TOKEN || randomBytes(16).toString('hex');
const PORT = Number(process.env.CANVAS_PORT) || 0;
const STANDALONE = !!process.env.CANVAS_STANDALONE;

const boards = new Map<string, Board>();

function openBoard(path: string): Board {
  const file = resolve(path.replace(/^~(?=\/)/, homedir()));
  const id = boardId(file);
  let b = boards.get(id);
  if (!b) {
    b = new Board(file, log);
    boards.set(id, b);
    log(`opened ${file} as ${id}`);
  }
  return b;
}

function closeBoard(id: string) {
  const b = boards.get(id);
  if (!b) return false;
  b.close();
  boards.delete(id);
  log(`closed ${b.file}`);
  return true;
}

const boardInfo = (b: Board) => ({
  board: b.id,
  name: b.name,
  file: b.file,
  nodes: b.host.store.nodes.size,
  edges: b.host.store.edges.size,
  people: b.people(),
  agents: b.host.seated().map((a) => a.name),
});

// ---------------------------------------------------------------- control channel with the shell
const pending = new Map<number, (v: any) => void>();
let nextId = 1;
const emit = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

function callShell(op: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  if (STANDALONE) return Promise.reject(new Error('no desktop shell (standalone service): screenshots need the app'));
  const id = nextId++;
  emit({ t: 'call', id, op, ...args });
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`${op}: the app did not answer in ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, (v) => {
      clearTimeout(timer);
      if (v.ok) res(v);
      else rej(new Error(v.error ?? `${op} failed`));
    });
  });
}

function onShellCall(m: any): unknown {
  switch (m.op) {
    case 'open':
      return { board: boardInfo(openBoard(String(m.path))) };
    case 'close':
      return { closed: closeBoard(String(m.board)) };
    case 'list':
      return { boards: [...boards.values()].map(boardInfo) };
    default:
      throw new Error(`unknown op ${m.op}`);
  }
}

if (!STANDALONE) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return log(`control: bad line ${line.slice(0, 80)}`);
    }
    if (m.t === 'reply') {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    } else if (m.t === 'call') {
      try {
        emit({ t: 'reply', id: m.id, ok: true, ...(onShellCall(m) as object) });
      } catch (e) {
        emit({ t: 'reply', id: m.id, ok: false, error: (e as Error).message });
      }
    }
  });
  // The shell is gone (crash, kill): save and exit with it.
  rl.on('close', () => stop('shell closed stdin'));
}

// ---------------------------------------------------------------- the service API used by MCP
const base = () => `127.0.0.1:${(http.address() as any).port}/${TOKEN}`;

const service: Service = {
  list: () => [...boards.values()].map(boardInfo),
  open: async (path, show) => {
    const b = openBoard(path);
    if (show && !STANDALONE) await callShell('show', { board: b.id, file: b.file }).catch((e) => log(`show: ${e.message}`));
    return boardInfo(b);
  },
  board: (ref) => {
    if (!ref) {
      if (boards.size === 1) return [...boards.values()][0];
      throw new Error(boards.size ? `several canvases are open; pass board (one of: ${[...boards.values()].map((b) => `${b.id} ${b.name}`).join(', ')})` : 'no canvas is open; use open_canvas');
    }
    const r = ref.toLowerCase();
    const all = [...boards.values()];
    const hit =
      boards.get(ref) ??
      all.find((b) => b.file === resolve(ref)) ??
      all.find((b) => b.name.toLowerCase() === r || b.name.toLowerCase() === `${r}.canvas`) ??
      (() => {
        const hits = all.filter((b) => b.name.toLowerCase().includes(r));
        return hits.length === 1 ? hits[0] : undefined;
      })();
    if (!hit) throw new Error(`no open canvas "${ref}" (open: ${all.map((b) => b.name).join(', ') || 'none'}); use open_canvas with a path`);
    return hit;
  },
  eval: async (b, seat, js) => (await callShell('eval', { board: b.id, ws: `ws://${base()}/b/${b.id}`, seat, js })).result,
  screenshot: async (b, seat, opts) => {
    const t0 = Date.now();
    const r = await callShell('screenshot', { board: b.id, file: b.file, ws: `ws://${base()}/b/${b.id}`, seat, ...opts }, 30_000);
    log(`screenshot ${b.name} for ${seat.name}: ${Date.now() - t0} ms (${r.width}x${r.height}, ${Math.round((r.png.length * 3) / 4 / 1024)} KB)`);
    return r;
  },
};

// ---------------------------------------------------------------- HTTP: per-board API + MCP
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; name: () => string }>();

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const reply = (code: number, v: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v, null, 2) + '\n');
  };
  if (parts[0] !== TOKEN) return reply(403, { error: 'forbidden' });
  try {
    if (parts[1] === 'mcp') return await handleMcp(req, res);
    if (parts[1] === 'boards' && req.method === 'GET') return reply(200, service.list());
    if (parts[1] === 'b' && parts[2]) {
      const b = boards.get(parts[2]);
      if (!b) return reply(404, { error: `no board ${parts[2]}` });
      return await boardApi(b, parts[3] ?? '', req, res, url, reply);
    }
    reply(404, { error: 'GET /<token>/boards; /<token>/b/<board>/{doc,query,log,status,cmd,undo,redo}; /<token>/mcp' });
  } catch (e) {
    reply(500, { error: (e as Error).message });
  }
}

async function boardApi(b: Board, op: string, req: IncomingMessage, res: ServerResponse, url: URL, reply: (c: number, v: unknown) => void) {
  const host = b.host;
  const actorOf = (x: any) => makeActor(String(x?.as ?? req.headers['x-canvas-as'] ?? 'Agent').slice(0, 32), x?.kind === 'tool' ? 'tool' : 'agent');
  if (req.method === 'GET' && op === 'doc') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(host.fileText());
  }
  if (req.method === 'GET' && op === 'query') return reply(200, queryNodes(host.store.doc, Object.fromEntries(url.searchParams)));
  if (req.method === 'GET' && op === 'log') {
    const n = Number(url.searchParams.get('limit')) || 20;
    return reply(200, host.store.log.toArray().slice(-n).map((e) => ({ time: new Date(e.time).toISOString(), actor: e.actor?.name ?? null, text: e.text, targets: e.targets })));
  }
  if (req.method === 'GET' && op === 'status') return reply(200, { ...boardInfo(b), browsers: b.conns.size });
  if (req.method === 'POST' && op === 'cmd') {
    const x = (await body(req)) ?? {};
    const r = host.dispatch(actorOf(x), String(x.name), x.args ?? {});
    return reply(r.ok ? 200 : 400, { ok: r.ok, error: r.error, changed: r.changes.length, touched: r.touched, select: r.select });
  }
  if (req.method === 'POST' && (op === 'undo' || op === 'redo')) {
    const x = (await body(req)) ?? {};
    const done = host.undo(actorOf(x), op === 'redo');
    return reply(200, { ok: done, error: done ? undefined : `nothing to ${op}` });
  }
  reply(404, { error: 'unknown board op' });
}

// One MCP server + transport per session; the session is the agent's seat.
const AGENT_NAMES: Record<string, string> = { 'claude-code': 'Claude', claude: 'Claude', 'codex-mcp-client': 'Codex', codex: 'Codex', cursor: 'Cursor', 'gemini-cli': 'Gemini' };

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const sid = req.headers['mcp-session-id'] as string | undefined;
  const parsed = req.method === 'POST' ? await body(req) : undefined;
  const s = sid ? sessions.get(sid) : undefined;
  if (s) return s.transport.handleRequest(req, res, parsed);
  if (sid || req.method !== 'POST' || parsed?.method !== 'initialize') {
    res.writeHead(sid ? 404 : 400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sid ? 'unknown session (the app restarted?): reconnect' : 'initialize first' }, id: null }));
  }
  // Seat name: X-Canvas-As header (the stdio shim sends $CANVAS_AS), else the client's name.
  const asked = (req.headers['x-canvas-as'] as string | undefined)?.slice(0, 32);
  const client = String(parsed?.params?.clientInfo?.name ?? '');
  const wanted = asked || AGENT_NAMES[client.toLowerCase()] || client.slice(0, 32) || 'Agent';
  const taken = new Set([...sessions.values()].map((x) => x.name()));
  let name = wanted;
  for (let i = 2; taken.has(name); i++) name = `${wanted} ${i}`;
  const seatName = name;
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, name: () => seatName });
      log(`mcp: session ${id.slice(0, 8)} seated as "${seatName}" (client ${client || '?'})`);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  const server = makeMcpServer(service, () => makeActor(seatName, 'agent'));
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

const http = createServer((req, res) => void handle(req, res));
const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => {
  // /<token>/b/<board>/canvas (y-websocket appends the room name)
  const parts = new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean);
  const b = parts[0] === TOKEN && parts[1] === 'b' ? boards.get(parts[2]) : undefined;
  if (!b) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => b.connect(ws));
});

let stopping = false;
function stop(why: string) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${why}): saving ${boards.size} board(s)`);
  for (const id of [...boards.keys()]) closeBoard(id);
  rmSync(join(HOME, 'endpoint.json'), { force: true });
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

for (const f of process.argv.slice(2).filter((a) => !a.startsWith('-'))) openBoard(f);

http.listen(PORT, '127.0.0.1', () => {
  const port = (http.address() as any).port as number;
  const endpoint = { url: `http://127.0.0.1:${port}/${TOKEN}`, mcp: `http://127.0.0.1:${port}/${TOKEN}/mcp`, pid: process.pid };
  mkdirSync(HOME, { recursive: true });
  const p = join(HOME, 'endpoint.json');
  writeFileSync(p, JSON.stringify(endpoint, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  log(`canvas service on 127.0.0.1:${port} (mcp ${endpoint.mcp.replace(TOKEN, '<token>')})`);
  emit({ t: 'event', name: 'ready', port, token: TOKEN, url: endpoint.url, mcp: endpoint.mcp });
});
