import { describe, expect, it } from 'vitest';
import { handle, relay, relayRecipients, relayRole } from './hub';

describe('signaling hub', () => {
  it('subscribe/unsubscribe update the topic list, deduped, bad topics dropped', () => {
    let t: string[] = [];
    let o = handle(JSON.stringify({ type: 'subscribe', topics: ['a', 'b', 'a', 7, ''] }), t);
    expect(o).toEqual({ kind: 'topics', topics: ['a', 'b'] });
    t = (o as any).topics;
    o = handle(JSON.stringify({ type: 'unsubscribe', topics: ['a'] }), t);
    expect(o).toEqual({ kind: 'topics', topics: ['b'] });
  });
  it('ping -> pong; junk ignored', () => {
    expect(handle('{"type":"ping"}', [])).toEqual({ kind: 'reply', message: { type: 'pong' } });
    expect(handle('nope', []).kind).toBe('ignore');
    expect(handle('{"type":"publish"}', []).kind).toBe('ignore');
  });
  it('publish relays to every subscriber of the topic with a clients count', () => {
    const conns = [{ id: 1, t: ['room'] }, { id: 2, t: ['room', 'x'] }, { id: 3, t: ['x'] }];
    const sent: [number, any][] = [];
    const o = handle(JSON.stringify({ type: 'publish', topic: 'room', data: { hi: 1 } }), ['room']);
    expect(o.kind).toBe('publish');
    if (o.kind !== 'publish') return;
    relay(conns, (c) => c.t, o.topic, o.message, (c, s) => sent.push([c.id, JSON.parse(s)]));
    expect(sent.map(([id]) => id)).toEqual([1, 2]);
    expect(sent[0][1]).toEqual({ type: 'publish', topic: 'room', data: { hi: 1 }, clients: 2 });
  });
});

describe('sandbox host routing (Worker)', async () => {
  const { sandboxResponse } = await import('./sandbox');
  const env = { SANDBOX_HOST: 'canvas-frames.example', APP_ORIGINS: 'https://canvas.lab.collie.studio' };
  it('serves frames only on <label>.<SANDBOX_HOST>, with the app as the only ancestor', async () => {
    expect(sandboxResponse(new URL('https://canvas.lab.collie.studio/worker'), env)).toBeUndefined();
    expect(sandboxResponse(new URL('https://p-dice-1.canvas-frames.example/worker'), {})).toBeUndefined();
    const r = sandboxResponse(new URL('https://p-dice-1.canvas-frames.example/worker'), env)!;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain('frame-ancestors https://canvas.lab.collie.studio;');
    expect(await r.text()).toContain("navigation.addEventListener('navigate'");
    expect(sandboxResponse(new URL('https://a.b.canvas-frames.example/page'), env)!.status).toBe(400);
    expect(sandboxResponse(new URL('https://x.canvas-frames.example/page'), { SANDBOX_HOST: env.SANDBOX_HOST })!.status).toBe(500);
  });
});

describe('relay', () => {
  it('reads the role from ?relay=', () => {
    expect(relayRole(new URL('https://x/r/a?relay=bridge'))).toBe('bridge');
    expect(relayRole(new URL('https://x/r/a?relay=peer'))).toBe('peer');
    expect(relayRole(new URL('https://x/r/a?relay=other'))).toBeNull();
    expect(relayRole(new URL('https://x/r/a'))).toBeNull();
  });
  it('a bridge reaches everyone else; a browser only the bridges (browsers sync over WebRTC)', () => {
    const all = [
      { conn: 'b1', role: 'bridge' as const },
      { conn: 'p1', role: 'peer' as const },
      { conn: 'p2', role: 'peer' as const },
      { conn: 'b2', role: 'bridge' as const },
    ];
    expect(relayRecipients(all[0], all)).toEqual(['p1', 'p2', 'b2']);
    expect(relayRecipients(all[1], all)).toEqual(['b1', 'b2']);
  });
});
