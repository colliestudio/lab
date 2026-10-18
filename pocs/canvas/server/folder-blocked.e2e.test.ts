import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, root, until } from '../bridge/process.test-util';

// `canvas serve` on a folder that does not answer (readdir never returns, like iCloud Drive without Full
// Disk Access): the process says so in its log, keeps answering /api/info, and fails board calls at once.

let dir: string;
let proc: ChildProcess;
let url: string;
let out = '';
let unhang: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-blocked-e2e-'));
  unhang = join(dir, '..', `unhang-${process.pid}`);
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['--import', join(root, 'server/hang-readdir.test-util.mjs'), '--import', 'tsx', 'server/serve.ts', dir, '--port', String(port)], {
    cwd: root,
    env: { ...process.env, CANVAS_FOLDER_TIMEOUT_MS: '400', CANVAS_TEST_UNHANG: unhang },
  });
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  await until(async () => !!(await fetch(url + '/api/info').catch(() => null))?.ok);
}, 60_000);
afterAll(() => {
  proc?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
  rmSync(unhang, { force: true });
});

describe('serve on a folder macOS blocks', () => {
  it('logs what to grant at start, answers /api/info, and refuses board calls fast with the same message', async () => {
    await until(() => out.includes('NOT readable'));
    expect(out).toContain(`grant ${process.execPath} Full Disk Access`);
    const t0 = Date.now();
    const r = await fetch(url + '/api/boards');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ kind: 'folder-blocked', error: expect.stringContaining('Full Disk Access') });
    expect((await fetch(url + '/api/info')).status).toBe(200);
  }, 30_000);

  it('recovers by itself once the folder answers (a probe gets through)', async () => {
    writeFileSync(unhang, '');
    writeFileSync(join(dir, 'a.canvas'), '{"nodes":[],"edges":[]}');
    // the guard probes every 15 s while blocked
    await until(async () => (await fetch(url + '/api/boards')).status === 200, 25_000);
    expect(out).toContain('answers again');
    const list = (await (await fetch(url + '/api/boards')).json()) as { name: string }[];
    expect(list.map((b) => b.name)).toEqual(['a']);
  }, 40_000);
});
