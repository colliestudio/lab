import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { Presence } from './presence';

function pair() {
  const a = new Awareness(new Y.Doc());
  const b = new Awareness(new Y.Doc());
  // wire the two awareness instances together like a provider would
  a.on('update', ({ added, updated, removed }: any) => applyAwarenessUpdate(b, encodeAwarenessUpdate(a, [...added, ...updated, ...removed]), 'net'));
  b.on('update', ({ added, updated, removed }: any) => applyAwarenessUpdate(a, encodeAwarenessUpdate(b, [...added, ...updated, ...removed]), 'net'));
  const pa = new Presence(a, { id: 'pa', name: 'Alice', color: '#f00' });
  const pb = new Presence(b, { id: 'pb', name: 'Bob', color: '#00f' });
  return { pa, pb };
}

describe('presence', () => {
  it('sees the other player, their selection and what they hold', () => {
    const { pa, pb } = pair();
    expect(pb.peers().map((p) => p.name)).toEqual(['Alice']);
    pa.setSelection(['n1']);
    pa.setHeld(['n2']);
    pa.setCursor({ x: 10.4, y: 20.6 });
    const alice = pb.peers()[0];
    expect(alice.sel).toEqual(['n1']);
    expect(alice.cursor).toEqual({ x: 10, y: 21 });
    expect(pb.heldBy('n2')?.name).toBe('Alice');
    expect(pb.heldBy('n1')).toBeUndefined();
    expect(pa.heldBy('n2')).toBeUndefined(); // my own hold doesn't block me
    pa.setHeld([]);
    expect(pb.heldBy('n2')).toBeUndefined();
  });
  it('throttles cursor updates but always delivers the last position', async () => {
    const { pa, pb } = pair();
    for (let i = 0; i < 20; i++) pa.setCursor({ x: i, y: 0 });
    expect(pb.peers()[0].cursor!.x).toBeLessThan(19);
    await new Promise((r) => setTimeout(r, 80));
    expect(pb.peers()[0].cursor).toEqual({ x: 19, y: 0 });
  });
});
