import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { startTunnel } from './tunnel';

function fake() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  const calls: [string, string[]][] = [];
  return { child, calls, spawn: (c: string, a: string[]) => (calls.push([c, a]), child as any) };
}

describe('startTunnel', () => {
  it('starts cloudflared at the bridge port with the Host rewrite and resolves with the URL it logs', async () => {
    const f = fake();
    const p = startTunnel(5222, { spawn: f.spawn });
    f.child.stderr.emit('data', 'INF Requesting new quick Tunnel on trycloudflare.com...\nINF https://api.trycloudflare.com ignored\n');
    f.child.stderr.emit('data', 'INF |  https://quiet-river-42.trycloudflare.com  |\n');
    const t = await p;
    expect(t.url).toBe('https://quiet-river-42.trycloudflare.com');
    expect(f.calls[0][0]).toBe('cloudflared');
    expect(f.calls[0][1]).toEqual(expect.arrayContaining(['--url', 'http://localhost:5222', '--http-host-header', 'localhost:5222']));
    t.stop();
    expect(f.child.kill).toHaveBeenCalled();
  });
  it('a URL split across chunks still matches', async () => {
    const f = fake();
    const p = startTunnel(1, { spawn: f.spawn });
    f.child.stderr.emit('data', 'https://abc-d');
    f.child.stderr.emit('data', 'ef.trycloudflare.com\n');
    expect((await p).url).toBe('https://abc-def.trycloudflare.com');
  });
  it('says what to do when cloudflared is not installed', async () => {
    const f = fake();
    const p = startTunnel(1, { spawn: f.spawn });
    f.child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }));
    await expect(p).rejects.toThrow(/brew install cloudflared/);
  });
  it('fails (and stops the child) when it exits early or stays silent', async () => {
    const f = fake();
    const p = startTunnel(1, { spawn: f.spawn });
    f.child.stderr.emit('data', 'ERR no network\n');
    f.child.emit('exit', 1);
    await expect(p).rejects.toThrow(/no network/);
    const g = fake();
    await expect(startTunnel(1, { spawn: g.spawn, timeoutMs: 20 })).rejects.toThrow(/no tunnel URL/);
    expect(g.child.kill).toHaveBeenCalled();
  });
});
