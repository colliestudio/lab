import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { VoiceSignaling, type SigMsg } from './signal';
import { SpeakingDetector, proximityGain } from './speaking';

function node(awareness: Awareness) {
  const log: string[] = [];
  const got: { from: number; msg: SigMsg }[] = [];
  const sig = new VoiceSignaling(awareness, {
    peer: (id, init) => log.push(`peer ${id} ${init ? 'init' : 'wait'}`),
    gone: (id) => log.push(`gone ${id}`),
    signal: (from, msg) => got.push({ from, msg }),
  });
  return { sig, log, got, awareness };
}

function pair() {
  const a = new Awareness(new Y.Doc());
  const b = new Awareness(new Y.Doc());
  const link = (x: Awareness, y: Awareness) =>
    x.on('update', ({ added, updated, removed }: any) => applyAwarenessUpdate(y, encodeAwarenessUpdate(x, [...added, ...updated, ...removed]), 'net'));
  link(a, b);
  link(b, a);
  a.setLocalState({ user: 'a' });
  b.setLocalState({ user: 'b' });
  return { A: node(a), B: node(b) };
}

describe('voice signaling', () => {
  it('exactly one side initiates, and only once both are in voice', () => {
    const { A, B } = pair();
    A.sig.join();
    expect(B.log).toEqual([]);
    B.sig.join();
    const hi = A.awareness.clientID > B.awareness.clientID ? A : B;
    const lo = hi === A ? B : A;
    expect(hi.log).toEqual([`peer ${lo.awareness.clientID} init`]);
    expect(lo.log).toEqual([`peer ${hi.awareness.clientID} wait`]);
  });

  it('delivers messages in order, once, and drops them after the ack', () => {
    const { A, B } = pair();
    A.sig.join();
    B.sig.join();
    const b = B.awareness.clientID;
    A.sig.send(b, 'offer', 'c1', 'sdp');
    A.sig.send(b, 'ice', 'c1', 'cand1');
    A.sig.send(b, 'ice', 'c1', 'cand2');
    expect(B.got.map((g) => [g.msg.kind, g.msg.data])).toEqual([['offer', 'sdp'], ['ice', 'cand1'], ['ice', 'cand2']]);
    // acked: the outbox is empty again
    expect((A.awareness.getLocalState() as any).voice.out).toEqual([]);
    A.sig.send(b, 'ice', 'c1', 'cand3');
    expect(B.got).toHaveLength(4);
  });

  it('ignores messages addressed to someone else', () => {
    const { A, B } = pair();
    A.sig.join();
    B.sig.join();
    A.sig.send(999, 'offer', 'c', 'x');
    expect(B.got).toEqual([]);
  });

  it('reports mute, leave, and a rejoin as a new peer', () => {
    const { A, B } = pair();
    A.sig.join();
    B.sig.join();
    A.sig.setMuted(true);
    expect(B.sig.peers()).toEqual([{ id: A.awareness.clientID, muted: true }]);
    const a = A.awareness.clientID;
    A.sig.leave();
    expect(B.log.at(-1)).toBe(`gone ${a}`);
    expect(B.sig.peers()).toEqual([]);
    A.sig.join();
    expect(B.log.filter((l) => l.startsWith('peer')).length).toBe(2);
    // sequence numbers restart with the new epoch: the first message is delivered
    A.sig.send(B.awareness.clientID, 'offer', 'c2', 'again');
    expect(B.got.at(-1)!.msg.data).toBe('again');
  });

  it('a peer whose awareness times out is gone', () => {
    const { A, B } = pair();
    A.sig.join();
    B.sig.join();
    const a = A.awareness.clientID;
    B.awareness.states.delete(a);
    B.awareness.emit('change', [{ added: [], updated: [], removed: [a] }, 'timeout']);
    expect(B.log.at(-1)).toBe(`gone ${a}`);
  });
  it('survives malformed voice states and ignores voice peers without a player identity', () => {
    const { A, B } = pair();
    A.sig.join();
    B.sig.join();
    const b = B.awareness.clientID;
    // a broken or hostile client writes junk into its voice field (another client id, as any peer can)
    const junk = (id: number, state: unknown) => {
      B.awareness.states.set(id, state as any);
      B.awareness.emit('change', [{ added: [id], updated: [], removed: [] }, 'net']);
    };
    expect(() => junk(7001, { user: { id: 'x', name: 'x', color: '#000' }, voice: { on: true } })).not.toThrow();
    expect(() => junk(7002, { user: { id: 'y', name: 'y', color: '#000' }, voice: { on: true, epoch: 'e', out: 'no', ack: null } })).not.toThrow();
    expect(() => junk(7003, { user: { id: 'z', name: 'z', color: '#000' }, voice: { on: true, epoch: 'e', out: [null, { to: b, seq: 'x' }], ack: {} } })).not.toThrow();
    // voice without a player identity would be an invisible listener (no chip): not a voice peer
    junk(7004, { voice: { on: true, muted: false, epoch: 'e', out: [], ack: {} } });
    expect(B.sig.peers().map((p) => p.id)).not.toContain(7004);
    expect(B.log.some((l) => l.startsWith('peer 7004'))).toBe(false);
    // the real peer still works
    A.sig.send(b, 'offer', 'c1', 'sdp');
    expect(B.got.at(-1)!.msg.data).toBe('sdp');
  });
});

describe('speaking detector', () => {
  it('holds through short gaps and releases after', () => {
    const d = new SpeakingDetector(0.02, 0.012, 300);
    expect(d.update(0.001, 0)).toBe(false);
    expect(d.update(0.05, 10)).toBe(true);
    expect(d.update(0.015, 20)).toBe(true); // between on and off: stays
    expect(d.update(0, 200)).toBe(true); // gap inside the hold
    expect(d.update(0, 400)).toBe(false);
    expect(d.update(0.015, 410)).toBe(false); // needs the higher threshold to start
  });
});

describe('proximity gain', () => {
  it('is 1 near, fades, and keeps a floor', () => {
    expect(proximityGain(0)).toBe(1);
    expect(proximityGain(600)).toBe(1);
    expect(proximityGain(1800)).toBeCloseTo(0.575);
    expect(proximityGain(99999)).toBe(0.15);
  });
});
