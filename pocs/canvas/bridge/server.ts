import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { parseBridgeArgs } from './args';
import { BoardDirectory } from '../server/core/directory';
import { makeGuard } from '../server/node/guard';
import { FolderStorage } from '../server/node/folder';
import { describeHolder, lockState, markBridge } from '../server/node/lock';
import { createNodeServer } from '../server/node/http';
import { wsConn } from '../server/node/ws';
import { joinRelay, relayUrl } from './relay';
import { startTunnel, type Tunnel } from './tunnel';
import { bridgeLink, DEFAULT_APP, DEPLOYED_ORIGINS, DEV_ORIGINS, parseRoomRef } from '../src/core/bridgeAddress';

// canvas bridge: a Node process that owns one .canvas file and hosts its live document. It is the
// server (server/) with one board pinned: the same Board, API and WebSocket, plus the single-board
// routes (/doc, /status …) and the room/tunnel commands below.
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
const IDLE_MS = 3 * 60_000;
const log = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);
const die = (e: unknown, code = 1): never => {
  console.error(`canvas bridge: ${(e as Error).message}`);
  return process.exit(code);
};

const storage = (() => {
  try {
    return new FolderStorage(file, { file });
  } catch (e) {
    return die(e, 2); // the folder doesn't exist
  }
})();
// A folder that canvas serve serves live has one writer already; a bridge on a file in it would be a second one.
// (Only checks: bridges legitimately share folders with each other.)
// The marker goes first (and is dropped again if the lock is held), so a serve starting at the same moment sees one of the two.
let unmark = () => {};
process.on('exit', () => unmark());
let locked: ReturnType<typeof lockState>;
try {
  unmark = markBridge(storage.dir, { file, port });
  locked = lockState(storage.dir);
} catch (e) {
  console.error(`canvas bridge: cannot read the lock in ${storage.dir}: ${(e as Error).message}`);
  process.exit(2);
}
if (locked.held) {
  unmark();
  const h = locked.holder!;
  console.error(`canvas bridge: ${storage.dir} is served live by ${describeHolder(h)}; open the board there${h.urls[0] ? ` (${h.urls[0]}/)` : ''}, or stop that service, or use a file in another folder`);
  process.exit(2);
}
const name = FolderStorage.nameOf(file);
const directory = new BoardDirectory(storage, { pinned: [name], seatIdleMs: IDLE_MS, log, prefix: false });
const board = await directory.open(name, { create: true }).catch((e) => die(e));

// join: the file and the room merge both ways, so a file that holds some other board (an agent pointed
// at a real board by mistake) would be pushed into the room and the room into it. Only a new or empty
// file, or one this room was saved to before, joins without --merge. (Checked right after the load; a new file is already written by then,
// which is harmless: it is empty.)
if (joinRef) {
  const roomMark = storage.roomMarkPath(name);
  const before = existsSync(roomMark) ? readFileSync(roomMark, 'utf8').trim() : undefined;
  const items = board.host.store.nodes.size + board.host.store.edges.size;
  if (items && before !== joinRef.room && !opts.merge) {
    console.error(
      `canvas bridge: ${file} already holds a board (${items} item${items === 1 ? '' : 's'})${before ? ` saved from room ${before}` : ''}; joining room ${joinRef.room} would merge it into the room and the room into it.\n` +
        'Leave the file out (the bridge then uses a new one), give a new file, or add --merge to do it anyway.',
    );
    process.exit(2);
  }
  mkdirSync(storage.stateDirPath(), { recursive: true });
  writeFileSync(roomMark, joinRef.room + '\n');
}

let relay: ReturnType<typeof joinRelay> | undefined;
let tunnel: Tunnel | undefined;

const server = createNodeServer({
  directory,
  guard,
  log,
  defaultBoard: name,
  statusExtra: () => ({ file, port, room: joinRef ? { id: joinRef.room, online: relay?.online() ?? false } : undefined }),
});

// stdout lines other tools read (an agent copies the link from here): keep the labels stable
const say = (...m: string[]) => console.log(m.join('\n'));

try {
  await server.listen(port, bindHost);
} catch (e) {
  die(e);
}
log(`canvas bridge: ${file} on http://${bindHost}:${port} (browsers: ?bridge=ws://${bindHost}:${port}; app origins allowed: ${guard.origins.join(', ')})`);
if (joinRef) {
  const signal = opts.signal ?? joinRef.signal ?? appUrl.replace(/^http/, 'ws');
  relay = joinRelay({ url: relayUrl(signal, joinRef.room), attach: (ws) => board.connect(wsConn(ws), { relay: true }), log });
  say('', `Joined room ${joinRef.room} through ${signal}`, `Board file (saved while the bridge is here): ${file}`, `Agents on this machine: CANVAS_BRIDGE=http://localhost:${port} pnpm canvas --as <Name> <command>`, 'Ctrl-C leaves the room.', '');
  if (opts.share) say('(share is not needed with join: the bridge connects out, nothing is exposed)');
} else if (sharing) void share();

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

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  relay?.stop();
  tunnel?.stop();
  try {
    await server.close(); // before the flush, so nothing reconnects to a closing board
    await directory.closeAll();
  } finally {
    process.exit(code);
  }
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
