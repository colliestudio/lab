import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { FORMAT_KEY, FormatError } from '../../src/core/format';
import { parse } from '../../src/core/io';
import { Board } from './board';
import { stableSerialize } from './canonical';
import { fakeClient } from './conn.test-util';
import { makeActor } from './host';
import { MemoryStorage } from './memory';

const claude = makeActor('Claude');
const n = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'text', x: 0, y: 0, width: 100, height: 50, ...extra });
const text = (nodes: object[], extra: Record<string, unknown> = {}) => stableSerialize({ nodes: nodes as never, edges: [], extra });
const quiet = { log: () => {} };
const tick = (ms = 400) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Board: stored text', () => {
  it('loads the text, and an edit lands in storage as canonical text with the format version', async () => {
    const st = new MemoryStorage({ a: text([n('x', { text: 'hi' })], { [FORMAT_KEY]: 1 }) });
    const b = await Board.load('a', st, quiet);
    expect(b.host.store.doc.get('x')!.text).toBe('hi');
    b.host.dispatch(claude, 'board.add', { id: 'y', text: 'new' });
    await b.flush();
    const saved = parse(st.files.get('a')!);
    expect(saved.nodes.map((x) => x.id)).toEqual(['x', 'y']);
    expect(saved.extra?.[FORMAT_KEY]).toBe(1);
    expect(st.files.get('a')).toBe(stableSerialize({ ...saved, edges: [] }));
    await b.close();
  });

  it('a file from before the field gets it with its first real write, and not before', async () => {
    const old = JSON.stringify({ nodes: [n('x', { text: 'hi' })], edges: [] }, null, '  ') + '\n'; // hand-made: not canonical
    const st = new MemoryStorage({ a: old });
    const b = await Board.load('a', st, quiet);
    await tick(2000);
    expect(st.files.get('a')).toBe(old);
    b.host.dispatch(claude, 'board.add', { id: 'y', text: 'edit' });
    await tick();
    const after = JSON.parse(st.files.get('a')!);
    expect(after[FORMAT_KEY]).toBe(1);
    expect(after.nodes.map((x: { id: string }) => x.id)).toEqual(['x', 'y']);
    await b.close();
  });

  it('looking is not writing: connecting, reading, flushing and closing leave the text and the history alone', async () => {
    const old = JSON.stringify({ nodes: [n('x', { text: 'hi' })], edges: [] }, null, '  ') + '\n';
    const st = new MemoryStorage({ a: old });
    const b = await Board.load('a', st, quiet);
    const c = fakeClient(b);
    expect(c.store.doc.get('x')!.text).toBe('hi');
    await tick(2000);
    await b.flush();
    c.disconnect();
    await b.close();
    expect(st.files.get('a')).toBe(old);
    expect(st.states.size).toBe(0);
  });

  it('the load is logged as a load, not as an edit of the file', async () => {
    const log = vi.fn();
    const b = await Board.load('a', new MemoryStorage({ a: text([n('x')]) }), { log });
    expect(log).toHaveBeenCalledWith('loaded the file: 1 added');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('edited the file'));
    expect(b.host.store.log.toArray().map((e) => e.text)).toEqual(['loaded the file: 1 added']); // what players see
    await b.close();
  });

  it('create: true makes a missing board; otherwise 404', async () => {
    const st = new MemoryStorage();
    await expect(Board.load('a', st, quiet)).rejects.toMatchObject({ status: 404 });
    const b = await Board.load('a', st, { ...quiet, create: true });
    expect(JSON.parse(st.files.get('a')!)).toEqual({ [FORMAT_KEY]: 1, nodes: [], edges: [] });
    await b.close();
  });

  it('keeps the Yjs history across a restart (same client ids, same state vector)', async () => {
    const st = new MemoryStorage({ a: text([n('x')]) });
    const b1 = await Board.load('a', st, quiet);
    b1.host.dispatch(claude, 'board.add', { id: 'y', text: 'new' });
    await b1.flush();
    const before = Y.encodeStateVector(b1.host.ydoc);
    await b1.close();
    expect(st.states.has('a')).toBe(true);
    const b2 = await Board.load('a', st, quiet);
    expect(Y.encodeStateVector(b2.host.ydoc)).toEqual(before);
    expect(b2.host.store.doc.get('y')!.text).toBe('new');
    await b2.close();
  });

  it('an edit from outside updates the doc, merging with a concurrent field edit', async () => {
    const st = new MemoryStorage({ a: text([n('x', { text: 'one' })]) });
    const b = await Board.load('a', st, quiet);
    b.host.dispatch(claude, 'board.update', { id: 'x', color: '4' }); // in the doc, not yet saved
    st.externalWrite('a', text([n('x', { text: 'two' })]));
    await tick(90);
    const x = b.host.store.doc.get('x')!;
    expect(x.text).toBe('two');
    expect(x.color).toBe('4');
    await tick();
    expect(JSON.parse(st.files.get('a')!).nodes[0]).toMatchObject({ text: 'two', color: '4' });
    await b.close();
  });
});

describe('Board: background', () => {
  it('an agent command and a browser edit both land in the file, and a restart reads them back', async () => {
    const st = new MemoryStorage({ a: text([n('x')], { [FORMAT_KEY]: 1 }) });
    const b = await Board.load('a', st, quiet);
    const c = fakeClient(b);
    expect(b.host.dispatch(claude, 'core.background', { color: 'slate' }).ok).toBe(true);
    await tick();
    expect(JSON.parse(st.files.get('a')!)['x-canvas-background']).toBe('#2b3340');
    expect(c.store.doc.extra?.['x-canvas-background']).toBe('#2b3340'); // the browser sees it
    c.store.dispatch('core.background', { color: '#e2f1e8' });
    await tick();
    expect(JSON.parse(st.files.get('a')!)['x-canvas-background']).toBe('#e2f1e8');
    c.disconnect();
    await b.close();
    const again = await Board.load('a', st, quiet);
    expect(again.host.store.doc.extra?.['x-canvas-background']).toBe('#e2f1e8');
    await again.close();
  });
});

describe('Board: writes never overwrite an edit from outside', () => {
  it('an edit that lands between the read and the write is merged, not lost', async () => {
    const st = new MemoryStorage({ a: text([n('x', { text: 'one' })], { [FORMAT_KEY]: 1 }) });
    const b = await Board.load('a', st, quiet);
    b.host.dispatch(claude, 'board.add', { id: 'y', text: 'mine' });
    const write = st.write.bind(st);
    let raced = false;
    st.write = async (name, t, expect) => {
      if (!raced) {
        raced = true;
        st.files.set(name, text([n('x', { text: 'theirs' })], { [FORMAT_KEY]: 1 })); // the editor wins the race
      }
      return write(name, t, expect);
    };
    await b.flush();
    const saved = JSON.parse(st.files.get('a')!).nodes;
    expect(saved.map((x: { id: string; text: string }) => [x.id, x.text])).toEqual([['x', 'theirs'], ['y', 'mine']]);
    await b.close();
  });
});

describe('Board: format version', () => {
  const newer = text([n('x')], { [FORMAT_KEY]: 99 });

  it('refuses a newer board at load: nothing read into state, written or watched', async () => {
    const st = new MemoryStorage({ a: newer });
    st.states.set('a', Y.encodeStateAsUpdate(new Y.Doc()));
    await expect(Board.load('a', st, quiet)).rejects.toBeInstanceOf(FormatError);
    await tick(2000);
    expect(st.files.get('a')).toBe(newer);
    expect(st.watching).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses an invalid version', async () => {
    const st = new MemoryStorage({ a: text([], { [FORMAT_KEY]: '1' }) });
    await expect(Board.load('a', st, quiet)).rejects.toThrow(/positive integer/);
  });

  it('a newer edit to a loaded board is logged, not applied, and never overwritten', async () => {
    const log = vi.fn();
    const st = new MemoryStorage({ a: text([n('x', { text: 'one' })]) });
    const b = await Board.load('a', st, { log });
    st.externalWrite('a', newer);
    await tick(200);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not applied (this board is format 99'));
    expect(b.host.store.doc.get('x')!.text).toBe('one');
    b.host.dispatch(claude, 'board.update', { id: 'x', text: 'mine' });
    await b.flush();
    await tick();
    expect(st.files.get('a')).toBe(newer);
    await b.close();
    expect(st.files.get('a')).toBe(newer);
  });
});

describe('Board: connections', () => {
  it('two clients converge, and presence reaches the other', async () => {
    const st = new MemoryStorage({ a: text([n('x', { text: 'one' })]) });
    const b = await Board.load('a', st, quiet);
    const c1 = fakeClient(b);
    const c2 = fakeClient(b);
    expect(c1.store.doc.get('x')!.text).toBe('one');
    c1.store.dispatch('board.update', { id: 'x', text: 'from 1' });
    expect(c2.store.doc.get('x')!.text).toBe('from 1');
    expect(b.host.store.doc.get('x')!.text).toBe('from 1');
    c2.awareness.setLocalState({ user: { name: 'Two' } });
    expect(c1.awareness.getStates().get(c2.awareness.clientID)).toEqual({ user: { name: 'Two' } });
    expect(b.browsers).toBe(2);
    c2.disconnect();
    expect(b.browsers).toBe(1);
    expect(c1.awareness.getStates().has(c2.awareness.clientID)).toBe(false); // its presence left with it
    await b.close();
  });

  it('a seated agent reaches the connected clients, and one that joins later', async () => {
    const b = await Board.load('a', new MemoryStorage({ a: text([]) }), quiet);
    const c1 = fakeClient(b);
    b.host.dispatch(claude, 'board.add', { id: 'x', text: 'hi' });
    const seen = (c: ReturnType<typeof fakeClient>) => [...c.awareness.getStates().values()].map((s) => (s as { user?: { name: string } }).user?.name);
    expect(seen(c1)).toContain('Claude');
    expect(seen(fakeClient(b))).toContain('Claude');
    await b.close();
  });

  describe('what a seat shows others of its selection', () => {
    const selOf = (c: ReturnType<typeof fakeClient>, name: string) => {
      const st = [...c.awareness.getStates().values()].find((x) => (x as { user?: { name: string } }).user?.name === name) as { sel?: string[] } | undefined;
      return st?.sel;
    };

    it('what an agent just made or pasted shows selected for a few seconds, then clears (the cursor stays)', async () => {
      const b = await Board.load('a', new MemoryStorage({ a: text([]) }), quiet);
      const c = fakeClient(b);
      b.host.dispatch(claude, 'board.add', { id: 'x', text: 'one' });
      b.host.dispatch(claude, 'board.add', { id: 'y', text: 'two' });
      expect(selOf(c, 'Claude')).toEqual(['y']);
      await tick(b.host.selectionMs - 100);
      expect(selOf(c, 'Claude')).toEqual(['y']); // a new action restarted the clock
      await tick(200);
      expect(selOf(c, 'Claude')).toEqual([]);
      const state = [...c.awareness.getStates().values()].find((x) => (x as { user?: { name: string } }).user?.name === 'Claude') as { cursor: unknown };
      expect(state.cursor).not.toBeNull();
      await b.close();
    });

    it('leaving the table clears the seat for everyone, and a later seat of the same name starts with nothing selected', async () => {
      const b = await Board.load('a', new MemoryStorage({ a: text([]) }), quiet);
      const c = fakeClient(b);
      b.host.dispatch(claude, 'board.add', { id: 'x', text: 'one' });
      expect(selOf(c, 'Claude')).toEqual(['x']);
      await tick(3000);
      b.host.unseat(claude);
      expect(selOf(c, 'Claude')).toBeUndefined();
      b.host.dispatch(claude, 'board.add', { id: 'y', text: 'two' });
      expect(selOf(c, 'Claude')).toEqual(['y']);
      await tick(3000); // the first seat's timer (due at 5 s) does not clear the new seat's selection
      expect(selOf(c, 'Claude')).toEqual(['y']);
      await tick(10_000);
      expect(selOf(c, 'Claude')).toEqual([]);
      await b.close();
    });
  });

  it('counts the relay as a connection but not as a browser; a malformed frame is dropped and logged', async () => {
    const log = vi.fn();
    const b = await Board.load('a', new MemoryStorage({ a: text([n('x')]) }), { log });
    const relay = fakeClient(b, { relay: true });
    expect(b.connections).toBe(1);
    expect(b.browsers).toBe(0);
    relay.raw(new Uint8Array([0, 200, 1])); // a sync frame cut short
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dropped a malformed frame from the room'));
    const c = fakeClient(b);
    c.store.dispatch('board.update', { id: 'x', text: 'still serving' });
    expect(b.host.store.doc.get('x')!.text).toBe('still serving');
    await b.close();
  });

  it('leases: connections and holds keep the board in use', async () => {
    const b = await Board.load('a', new MemoryStorage({ a: text([]) }), quiet);
    expect(b.leases).toBe(0);
    const release = b.hold();
    const c = fakeClient(b);
    expect(b.leases).toBe(2);
    release();
    release(); // twice is harmless
    c.disconnect();
    expect(b.leases).toBe(0);
    await b.close();
  });
});

describe('Board: close', () => {
  it('flushes a pending edit, closes connections, unwatches and leaves no timers', async () => {
    const st = new MemoryStorage({ a: text([n('x')]) });
    const b = await Board.load('a', st, quiet);
    const c = fakeClient(b);
    b.host.dispatch(claude, 'board.add', { id: 'y', text: 'late' });
    expect(b.pending).toBe(true);
    await b.close();
    expect(JSON.parse(st.files.get('a')!).nodes.map((x: { id: string }) => x.id)).toEqual(['x', 'y']);
    expect(c.closed).toBe(true);
    expect(st.watching).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
