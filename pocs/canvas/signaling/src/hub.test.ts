import { describe, expect, it } from 'vitest';
import { handle, relay } from './hub';

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
