import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { root } from '../../bridge/process.test-util';
import { acquireFolderLock, FolderLockedError, LOCK_FILE, hereInfo, lockState, type Here } from './lock';

const here: Here = { machine: 'M1', host: 'mini', bootAt: 1_000_000_000_000 };
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'canvas-lock-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A pid that existed and is gone. */
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
const write = (dir: string, h: object) => writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ v: 1, app: 'canvas serve', host: 'mini', startedAt: 'then', port: 1, urls: ['http://mini.internal:1'], token: 't', ...h }));
const other = (extra: object = {}) => ({ pid: process.ppid, machine: 'M1', bootAt: here.bootAt, ...extra }); // the parent: alive, not us

describe('folder lock', () => {
  it('acquire writes the holder; a second acquire is refused with who holds it', () => {
    const d = tmp();
    const a = acquireFolderLock(d, { port: 5310, urls: ['http://127.0.0.1:5310'], here });
    expect(JSON.parse(readFileSync(a.path, 'utf8'))).toMatchObject({ v: 1, app: 'canvas serve', pid: process.pid, machine: 'M1', host: 'mini', bootAt: here.bootAt, port: 5310, urls: ['http://127.0.0.1:5310'] });
    expect(JSON.parse(readFileSync(a.path, 'utf8')).token).toBe(a.holder.token);
    // the same process counts as stale to itself, so make the holder another live pid
    write(d, other({ port: 5310 }));
    let err: unknown;
    try {
      acquireFolderLock(d, { port: 1, urls: [], here });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FolderLockedError);
    expect((err as Error).message).toContain(`pid ${process.ppid}`);
    expect((err as Error).message).toContain('mini');
    expect((err as Error).message).toContain('http://mini.internal:1');
    expect((err as Error).message).toContain(join(d, LOCK_FILE));
  });

  it('release removes the file; only while it is still ours; twice is fine', () => {
    const d = tmp();
    const a = acquireFolderLock(d, { port: 1, urls: [], here });
    a.release();
    expect(existsSync(a.path)).toBe(false);
    a.release();
    const b = acquireFolderLock(d, { port: 1, urls: [], here });
    write(d, other({ token: 'someone else' }));
    b.release();
    expect(existsSync(b.path)).toBe(true);
  });

  it('a lock is stale when its pid is gone, it is our own pid, or it is from before the boot', () => {
    const d = tmp();
    write(d, other({ pid: deadPid() }));
    expect(lockState(d, here)).toMatchObject({ held: false });
    const a = acquireFolderLock(d, { port: 2, urls: [], here });
    expect(a.holder.pid).toBe(process.pid);
    expect(JSON.parse(readFileSync(a.path, 'utf8')).port).toBe(2);

    write(d, other({ bootAt: here.bootAt - 3_600_000 }));
    expect(lockState(d, here)).toMatchObject({ held: false });
    write(d, other({ bootAt: here.bootAt + 30_000 }));
    expect(lockState(d, here)).toMatchObject({ held: true });
    write(d, { pid: process.pid, machine: 'M1', bootAt: here.bootAt });
    expect(lockState(d, here)).toMatchObject({ held: false });
  });

  it('a foreign machine holds it, whatever its pid looks like', () => {
    const d = tmp();
    write(d, { pid: deadPid(), machine: 'M2', host: 'macbook', bootAt: 5 });
    expect(lockState(d, here)).toMatchObject({ held: true });
    expect(() => acquireFolderLock(d, { port: 1, urls: [], here })).toThrow(/macbook/);
  });

  it('a Mac whose ioreg failed (machine = hostname) still recognises its own lock by hostname', () => {
    const d = tmp();
    const noIoreg: Here = { machine: 'mini', host: 'mini', bootAt: here.bootAt };
    write(d, { pid: process.ppid, machine: 'UUID-1', host: 'mini', bootAt: here.bootAt });
    expect(lockState(d, noIoreg)).toMatchObject({ held: true, reason: expect.stringContaining('running') });
    write(d, { pid: deadPid(), machine: 'UUID-1', host: 'mini', bootAt: here.bootAt });
    expect(lockState(d, noIoreg)).toMatchObject({ held: false });
    // the reverse: the lock was written while ioreg failed, we have the UUID now
    write(d, { pid: process.ppid, machine: 'mini', host: 'mini', bootAt: here.bootAt });
    expect(lockState(d, here)).toMatchObject({ held: true, reason: expect.stringContaining('running') });
    write(d, { pid: deadPid(), machine: 'macbook', host: 'macbook', bootAt: here.bootAt });
    expect(lockState(d, here)).toMatchObject({ held: true, reason: expect.stringContaining('held from') });
    write(d, { pid: deadPid(), machine: 'UUID-2', host: 'macbook', bootAt: here.bootAt });
    expect(lockState(d, noIoreg)).toMatchObject({ held: true }); // another Mac
  });

  it('simultaneous starters on a stale lock: exactly one wins', async () => {
    const d = tmp();
    const real = hereInfo(); // the contenders are real processes: the lock must be this machine's
    write(d, { pid: deadPid(), machine: real.machine, host: real.host, bootAt: real.bootAt });
    const code = `import { acquireFolderLock } from './server/node/lock.ts';
      try { acquireFolderLock(process.argv[1], { port: 1, urls: [] }); console.log('won'); setTimeout(() => {}, 2500); }
      catch (e) { console.log('lost'); }`;
    const run = () =>
      new Promise<string>((resolve) => {
        const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, d], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', (c) => (out += c));
        p.on('close', () => resolve(out.trim()));
      });
    const results = await Promise.all(Array.from({ length: 6 }, run));
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    expect(results.filter((r) => r === 'lost')).toHaveLength(5);
  }, 30000);

  it('garbage or an empty file is free', () => {
    const d = tmp();
    for (const text of ['', 'not json', '{"v":2}', '[]']) {
      writeFileSync(join(d, LOCK_FILE), text);
      expect(lockState(d, here).held).toBe(false);
      const a = acquireFolderLock(d, { port: 1, urls: [], here });
      expect(JSON.parse(readFileSync(a.path, 'utf8')).pid).toBe(process.pid);
      a.release();
    }
  });
});
