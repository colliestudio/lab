import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { WebSocket } from 'ws';
import { client } from '../bridge/client';
import { freePort, root, until } from '../bridge/process.test-util';
import { registerCoreCommands } from '../src/core/commands';
import { Store } from '../src/core/store';
import { registerPluginLogic } from '../src/plugins/logic';
import { stableSerialize } from './core/canonical';

// `canvas serve` as a real process on a scratch folder: listing, live documents over WebSocket, the
// agent API per board, idle unload, create/rename/delete, a newer-format board, shutdown.

const node = (id: string, text: string) => ({ id, type: 'text', text, x: 0, y: 0, width: 100, height: 50 });
const board = (...nodes: object[]) => stableSerialize({ nodes: nodes as never, edges: [], extra: { 'x-canvas-format': 1 } });
const NEWER = JSON.stringify({ 'x-canvas-format': 99, nodes: [], edges: [] }, null, '\t') + '\n';

let dir: string;
let port: number;
let url: string;
let proc: ChildProcess;
let exited: Promise<number | null>;
const providers: WebsocketProvider[] = [];

const get = async (path: string) => {
  const r = await fetch(url + path);
  return { status: r.status, json: await r.json() };
};
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const list = async () => (await get('/api/boards')).json as { name: string; loaded: boolean; browsers: number; error?: string }[];
const entry = async (name: string) => (await list()).find((e) => e.name === name);
const onDisk = (name: string) => readFileSync(join(dir, name + '.canvas'), 'utf8');

/** A browser stand-in on /ws/<name>: a Y.Doc synced by the same provider the app uses. */
async function browser(name: string) {
  const doc = new Y.Doc();
  const store = new Store({ ydoc: doc });
  registerCoreCommands(store);
  registerPluginLogic(store);
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws/${encodeURIComponent(name)}`, 'canvas', doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  providers.push(provider);
  await until(() => provider.synced);
  return { doc, store, provider, leave: () => provider.destroy() };
}

/** Try a WebSocket upgrade; the status of the refusal, or 101. */
const upgrade = (path: string) =>
  new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('error', () => {});
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-serve-'));
  writeFileSync(join(dir, 'a.canvas'), board(node('x', 'in a')));
  writeFileSync(join(dir, 'b.canvas'), board(node('y', 'in b')));
  writeFileSync(join(dir, 'new.canvas'), NEWER);
  port = await freePort();
  url = `http://127.0.0.1:${port}`;
  // node with tsx as a loader, not the tsx wrapper: signals reach the server itself
  proc = spawn(process.execPath, ['--import', 'tsx', 'server/serve.ts', dir, '--port', String(port), '--idle-ms', '300'], { cwd: root, stdio: 'ignore' });
  exited = new Promise((r) => proc.once('exit', r));
  await until(async () => !!(await fetch(url + '/api/info').catch(() => null))?.ok);
}, 30000);

afterAll(() => {
  for (const p of providers) p.destroy();
  proc?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('canvas serve', () => {
  it('lists every board in the folder, none loaded, and says what it is', async () => {
    expect((await get('/api/info')).json).toMatchObject({ service: 'canvas-serve', format: 1 });
    const boards = await list();
    expect(boards.map((e) => [e.name, e.loaded])).toEqual([['a', false], ['b', false], ['new', false]]);
  });

  it('a browser on /ws/a gets the board and its edits reach the file; other boards stay unloaded and untouched', async () => {
    const bBefore = statSync(join(dir, 'b.canvas')).mtimeMs;
    const c = await browser('a');
    expect(c.store.doc.get('x')!.text).toBe('in a');
    c.store.dispatch('board.add', { id: 'n1', text: 'from the browser' });
    await until(() => onDisk('a').includes('from the browser'));
    expect(await entry('a')).toMatchObject({ loaded: true, browsers: 1 });
    expect(await entry('b')).toMatchObject({ loaded: false });
    expect(statSync(join(dir, 'b.canvas')).mtimeMs).toBe(bBefore);
    c.leave();
    await until(async () => (await entry('a'))?.browsers === 0);
  });

  it('the agent API works per board: an agent edit reaches the browser; the bridge client works against the board URL', async () => {
    const c = await browser('a');
    const r = await post('/api/boards/a/agent/run', { as: 'Claude', name: 'board.add', args: { text: 'from an agent' } });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    await until(() => c.store.doc.nodes.some((n) => n.text === 'from an agent'));
    const status = (await client({ url: `${url}/api/boards/a`, as: 'Claude' }).status()) as { nodes: number; browsers: number };
    expect(status).toMatchObject({ nodes: 3, browsers: 1 });
    c.leave();
  });

  it('an idle board unloads, with its last edit on disk', { timeout: 20000 }, async () => {
    await until(async () => (await entry('a'))?.loaded === false, 10000);
    expect(onDisk('a')).toContain('from an agent');
    expect(readdirSync(join(dir, '.canvas-bridge'))).toContain('a.canvas.ystate');
    // and it loads again on use, with everything
    expect((await get('/api/boards/a/query')).json).toHaveLength(3);
  });

  it('creates, renames and deletes; a board that is open is refused', async () => {
    expect(await post('/api/boards', { name: 'c' })).toMatchObject({ status: 201, json: { name: 'c' } });
    expect(JSON.parse(onDisk('c'))).toEqual({ 'x-canvas-format': 1, nodes: [], edges: [] });
    expect((await post('/api/boards', { name: 'C' })).status).toBe(409);
    expect((await post('/api/boards', { name: '../evil' })).status).toBe(400);

    const c = await browser('c');
    const refused = await post('/api/boards/c/rename', { to: 'd' });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/open \(1 browser\)/);
    expect((await post('/api/boards/c/delete')).status).toBe(409);
    c.leave();
    await until(async () => (await entry('c'))?.browsers === 0);

    expect(await post('/api/boards/c/rename', { to: 'd' })).toMatchObject({ status: 200, json: { name: 'd' } });
    expect(existsSync(join(dir, 'd.canvas'))).toBe(true);
    expect(existsSync(join(dir, 'c.canvas'))).toBe(false);
    expect((await post('/api/boards/d/delete')).status).toBe(200);
    expect((await list()).map((e) => e.name)).toEqual(['a', 'b', 'new']);
    expect(readdirSync(join(dir, '.canvas-bridge', 'trash')).some((f) => /^d-.*\.canvas$/.test(f))).toBe(true);
    expect((await post('/api/boards/d/delete')).status).toBe(404);
  });

  it('a newer-format board is refused everywhere and its file is left alone', async () => {
    expect(await upgrade('/ws/new')).toBe(409);
    const r = await get('/api/boards/new/status');
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/format 99.*supports up to 1/);
    expect((await entry('new'))!.error).toMatch(/format 99/);
    expect(onDisk('new')).toBe(NEWER);
    expect(existsSync(join(dir, '.canvas-bridge', 'new.canvas.ystate'))).toBe(false);
  });

  it('refuses a WebSocket without a board in the path, and an unknown board', async () => {
    expect(await upgrade('/canvas')).toBe(404);
    expect(await upgrade('/ws/nope')).toBe(404);
    expect((await get('/api/boards/nope/status')).status).toBe(404);
    expect((await get('/doc')).status).toBe(404); // no single-board routes in the service
  });

  it('SIGTERM flushes a pending edit and exits 0', async () => {
    const r = await post('/api/boards/b/agent/run', { as: 'Claude', name: 'board.add', args: { text: 'just before the end' } });
    expect(r.status).toBe(200);
    proc.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise((res) => setTimeout(() => res('timeout'), 3000))]);
    expect(code).toBe(0);
    expect(onDisk('b')).toContain('just before the end');
  });
});

describe('canvas serve: the web app', () => {
  let tmp: string;
  const procs: ChildProcess[] = [];
  const start = async (args: string[]) => {
    const p = await freePort();
    procs.push(spawn(process.execPath, ['--import', 'tsx', 'server/serve.ts', join(tmp, 'boards'), '--port', String(p), ...args], { cwd: root, stdio: 'ignore' }));
    const u = `http://127.0.0.1:${p}`;
    await until(async () => !!(await fetch(u + '/api/info').catch(() => null))?.ok);
    return u;
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'canvas-serve-app-'));
    mkdirSync(join(tmp, 'boards'));
    mkdirSync(join(tmp, 'dist'));
    writeFileSync(join(tmp, 'boards', 'a.canvas'), board(node('x', 'in a')));
    writeFileSync(join(tmp, 'boards', 'broken.canvas'), '{nope');
    writeFileSync(join(tmp, 'dist', 'index.html'), '<title>board</title>');
    writeFileSync(join(tmp, 'dist', 'home.html'), '<title>home</title>');
  });
  afterAll(() => {
    for (const p of procs) p.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('serves the list page on / and the board page on /b/<name>, next to the API', { timeout: 30000 }, async () => {
    const u = await start(['--app', join(tmp, 'dist')]);
    expect(await (await fetch(u + '/')).text()).toBe('<title>home</title>');
    const b = await fetch(u + '/b/a');
    expect(b.status).toBe(200);
    expect(await b.text()).toBe('<title>board</title>');
    expect(await (await fetch(u + '/b/nope')).text()).toBe('<title>board</title>'); // the page decides
    expect((await (await fetch(u + '/api/boards')).json()).map((e: { name: string }) => e.name)).toEqual(['a', 'broken']);
  });

  it('a file that is not a canvas is a 422 and stays as it is', async () => {
    const u = await start(['--app', join(tmp, 'dist')]);
    const r = await fetch(u + '/api/boards/broken/status');
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ kind: 'invalid', error: expect.stringContaining('not a canvas file') });
    expect(readFileSync(join(tmp, 'boards', 'broken.canvas'), 'utf8')).toBe('{nope');
    const e = ((await (await fetch(u + '/api/boards')).json()) as { name: string; error?: string }[]).find((x) => x.name === 'broken');
    expect(e!.error).toMatch(/not a canvas file/);
  });

  it('without a build the pages say so and the API still works', async () => {
    const u = await start(['--app', join(tmp, 'nonexistent')]);
    for (const p of ['/', '/b/a']) {
      const r = await fetch(u + p);
      expect(r.status).toBe(503);
      expect(await r.text()).toContain('pnpm build');
    }
    expect((await fetch(u + '/api/boards')).status).toBe(200);
  });
});
