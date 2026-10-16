import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { freePort, root, until } from '../bridge/process.test-util';
import { stableSerialize } from './core/canonical';

// --host-name: a proxy (the Mini's Caddy) forwards http://mini.internal:PORT to the loopback server with
// Host: localhost:PORT, so only the browser's Origin needs the name. Everything else stays refused.

const board = stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 1 } });

interface Started {
  dir: string;
  port: number;
  proc: ChildProcess;
}
const started: Started[] = [];
async function start(extra: string[]): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-hostname-'));
  writeFileSync(join(dir, 'a.canvas'), board);
  const port = await freePort();
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server/serve.ts', dir, '--port', String(port), ...extra], { cwd: root, stdio: 'ignore' });
  const s = { dir, port, proc };
  started.push(s);
  await until(async () => !!(await fetch(`http://127.0.0.1:${port}/api/info`).catch(() => null))?.ok);
  return s;
}

/** A request with exact headers (fetch won't set Host or Origin freely). */
const req = (port: number, path: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on('error', reject);
    r.end();
  });

const ws = (port: number, origin: string) =>
  new Promise<number>((resolve) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/ws/a`, { headers: { origin } });
    w.on('unexpected-response', (_r, res) => resolve(res.statusCode ?? 0));
    w.on('open', () => {
      w.close();
      resolve(101);
    });
    w.on('error', () => {});
  });

afterAll(() => {
  for (const s of started) {
    s.proc.kill('SIGKILL');
    rmSync(s.dir, { recursive: true, force: true });
  }
});

describe('serve --host-name', () => {
  let s: Started;
  beforeAll(async () => {
    s = await start(['--host-name', 'mini.internal']);
  }, 30000);

  it('trusts the name as Origin, as Host and behind the proxy (Host: localhost, X-Forwarded-Host)', async () => {
    const o = `http://mini.internal:${s.port}`;
    expect(await req(s.port, '/api/boards', { origin: o })).toBe(200);
    expect(await req(s.port, '/api/boards', { host: `mini.internal:${s.port}` })).toBe(200);
    expect(await req(s.port, '/api/boards', { origin: o, 'x-forwarded-host': `mini.internal:${s.port}`, 'x-forwarded-for': '100.64.0.2' })).toBe(200);
    expect(await ws(s.port, o)).toBe(101);
  });

  it('rules for everything else are unchanged', async () => {
    expect(await req(s.port, '/api/boards', { origin: 'http://mini.internal:9999' })).toBe(403);
    expect(await req(s.port, '/api/boards', { origin: 'http://evil.example' })).toBe(403);
    expect(await req(s.port, '/api/boards', { host: 'evil.example' })).toBe(403);
    expect(await req(s.port, '/api/boards', { 'sec-fetch-site': 'cross-site' })).toBe(403);
    expect(await ws(s.port, 'http://evil.example')).toBe(403);
  });

  it('without the flag the name is refused as before', async () => {
    const plain = await start([]);
    expect(await req(plain.port, '/api/boards', { origin: `http://mini.internal:${plain.port}` })).toBe(403);
    expect(await req(plain.port, '/api/boards', {})).toBe(200);
  }, 30000);
});
