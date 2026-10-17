import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listen, listInstances, livePopout, livePopouts, nextRestore, pidAlive, popoutSocket, readInstance, send, socketDir, validMessage, writeInstance } from './instances';

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

describe('safety', () => {
  it('never treats pid 0 or a negative pid as a process', () => {
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(process.pid)).toBe(true);
    const main = dataDir();
    writeInstance(main, { canvas: 'Zero', pid: 0, keep: true });
    expect(listInstances(main)).toEqual([]);
  });
  it('rejects messages with a non-string command or canvas', async () => {
    expect(validMessage({ cmd: 'open', canvas: 1 })).toBe(false);
    expect(validMessage({ cmd: 5 })).toBe(false);
    expect(validMessage({ cmd: 'open', canvas: 'a' })).toBe(true);
    const main = dataDir();
    const sock = popoutSocket(main, 'Msg');
    servers.push(await listen(sock, () => ({ ok: true })));
    expect(await send(sock, { cmd: 'open', canvas: 1 as unknown as string })).toMatchObject({ ok: false });
  });
  it('makes the socket folder private to the user', async () => {
    const main = dataDir();
    mkdirSync(socketDir(main), { recursive: true, mode: 0o755 });
    servers.push(await listen(popoutSocket(main, 'Perm'), () => ({ ok: true })));
    expect(statSync(socketDir(main)).mode & 0o077).toBe(0);
  });
});

describe('restore', () => {
  it('starts a kept pop-out again, twice at most', () => {
    expect(nextRestore({ keep: true })).toEqual({ launch: true, starts: 1 });
    expect(nextRestore({ keep: true, starts: 1 })).toEqual({ launch: true, starts: 2 });
    expect(nextRestore({ keep: true, starts: 2 })).toEqual({ launch: false, starts: 2 });
    expect(nextRestore({ keep: false })).toEqual({ launch: false, starts: 0 });
  });
});
