import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A real bridge process on a free port with a scratch board file, for the tests that go over HTTP.

export const root = join(__dirname, '..');

export const freePort = () =>
  new Promise<number>((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });

export async function until(cond: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface TestBridge {
  port: number;
  url: string;
  file: string;
  dir: string;
  post(path: string, body: unknown): Promise<any>;
  get(path: string): Promise<any>;
  stop(): void;
}

export async function startBridge(): Promise<TestBridge> {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-test-'));
  const file = join(dir, 'board.canvas');
  const port = await freePort();
  const proc: ChildProcess = spawn(join(root, 'node_modules/.bin/tsx'), ['bridge/server.ts', file, '--port', String(port)], { cwd: root, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const get = (path: string) => fetch(url + path).then((r) => r.json());
  const post = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const stop = () => {
    proc.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await until(async () => !!(await fetch(url + '/status').catch(() => null))?.ok);
  } catch (e) {
    stop();
    throw e;
  }
  return { port, url, file, dir, post, get, stop };
}
