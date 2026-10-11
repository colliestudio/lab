import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocketServer, type WebSocket } from 'ws';
import { Host, makeActor, type Actor } from './host';
import { queryNodes } from './query';

// canvas bridge: a Node process that owns one .canvas file and hosts its live document.
//  - Browsers join over WebSocket (the y-websocket protocol): ?bridge=ws://localhost:5222
//  - Agents and tools call the HTTP API (bridge/cli.ts, bridge/mcp.ts) and appear as players.
//  - The file is the durable record: doc changes are written back (canonical text, clean git diffs);
//    edits to the file (editor, git checkout, a script) flow into the open browsers.
//  - <dir>/.canvas-bridge/<name>.ystate keeps the Yjs history across restarts (so open tabs and
//    the restarted bridge agree on identity); delete it any time, the file wins.
//
// Usage: tsx bridge/server.ts <file.canvas> [--port 5222]

const args = process.argv.slice(2);
const file = resolve(args.find((a) => !a.startsWith('--')) ?? 'board.canvas');
const port = Number(args[args.indexOf('--port') + 1]) || Number(process.env.CANVAS_BRIDGE_PORT) || 5222;
const stateDir = join(dirname(file), '.canvas-bridge');
const statePath = join(stateDir, `${basename(file)}.ystate`);
const IDLE_MS = 3 * 60_000;

const host = new Host();
const log = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);

// ---------------------------------------------------------------- start: state, then the file
if (existsSync(statePath)) {
  Y.applyUpdate(host.ydoc, readFileSync(statePath));
  log(`restored live state from ${statePath}`);
}
let lastText = '';
if (existsSync(file)) {
  const text = readFileSync(file, 'utf8');
  if (host.store.nodes.size) host.written(host.fileText()); // base = what the state says; the file's edits since merge in
  const line = host.applyFile(text);
  if (line) log(line);
  host.written(text);
  lastText = text;
} else {
  writeOut();
}
host.store.undoManager.clear();

function writeOut() {
  // The file changed on disk since we last wrote or read it (an edit the watcher hasn't applied
  // yet): merge it in first, never write over it. If it can't be read (invalid JSON), leave it.
  const disk = readDisk();
  if (disk !== undefined && disk !== lastText && !ingest(disk)) return;
  const text = host.fileText();
  if (text === lastText) return;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  lastText = text;
  host.written(text);
}

function saveState() {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, Y.encodeStateAsUpdate(host.ydoc));
}

// doc → file (debounced) and state sidecar
let writeTimer: ReturnType<typeof setTimeout> | undefined;
host.ydoc.on('afterTransaction', (tr: Y.Transaction) => {
  if (!tr.changed.size && !tr.deleteSet.clients.size) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeOut();
    saveState();
  }, Host.fromFile(tr.origin) ? 50 : 300);
});

function readDisk(): string | undefined {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/** Apply the file's text to the live doc (3-way merge). False when it isn't valid. */
function ingest(text: string): boolean {
  try {
    const line = host.applyFile(text);
    lastText = text;
    if (line) log(`file: ${line}`);
    return true;
  } catch (e) {
    log(`file: not applied (${(e as Error).message}); fix the JSON and save again`);
    return false;
  }
}

// file → doc: watch the directory (editors and git replace the file instead of writing in place)
let readTimer: ReturnType<typeof setTimeout> | undefined;
watch(dirname(file), (_ev, name) => {
  if (name !== basename(file)) return;
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    const text = readDisk();
    if (text === undefined || text === lastText) return; // gone, or our own write
    // normalize the file to canonical form (after the doc settled)
    if (ingest(text)) setTimeout(writeOut, 100);
  }, 80);
});

// ---------------------------------------------------------------- WebSocket: browsers (y-websocket protocol)
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const awareness = new awarenessProtocol.Awareness(host.ydoc);
awareness.setLocalState(null); // the bridge itself is no player
const conns = new Map<WebSocket, Set<number>>();

const send = (ws: WebSocket, data: Uint8Array) => {
  if (ws.readyState === ws.OPEN) ws.send(data);
};
const awarenessMsg = (a: awarenessProtocol.Awareness, clients: number[]) => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(a, clients));
  return encoding.toUint8Array(enc);
};

host.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeUpdate(enc, update);
  const msg = encoding.toUint8Array(enc);
  for (const ws of conns.keys()) if (ws !== origin) send(ws, msg);
});

// browsers' presence: relay between them
awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
  const changed = [...added, ...updated, ...removed];
  if (origin instanceof Object && conns.has(origin as WebSocket)) {
    const mine = conns.get(origin as WebSocket)!;
    for (const c of added) mine.add(c);
    for (const c of removed) mine.delete(c);
  }
  const msg = awarenessMsg(awareness, changed);
  for (const ws of conns.keys()) send(ws, msg);
});

// agents' presence: each actor has its own awareness (own client id): relay its updates too
const seatAwareness = new Set<awarenessProtocol.Awareness>();
host.onSeat((a, joined) => {
  if (joined) {
    seatAwareness.add(a);
    a.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const msg = awarenessMsg(a, [...added, ...updated, ...removed]);
      for (const ws of conns.keys()) send(ws, msg);
    });
  } else {
    const msg = awarenessMsg(a, [a.clientID]);
    for (const ws of conns.keys()) send(ws, msg);
    seatAwareness.delete(a);
  }
});
setInterval(() => host.sweep(IDLE_MS), 10_000);

const http = createServer((req, res) => void api(req, res));
const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws) => {
  conns.set(ws, new Set());
  ws.binaryType = 'arraybuffer';
  ws.on('message', (data: ArrayBuffer) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    const enc = encoding.createEncoder();
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, host.ydoc, ws);
      if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
    }
  });
  ws.on('close', () => {
    const mine = conns.get(ws);
    conns.delete(ws);
    if (mine?.size) awarenessProtocol.removeAwarenessStates(awareness, [...mine], null);
  });
  // hello: our state vector, everyone's presence (browsers and seated agents)
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, host.ydoc);
  send(ws, encoding.toUint8Array(enc));
  const others = [...awareness.getStates().keys()];
  if (others.length) send(ws, awarenessMsg(awareness, others));
  for (const a of seatAwareness) send(ws, awarenessMsg(a, [a.clientID]));
});

// ---------------------------------------------------------------- HTTP API: agents and tools
async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}

function actorOf(b: { as?: string; kind?: string } | undefined, req: IncomingMessage): Actor {
  const name = b?.as ?? (req.headers['x-canvas-as'] as string | undefined) ?? 'Agent';
  return makeActor(String(name).slice(0, 32), b?.kind === 'tool' ? 'tool' : 'agent');
}

async function api(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const reply = (code: number, v: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(v, null, 2) + '\n');
  };
  try {
    if (req.method === 'GET' && url.pathname === '/doc') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(host.fileText());
    }
    if (req.method === 'GET' && url.pathname === '/query') {
      const q = Object.fromEntries(url.searchParams);
      return reply(200, queryNodes(host.store.doc, q));
    }
    if (req.method === 'GET' && url.pathname === '/log') {
      const n = Number(url.searchParams.get('limit')) || 20;
      return reply(200, host.store.log.toArray().slice(-n).map((e) => ({ time: new Date(e.time).toISOString(), actor: e.actor?.name ?? null, actorId: e.actor?.id ?? null, text: e.text, targets: e.targets })));
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return reply(200, { file, port, nodes: host.store.nodes.size, edges: host.store.edges.size, browsers: conns.size, actors: host.seated() });
    }
    const viewMatch = req.method === 'GET' && /^\/(view|wait)\/([\w.-]+)$/.exec(url.pathname);
    if (viewMatch) {
      const q = Object.fromEntries(url.searchParams) as Record<string, string | undefined>;
      const actor = actorOf({ as: q.as, kind: q.kind }, req);
      try {
        if (viewMatch[1] === 'view') return reply(200, host.view(actor, viewMatch[2], q));
        const ms = Math.min(Math.max(Number(q.timeout ?? 50), 1), 290) * 1000;
        const v = await host.wait(actor, viewMatch[2], q, ms);
        return reply(200, v === undefined ? { waiting: true, error: `still not ready after ${ms / 1000}s; wait again` } : v);
      } catch (e) {
        return reply(400, { error: (e as Error).message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/cmd') {
      const b = await body(req);
      const actor = actorOf(b, req);
      const r = host.dispatch(actor, String(b.name), b.args ?? {});
      if (r.ok && r.changes.length) log(`${actor.name}: ${b.name} ${JSON.stringify(b.args ?? {}).slice(0, 120)}`);
      return reply(r.ok ? 200 : 400, { ok: r.ok, error: r.error, changed: r.changes.length, touched: r.touched, select: r.select });
    }
    if (req.method === 'POST' && (url.pathname === '/undo' || url.pathname === '/redo')) {
      const b = await body(req);
      const actor = actorOf(b, req);
      const done = host.undo(actor, url.pathname === '/redo');
      return reply(200, { ok: done, error: done ? undefined : `nothing to ${url.pathname.slice(1)} for ${actor.name} (each actor undoes only its own steps, while it stays seated)` });
    }
    reply(404, { error: 'GET /doc /query /log /status /view/<name> /wait/<name>?timeout=S; POST /cmd {as,name,args} /undo {as} /redo {as}' });
  } catch (e) {
    reply(500, { error: (e as Error).message });
  }
}

http.listen(port, () => log(`canvas bridge: ${file} on http://localhost:${port} (browsers: ?bridge=ws://localhost:${port})`));
const stop = () => {
  clearTimeout(writeTimer);
  writeOut();
  saveState();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
