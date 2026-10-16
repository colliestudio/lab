import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardDirectory } from '../core/directory';
import { stableSerialize } from '../core/canonical';
import { MemoryStorage } from '../core/memory';
import { createNodeServer, type NodeServer } from './http';
import { makeGuard } from './guard';

let server: NodeServer;
let dir: BoardDirectory;
afterEach(async () => {
  await server.close();
  await dir.closeAll();
});

async function start() {
  const st = new MemoryStorage({ demo: stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 1 } }) });
  dir = new BoardDirectory(st, { sweepMs: 0, log: () => {} });
  const log = () => {};
  server = createNodeServer({ directory: dir, guard: makeGuard({ port: 0 }), log });
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
