import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { freePort, root, until } from '../bridge/process.test-util';
import { stableSerialize } from './core/canonical';
import { LOCK_FILE } from './node/lock';

// The folder lock across real processes: a second serve and a bridge refuse a served folder, SIGTERM
// releases it, SIGKILL leaves a stale one the next start takes over.

const board = stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 1 } });
const procs: ChildProcess[] = [];
const dirs: string[] = [];

interface Run {
  proc: ChildProcess;
  port: number;
  stderr: () => string;
  exited: Promise<number | null>;
}
function run(script: string, args: string[], port: number): Run {
  const proc = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(proc);
  let err = '';
  proc.stderr!.on('data', (d) => (err += d));
  return { proc, port, stderr: () => err, exited: new Promise((r) => proc.once('exit', r)) };
}
const serve = async (dir: string) => {
  const port = await freePort();
  return run('server/serve.ts', [dir, '--port', String(port)], port);
};
const up = (r: Run) => until(async () => !!(await fetch(`http://127.0.0.1:${r.port}/api/info`).catch(() => null))?.ok);
const folder = () => {
  const d = mkdtempSync(join(tmpdir(), 'canvas-lockproc-'));
  dirs.push(d);
  writeFileSync(join(d, 'a.canvas'), board);
  return d;
};
const holder = (d: string) => JSON.parse(readFileSync(join(d, LOCK_FILE), 'utf8'));

afterAll(() => {
  for (const p of procs) p.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('folder lock, in processes', () => {
  it('a second serve on the same folder exits 1 naming the first; the first keeps answering; the lock file is not a board', async () => {
    const d = folder();
    const a = await serve(d);
    await up(a);
    const b = await serve(d);
    expect(await b.exited).toBe(1);
    expect(b.stderr()).toContain(`pid ${a.proc.pid}`);
    expect(b.stderr()).toContain(`:${a.port}`);
    expect((await fetch(`http://127.0.0.1:${a.port}/api/info`)).ok).toBe(true);
    const boards = (await (await fetch(`http://127.0.0.1:${a.port}/api/boards`)).json()) as { name: string }[];
    expect(boards.map((e) => e.name)).toEqual(['a']);
    expect(holder(d)).toMatchObject({ pid: a.proc.pid, port: a.port });
  }, 30000);

  it('SIGTERM releases the lock, so the next serve starts', async () => {
    const d = folder();
    const a = await serve(d);
    await up(a);
    a.proc.kill('SIGTERM');
    expect(await a.exited).toBe(0);
    expect(existsSync(join(d, LOCK_FILE))).toBe(false);
    const b = await serve(d);
    await up(b);
    expect(holder(d).pid).toBe(b.proc.pid);
  }, 30000);

  it('after SIGKILL the lock remains but is stale: the next serve takes it over', async () => {
    const d = folder();
    const a = await serve(d);
    await up(a);
    a.proc.kill('SIGKILL');
    await a.exited;
    expect(existsSync(join(d, LOCK_FILE))).toBe(true);
    const b = await serve(d);
    await up(b);
    expect(holder(d).pid).toBe(b.proc.pid);
  }, 30000);

  it('the lock lists host-name URLs before loopback', async () => {
    const d = folder();
    const port = await freePort();
    const a = run('server/serve.ts', [d, '--port', String(port), '--host-name', 'mini.internal'], port);
    await up(a);
    expect(holder(d).urls).toEqual([`http://mini.internal:${port}`, `http://127.0.0.1:${port}`]);
  }, 30000);

  it('a serve that cannot listen exits 1 and leaves no lock', async () => {
    const d = folder();
    const busy = net.createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
    const port = (busy.address() as net.AddressInfo).port;
    const r = run('server/serve.ts', [d, '--port', String(port)], port);
    expect(await r.exited).toBe(1);
    expect(r.stderr()).toContain('cannot listen');
    expect(existsSync(join(d, LOCK_FILE))).toBe(false);
    busy.close();
  }, 30000);

  it('a bridge on a file in a served folder exits 2 and creates nothing', async () => {
    const d = folder();
    const a = await serve(d);
    await up(a);
    const port = await freePort();
    const b = run('bridge/server.ts', [join(d, 'x.canvas'), '--port', String(port)], port);
    expect(await b.exited).toBe(2);
    expect(b.stderr()).toContain('served live');
    expect(b.stderr()).toContain(`:${a.port}`);
    expect(existsSync(join(d, 'x.canvas'))).toBe(false);
  }, 30000);
});
