import { afterEach, describe, expect, it } from 'vitest';
import { FolderBlockedError } from '../core/errors';
import { IoGuard } from './ioGuard';

const forever = () => new Promise<never>(() => {});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('IoGuard', () => {
  let logs: string[] = [];
  afterEach(() => (logs = []));
  const make = (o: { probe?: () => Promise<unknown>; probeEveryMs?: number; maxProbes?: number } = {}) =>
    new IoGuard({ dir: '/data/Collie Canvas', timeoutMs: 30, probe: o.probe ?? (() => Promise.resolve()), log: (m) => logs.push(m), probeEveryMs: o.probeEveryMs ?? 10_000, maxProbes: o.maxProbes });

  it('passes results and errors through', async () => {
    const g = make();
    expect(await g.run(async () => 7)).toBe(7);
    await expect(g.run(async () => Promise.reject(new Error('ENOENT')))).rejects.toThrow('ENOENT');
    expect(g.blocked).toBe(false);
  });

  it('a call that does not return in time fails with the Full Disk Access message, and says so in the log', async () => {
    const g = make();
    const e = await g.run(forever).catch((x) => x);
    expect(e).toBeInstanceOf(FolderBlockedError);
    expect(e.message).toContain('/data/Collie Canvas');
    expect(e.message).toContain(`grant ${process.execPath} Full Disk Access`);
    expect(logs).toEqual([e.message]);
    expect(g.blocked).toBe(true);
  });

  it('while blocked, calls fail at once and never reach the folder', async () => {
    const g = make();
    await g.run(forever).catch(() => {});
    let touched = 0;
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await expect(g.run(async () => void touched++)).rejects.toBeInstanceOf(FolderBlockedError);
    expect(touched).toBe(0);
    expect(Date.now() - t0).toBeLessThan(25);
  });

  it('a stuck call that comes back late unblocks it', async () => {
    const g = make();
    let release!: () => void;
    await g.run(() => new Promise<void>((r) => (release = r))).catch(() => {});
    expect(g.blocked).toBe(true);
    release();
    await wait(5);
    expect(g.blocked).toBe(false);
    expect(logs.at(-1)).toContain('answers again');
    expect(await g.run(async () => 1)).toBe(1);
  });

  it('a probe that comes back unblocks it; at most maxProbes are stuck at once, one per interval', async () => {
    let probes = 0;
    let answer = false;
    const g = make({ probeEveryMs: 20, maxProbes: 2, probe: () => (probes++, answer ? Promise.resolve() : forever()) });
    await g.run(forever).catch(() => {});
    await g.run(async () => 1).catch(() => {}); // too soon for a probe
    expect(probes).toBe(0);
    for (let i = 0; i < 6; i++) {
      await wait(25);
      await g.run(async () => 1).catch(() => {});
    }
    expect(probes).toBe(2); // two stuck, no third
    expect(g.blocked).toBe(true);
    const g2 = make({ probeEveryMs: 20, probe: () => (answer = true, Promise.resolve()) });
    await g2.run(forever).catch(() => {});
    await wait(25);
    await g2.run(async () => 1).catch(() => {}); // starts the probe
    await wait(5);
    expect(g2.blocked).toBe(false);
  });
});
