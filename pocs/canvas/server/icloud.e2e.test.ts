import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { freePort, root, until } from '../bridge/process.test-util';
import { stableSerialize } from './core/canonical';

// An iCloud-evicted board (a `.Foo.canvas.icloud` stub) over the real server: listed with a reason, 503 when
// opened, 409 when something is created or renamed onto its name, never written.

let dir: string;
let proc: ChildProcess;
let url: string;
let port: number;
const json = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-icloud-'));
  writeFileSync(join(dir, '.Foo.canvas.icloud'), 'stub');
  writeFileSync(join(dir, 'Bar.canvas'), stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 1 } }));
  port = await freePort();
  url = `http://127.0.0.1:${port}`;
  // PATH without brctl's folder: the download request is a no-op here
  proc = spawn(process.execPath, ['--import', 'tsx', 'server/serve.ts', dir, '--port', String(port)], { cwd: root, stdio: 'ignore', env: { ...process.env, PATH: '/nonexistent' } });
  await until(async () => !!(await fetch(url + '/api/info').catch(() => null))?.ok);
}, 30000);
afterAll(() => {
  proc?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('serve with an evicted board', () => {
  it('lists it as evicted, with the reason', async () => {
    const r = await json('GET', '/api/boards');
    expect(r.json).toEqual([expect.objectContaining({ name: 'Bar' }), expect.objectContaining({ name: 'Foo', evicted: true, error: expect.stringContaining('not downloaded') })]);
  });

  it('opening it is a 503 (HTTP and WebSocket) and writes nothing', async () => {
    const r = await json('GET', '/api/boards/Foo/status');
    expect(r).toMatchObject({ status: 503, json: { kind: 'not-downloaded' } });
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/Foo`);
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => {});
    });
    expect(code).toBe(503);
    expect(existsSync(join(dir, 'Foo.canvas'))).toBe(false);
  });

  it('create and rename onto its name are 409', async () => {
    expect((await json('POST', '/api/boards', { name: 'foo' })).status).toBe(409);
    expect((await json('POST', '/api/boards/Bar/rename', { to: 'Foo' })).status).toBe(409);
    expect(existsSync(join(dir, 'Foo.canvas'))).toBe(false);
    expect(existsSync(join(dir, 'Bar.canvas'))).toBe(true);
  });
});
