import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardDirectory } from '../core/directory';
import { stableSerialize } from '../core/canonical';
import { MemoryStorage } from '../core/memory';
import { createNodeServer, type NodeServer, type NodeServerOptions } from './http';
import { createStaticApp } from './static';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGuard } from './guard';

let server: NodeServer;
let dir: BoardDirectory;
afterEach(async () => {
  await server.close();
  await dir.closeAll();
});

async function start(app?: NodeServerOptions['app']) {
  const st = new MemoryStorage({ demo: stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 1 } }) });
  dir = new BoardDirectory(st, { sweepMs: 0, log: () => {} });
  const log = () => {};
  server = createNodeServer({ directory: dir, guard: makeGuard({ port: 0 }), log, app });
  await server.listen(0, '127.0.0.1');
  return (server.http.address() as AddressInfo).port;
}

/** An upgrade request the ws library rejects (no Sec-WebSocket-Key): the status it answers with. */
const badUpgrade = (port: number, path: string) =>
  new Promise<number>((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { connection: 'Upgrade', upgrade: 'websocket', host: `127.0.0.1:${port}` } });
    req.on('response', (res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    req.on('upgrade', (res) => resolve(res.statusCode ?? 0));
    req.on('error', () => resolve(0));
    req.end();
  });

describe('createNodeServer', () => {
  it('a rejected WebSocket handshake does not leave the board leased', async () => {
    const port = await start();
    expect(await badUpgrade(port, '/ws/demo')).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    const board = dir.loaded('demo')!;
    expect(board).toBeDefined();
    expect(board.leases).toBe(0);
    await expect(dir.rename('demo', 'other')).resolves.toBe('other'); // not "open (1 session)"
  });
});

describe('with the web app mounted', () => {
  const get = (port: number, path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers });

  it('serves pages, leaves the API as it was, and keeps the guard on /api', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'canvas-http-app-'));
    try {
      writeFileSync(join(tmp, 'index.html'), 'board');
      writeFileSync(join(tmp, 'home.html'), 'home');
      const guard = makeGuard({ port: 0 });
      const port = await start(createStaticApp(tmp, guard));
      expect(await (await get(port, '/')).text()).toBe('home');
      expect((await (await get(port, '/api/info')).json()).service).toBe('canvas-serve');
      expect((await (await get(port, '/api/boards')).json()).map((e: { name: string }) => e.name)).toEqual(['demo']);
      expect(await (await get(port, '/api/boards/demo/status')).json()).toMatchObject({ name: 'demo' });
      for (const p of ['/api/nope', '/mcp']) {
        const r = await get(port, p);
        expect(r.status, p).toBe(404);
        expect(r.headers.get('content-type'), p).toBe('application/json');
      }
      expect(await badUpgrade(port, '/ws/demo')).toBe(400); // reaches the WebSocket server
      // a cross-site navigation gets the page but not the data
      const cross = { 'sec-fetch-site': 'cross-site' };
      expect((await get(port, '/', cross)).status).toBe(200);
      expect((await get(port, '/api/boards', cross)).status).toBe(403);
      expect((await get(port, '/', { host: 'evil.example' })).status).toBe(403);
      for (const p of ['/', '/api/boards']) expect([...(await get(port, p)).headers.keys()].filter((k) => k.startsWith('access-control'))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
