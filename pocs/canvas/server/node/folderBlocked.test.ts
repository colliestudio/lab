import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderBlockedError } from '../core/errors';
import { errorReply } from '../core/api';

// A folder macOS will not let this process read: readdir never returns.
const hang = vi.hoisted(() => ({ on: true }));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return { ...real, readdir: ((...a: Parameters<typeof real.readdir>) => (hang.on ? new Promise(() => {}) : real.readdir(...a))) as typeof real.readdir };
});
const { FolderStorage } = await import('./folder');

let dir: string;
beforeEach(() => {
  hang.on = true;
  dir = mkdtempSync(join(tmpdir(), 'canvas-blocked-'));
  writeFileSync(join(dir, 'a.canvas'), '{"nodes":[],"edges":[]}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('FolderStorage with a folder that does not answer', () => {
  it('list fails with the grant message instead of hanging; check() says the same', async () => {
    const logs: string[] = [];
    const st = new FolderStorage(dir, { timeoutMs: 40, log: (m) => logs.push(m) });
    const t0 = Date.now();
    const e = await st.list().catch((x) => x);
    expect(e).toBeInstanceOf(FolderBlockedError);
    expect(e.message).toContain('Full Disk Access');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await st.check()).toBe(e.message);
    expect(logs).toHaveLength(1);
  });

  it('the HTTP reply is a 503 folder-blocked', async () => {
    const st = new FolderStorage(dir, { timeoutMs: 40 });
    const e = await st.list().catch((x) => x);
    expect(errorReply(e)).toMatchObject({ status: 503, json: { kind: 'folder-blocked', error: expect.stringContaining('Full Disk Access') } });
  });

  it('a folder that answers is not blocked: check() is undefined, reads work', async () => {
    hang.on = false;
    const st = new FolderStorage(dir, { timeoutMs: 40 });
    expect(await st.check()).toBeUndefined();
    expect((await st.list()).map((i) => i.name)).toEqual(['a']);
    expect(await st.read('a')).toContain('nodes');
  });

  it('every folder call is under the deadline: once blocked, read and write fail at once too', async () => {
    const st = new FolderStorage(dir, { timeoutMs: 40 });
    await st.list().catch(() => {});
    await expect(st.read('a')).rejects.toBeInstanceOf(FolderBlockedError);
    await expect(st.write('a', 'x')).rejects.toBeInstanceOf(FolderBlockedError);
    await expect(st.create('b', 'x')).rejects.toBeInstanceOf(FolderBlockedError);
    await expect(st.readState('a')).rejects.toBeInstanceOf(FolderBlockedError);
  });
});
