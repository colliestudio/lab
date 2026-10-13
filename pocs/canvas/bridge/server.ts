import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Host, makeActor, type Actor } from './host';
import { queryNodes } from './query';
import { parseBridgeArgs } from './args';
import { makeGuard } from './guard';
import { joinRelay, relayUrl } from './relay';
import { startTunnel, type Tunnel } from './tunnel';
import { bridgeLink, DEFAULT_APP, DEPLOYED_ORIGINS, DEV_ORIGINS, parseRoomRef } from '../src/core/bridgeAddress';

// canvas bridge: a Node process that owns one .canvas file and hosts its live document.
//  - Browsers join over WebSocket (the y-websocket protocol): ?bridge=ws://localhost:5222
//  - Agents and tools call the HTTP API (bridge/cli.ts, bridge/mcp.ts) and appear as players.
//  - The file is the durable record: doc changes are written back (canonical text, clean git diffs);
//    edits to the file (editor, git checkout, a script) flow into the open browsers.
//  - <dir>/.canvas-bridge/<name>.ystate keeps the Yjs history across restarts (so open tabs and
//    the restarted bridge agree on identity); delete it any time, the file wins.
//
// Usage: tsx bridge/server.ts <file.canvas> [--port 5222] [--host 127.0.0.1] [--allow-origin URL]…
//  Binds 127.0.0.1 by default. A browser app on another origin (the vite dev server) must be listed:
//  --allow-origin http://mini.internal:5284 (or $CANVAS_ALLOW_ORIGIN, comma separated); see guard.ts.
//
//  share <file>       also open a quick tunnel, require a pairing token from anything that comes through
//                     it, allow the deployed app, and print the link to send (--no-tunnel: local link only)
//  join <room> [file] enter an existing room as one more peer (the room's link or id): the bridge connects
//                     out through the signaling Worker's relay, so no port or tunnel is needed. The room
//                     is saved to the file while the bridge is there. A file that already holds another
//                     board is refused (joining would merge it into the room); --merge does it anyway.
//                     See ideas/bridge-ux.md.

let opts: ReturnType<typeof parseBridgeArgs>;
try {
  opts = parseBridgeArgs(process.argv.slice(2));
} catch (e) {
  console.error(`canvas bridge: ${(e as Error).message}\nusage: tsx bridge/server.ts [share|join ROOM] <file.canvas> [--port N] [--host H] [--allow-origin URL]… [--share --no-tunnel --app URL --token T --join ROOM --signal URL --merge]`);
  process.exit(2);
}
let joinRef: ReturnType<typeof parseRoomRef> | undefined;
try {
  joinRef = opts.join ? parseRoomRef(opts.join) : undefined;
} catch (e) {
  console.error(`canvas bridge: ${(e as Error).message}`);
  process.exit(2);
}
const file = resolve(opts.fileGiven || !joinRef ? opts.file : `room-${joinRef.room}.canvas`);
const port = opts.port ?? (Number(process.env.CANVAS_BRIDGE_PORT) || 5222);
const bindHost = opts.host ?? '127.0.0.1';
// A joined bridge dials out and listens only on loopback: nothing to pair. A shared one is public.
const sharing = !!opts.share && !joinRef;
const token = sharing ? (opts.token ?? randomBytes(12).toString('base64url')) : opts.token;
const appUrl = (opts.app ?? DEFAULT_APP).replace(/\/+$/, '');
const guard = makeGuard({
  port,
  token,
  allowOrigins: [...opts.allowOrigins, ...(process.env.CANVAS_ALLOW_ORIGIN?.split(',') ?? []), ...(sharing ? [appUrl, ...DEPLOYED_ORIGINS, ...DEV_ORIGINS] : [])],
});
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

// join: the file and the room merge both ways, so a file that holds some other board (an agent pointed
// at a real board by mistake) would be pushed into the room and the room into it. Only a new or empty
// file, or one this room was saved to before, joins without --merge.
const roomMark = join(stateDir, `${basename(file)}.room`);
if (joinRef) {
  const before = existsSync(roomMark) ? readFileSync(roomMark, 'utf8').trim() : undefined;
  const items = host.store.nodes.size + host.store.edges.size;
  if (items && before !== joinRef.room && !opts.merge) {
    console.error(
      `canvas bridge: ${file} already holds a board (${items} item${items === 1 ? '' : 's'})${before ? ` saved from room ${before}` : ''}; joining room ${joinRef.room} would merge it into the room and the room into it.\n` +
        'Leave the file out (the bridge then uses a new one), give a new file, or add --merge to do it anyway.',
    );
    process.exit(2);
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(roomMark, joinRef.room + '\n');
}

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
const MSG_QUERY_AWARENESS = 3;
const awareness = new awarenessProtocol.Awareness(host.ydoc);
awareness.setLocalState(null); // the bridge itself is no player
const conns = new Map<WebSocket, Set<number>>();
/** Connections that are the room relay (many browsers behind one socket): never echo a frame back to them. */
const relayConns = new Set<WebSocket>();

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
  for (const ws of conns.keys()) if (!(relayConns.has(ws) && ws === origin)) send(ws, msg);
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
// the query may carry the pairing token: never log it
const refuse = (what: string, req: IncomingMessage, why: string) => log(`refused ${what} ${(req.url ?? '').replace(/\?.*$/, '')}: ${why}`);
const info = (req: IncomingMessage) => ({ url: req.url, remote: req.socket.remoteAddress });
const wss = new WebSocketServer({
  server: http,
  verifyClient: ({ req }, done) => {
    const why = guard.check(req.headers, 'GET', info(req));
    if (why) refuse('WebSocket', req, why);
    done(!why, 403, 'Forbidden');
  },
});
wss.on('connection', (ws) => attach(ws));

/**
 * Serve one connection speaking the y-websocket protocol: a browser that dialed in, or (relay) the
 * socket this bridge opened to the room's relay, which stands for every browser in the room.
 */
function attach(ws: WebSocket, relay = false) {
  conns.set(ws, new Set());
  if (relay) relayConns.add(ws);
  ws.binaryType = 'arraybuffer';
  ws.on('message', (data: ArrayBuffer, isBinary: boolean) => {
    if (!isBinary) return; // the relay's pong
    // A joined room's peers reach this through the relay: a malformed frame must not take the bridge down.
    try {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const enc = encoding.createEncoder();
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, host.ydoc, ws);
        if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
      } else if (type === MSG_QUERY_AWARENESS) {
        // the relay sends this when a browser connects to it: introduce ourselves (our state vector makes
        // it send everything we lack) and our presence
        sendStep1(ws);
        sendPresence(ws);
      }
    } catch (e) {
      log(`dropped a malformed frame${relay ? ' from the room' : ''}: ${(e as Error).message}`);
    }
  });
  ws.on('close', () => {
    const mine = conns.get(ws);
    conns.delete(ws);
    relayConns.delete(ws);
    if (mine?.size) awarenessProtocol.removeAwarenessStates(awareness, [...mine], null);
  });
  // hello: our state vector, everyone's presence (browsers and seated agents)
  sendStep1(ws);
  sendPresence(ws);
  if (relay) {
    // and ask the room who is there
    const q = encoding.createEncoder();
    encoding.writeVarUint(q, MSG_QUERY_AWARENESS);
    send(ws, encoding.toUint8Array(q));
  }
}

function sendStep1(ws: WebSocket) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, host.ydoc);
  send(ws, encoding.toUint8Array(enc));
}

function sendPresence(ws: WebSocket) {
  const others = [...awareness.getStates().keys()];
  if (others.length) send(ws, awarenessMsg(awareness, others));
  for (const a of seatAwareness) send(ws, awarenessMsg(a, [a.clientID]));
}

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
  const why = guard.check(req.headers, req.method, info(req));
  if (why) {
    refuse(req.method ?? 'request', req, why);
    res.writeHead(403, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ error: why }) + '\n');
  }
  const url = new URL(req.url ?? '/', 'http://bridge');
  const reply = (code: number, v: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
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
      return reply(200, { file, port, nodes: host.store.nodes.size, edges: host.store.edges.size, browsers: conns.size - relayConns.size, room: joinRef ? { id: joinRef.room, online: relay?.online() ?? false } : undefined, actors: host.seated() });
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
    // chat: say / read / wait as an actor (see ideas/chat.md); the messages live in the doc
    if (req.method === 'POST' && url.pathname === '/chat/say') {
      const b = await body(req);
      const actor = actorOf(b, req);
      try {
        const m = host.say(actor, String(b.text ?? ''), b.node ? String(b.node) : undefined);
        log(`${actor.name}: said ${JSON.stringify(m.text.slice(0, 80))}`);
        return reply(200, { ok: true, message: m });
      } catch (e) {
        return reply(400, { ok: false, error: (e as Error).message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/chat/read') {
      const q = Object.fromEntries(url.searchParams) as Record<string, string | undefined>;
      const actor = actorOf({ as: q.as, kind: q.kind }, req);
      return reply(200, host.readChat(actor, { limit: Number(q.limit) || undefined, onlyNew: q.new === '1' || q.new === 'true' }));
    }
    if (req.method === 'GET' && url.pathname === '/chat/wait') {
      const q = Object.fromEntries(url.searchParams) as Record<string, string | undefined>;
      const actor = actorOf({ as: q.as, kind: q.kind }, req);
      const ms = Math.min(Math.max(Number(q.timeout ?? 50), 1), 290) * 1000;
      const msgs = await host.waitChat(actor, ms);
      return reply(200, msgs ?? { waiting: true, error: `no new messages after ${ms / 1000}s; wait again` });
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
      let done: boolean;
      try {
        done = host.undo(actor, url.pathname === '/redo');
      } catch (e) {
        return reply(400, { ok: false, error: (e as Error).message });
      }
      return reply(200, { ok: done, error: done ? undefined : `nothing to ${url.pathname.slice(1)} for ${actor.name} (each actor undoes only its own steps, while it stays seated)` });
    }
    reply(404, { error: 'GET /doc /query /log /status /view/<name> /wait/<name>?timeout=S /chat/read?new=1&limit=N /chat/wait?timeout=S; POST /chat/say {as,text,node} POST /cmd {as,name,args} /undo {as} /redo {as}' });
  } catch (e) {
    reply(500, { error: (e as Error).message });
  }
}

let relay: ReturnType<typeof joinRelay> | undefined;
let tunnel: Tunnel | undefined;

// stdout lines other tools read (an agent copies the link from here): keep the labels stable
const say = (...m: string[]) => console.log(m.join('\n'));

http.listen(port, bindHost, () => {
  log(`canvas bridge: ${file} on http://${bindHost}:${port} (browsers: ?bridge=ws://${bindHost}:${port}; app origins allowed: ${guard.origins.join(', ')})`);
  if (joinRef) {
    const signal = opts.signal ?? joinRef.signal ?? appUrl.replace(/^http/, 'ws');
    relay = joinRelay({ url: relayUrl(signal, joinRef.room), attach: (ws) => attach(ws, true), log });
    say('', `Joined room ${joinRef.room} through ${signal}`, `Board file (saved while the bridge is here): ${file}`, `Agents on this machine: CANVAS_BRIDGE=http://localhost:${port} pnpm canvas --as <Name> <command>`, 'Ctrl-C leaves the room.', '');
    if (opts.share) say('(share is not needed with join: the bridge connects out, nothing is exposed)');
  } else if (sharing) void share();
});

/** share: the tunnel (unless --no-tunnel) and the link to send. */
async function share() {
  let address = { url: `ws://localhost:${port}`, token };
  if (!opts.noTunnel) {
    try {
      tunnel = await startTunnel(port);
    } catch (e) {
      console.error(`canvas bridge: ${(e as Error).message}`);
      return stop(1);
    }
    address = { url: tunnel.url.replace(/^https/, 'wss'), token };
  }
  say(
    '',
    tunnel ? 'Send this link (it opens the app straight into this board; the bridge is public while it runs):' : `Local link (a quick tunnel would make it reachable from other machines; drop --no-tunnel):`,
    bridgeLink(appUrl, address),
    '',
    `Bridge address: ${address.url}   pairing token: ${token}`,
    `Board file: ${file}`,
    `Agents on this machine: CANVAS_BRIDGE=http://localhost:${port} pnpm canvas --as <Name> <command>`,
    'Ctrl-C stops the bridge' + (tunnel ? ' and the tunnel.' : '.'),
    '',
  );
}

const stop = (code = 0) => {
  clearTimeout(writeTimer);
  relay?.stop();
  tunnel?.stop();
  writeOut();
  saveState();
  process.exit(code);
};
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
