import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import { openRelay } from '../src/core/relay';
import { Store } from '../src/core/store';
import { registerCoreCommands } from '../src/core/commands';
import { registerBoardLogic } from '../src/plugins/board/logic';
import { relayRecipients, relayRole, type RelayRole } from '../signaling/src/hub';

// `bridge join` end to end, minus the Worker: a stand-in relay (same routing function as the Durable
// Object), the real bridge process, and a "browser" using the app's own relay client.

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
const freePort = () => new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const until = async (cond: () => boolean | Promise<boolean>, ms = 15000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

async function fakeRelay() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const roles = new Map<NodeWebSocket, RelayRole>();
  const paths: string[] = [];
  wss.on('connection', (ws, req) => {
    const role = relayRole(new URL(req.url!, 'http://x'))!;
    paths.push(req.url!);
    roles.set(ws, role);
    // as the Durable Object does: a browser arriving asks the bridges to introduce themselves
    if (role === 'peer') for (const [c, r] of roles) if (r === 'bridge') c.send(Uint8Array.of(3), { binary: true });
    ws.on('close', () => roles.delete(ws));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return ws.send('{"type":"pong"}');
      for (const to of relayRecipients({ conn: ws, role }, [...roles].map(([conn, r]) => ({ conn, role: r })))) to.send(data, { binary: true });
    });
  });
  cleanup.push(() => wss.close());
  return { port: (wss.address() as net.AddressInfo).port, roles, paths };
}

describe('bridge join', () => {
  it('enters a room through the relay, saves the room to the file, serves agents, leaves on SIGINT', async () => {
    const relay = await fakeRelay();
    const dir = mkdtempSync(join(tmpdir(), 'bridge-join-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'room.canvas');
    const port = await freePort();
    const proc: ChildProcess = spawn('node_modules/.bin/tsx', ['bridge/server.ts', 'join', `http://127.0.0.1:${relay.port}/?room=abc123`, file, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout!.on('data', (d) => (out += d));
    proc.stderr!.on('data', (d) => (out += d));
    cleanup.push(() => proc.kill('SIGKILL'));
    const exited = new Promise<number | null>((r) => proc.on('exit', r));

    await until(() => relay.paths.length > 0);
    expect(relay.paths[0]).toBe('/r/abc123?relay=bridge');
    await until(() => /Joined room abc123/.test(out));

    // a browser in the room (relay=peer), on its own Y.Doc
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState({ user: { id: 'p1', name: 'Alex', color: '#4363d8' }, cursor: null, sel: [], held: [] });
    const conn = openRelay({ url: `ws://127.0.0.1:${relay.port}/r/abc123?relay=peer`, doc, awareness, WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket });
    cleanup.push(() => conn.destroy());
    const store = new Store({ ydoc: doc });
    registerCoreCommands(store);
    registerBoardLogic(store);
    store.dispatch('board.add', { type: 'text', text: 'from the browser', x: 0, y: 0 });
    await until(() => existsSync(file) && readFileSync(file, 'utf8').includes('from the browser'));

    // an agent on this machine
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    expect(await post('/cmd', { as: 'Claude', name: 'board.add', args: { type: 'text', text: 'from the agent', x: 50, y: 0 } })).toMatchObject({ ok: true });
    await until(() => store.doc.nodes.some((n) => n.text === 'from the agent'));
    await until(() => [...awareness.getStates().values()].some((s: any) => s.user?.name === 'Claude'));
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({ room: { id: 'abc123', online: true } });

    // what a room peer can do is edit the board: nothing in the document is a path or a command to the bridge
    store.dispatch('board.add', { type: 'text', text: '../../etc/passwd; rm -rf ~', x: 0, y: 99 });
    await until(() => readFileSync(file, 'utf8').includes('rm -rf'));
    expect(JSON.parse(readFileSync(file, 'utf8')).nodes.length).toBe(3);

    proc.kill('SIGINT');
    expect(await exited).toBe(0);
    await until(() => relay.roles.size === 1, 3000).catch(() => { throw new Error(`roles: ${[...relay.roles.values()]} paths ${relay.paths}`); }); // only the browser is left
  }, 30000);
});
