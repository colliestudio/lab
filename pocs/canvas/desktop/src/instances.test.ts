import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listen, listInstances, livePopout, livePopouts, popoutSocket, readInstance, send, writeInstance } from './instances';

const servers: { close(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));
const dataDir = () => mkdtempSync(join(tmpdir(), 'collie-inst-'));

describe('instance sockets', () => {
  it('answers a message, and null when nothing listens', async () => {
    const main = dataDir();
    const sock = popoutSocket(main, 'Roadmap');
    expect(await send(sock, { cmd: 'ping' })).toBeNull();
    servers.push(await listen(sock, (m) => ({ ok: true, echo: m.cmd })));
    expect(await send(sock, { cmd: 'hi' })).toEqual({ ok: true, echo: 'hi' });
  });
  it('replaces the socket file a dead process left, refuses a live one', async () => {
    const main = dataDir();
    const sock = popoutSocket(main, 'Retro');
    const a = await listen(sock, () => ({ ok: true }));
    await expect(listen(sock, () => ({ ok: true }))).rejects.toThrow(/another process/);
    a.close(); // the file stays behind until the next listen replaces it
    servers.push(await listen(sock, () => ({ ok: true, n: 2 })));
    expect(await send(sock, { cmd: 'x' })).toEqual({ ok: true, n: 2 });
  });
});

describe('registry', () => {
  it('round trips, ignores junk', () => {
    const main = dataDir();
    writeInstance(main, { canvas: 'A b', pid: process.pid, keep: true, title: 'A b' });
    writeInstance(main, { canvas: 'C', pid: 1, keep: false });
    expect(readInstance(main, 'A b')?.title).toBe('A b');
    expect(listInstances(main).map((i) => i.canvas).sort()).toEqual(['A b', 'C']);
    expect(readInstance(main, 'nope')).toBeNull();
  });
  it('a pop-out is live only while its socket answers (stale files are ignored)', async () => {
    const main = dataDir();
    writeInstance(main, { canvas: 'Live', pid: process.pid, keep: true });
    writeInstance(main, { canvas: 'Stale', pid: process.pid, keep: true });
    servers.push(await listen(popoutSocket(main, 'Live'), () => ({ ok: true })));
    expect(await livePopout(main, 'Live')).not.toBeNull();
    expect(await livePopout(main, 'Stale')).toBeNull();
    expect((await livePopouts(main)).map((i) => i.canvas)).toEqual(['Live']);
  });
});
