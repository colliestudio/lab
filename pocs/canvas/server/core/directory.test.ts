import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORMAT_KEY, FormatError } from '../../src/core/format';
import { BoardDirectory, DirError, validName } from './directory';
import { BoardFileError } from './errors';
import { stableSerialize } from './canonical';
import { fakeClient } from './conn.test-util';
import { makeActor } from './host';
import { MemoryStorage } from './memory';

const claude = makeActor('Claude');
const n = (id: string) => ({ id, type: 'text', x: 0, y: 0, width: 100, height: 50, text: id });
// stamped, as boards the server has written are (an unstamped one has a write pending for a moment after load)
const text = (nodes: object[], extra: Record<string, unknown> = { [FORMAT_KEY]: 1 }) => stableSerialize({ nodes: nodes as never, edges: [], extra });
const IDLE = 1000;

let st: MemoryStorage;
let dir: BoardDirectory;
const make = (files: Record<string, string> = { a: text([n('x')]), b: text([n('y')]) }, opts = {}) => {
  st = new MemoryStorage(files);
  dir = new BoardDirectory(st, { idleMs: IDLE, sweepMs: 0, log: () => {}, ...opts });
  return dir;
};
const later = (ms = IDLE) => Date.now() + ms;
const status = (e: Promise<unknown>) => e.then(
  () => 0,
  (x: DirError) => x.status,
);

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await dir.closeAll();
  vi.useRealTimers();
});

describe('listing and lazy loading', () => {
  it('lists every board without reading any', async () => {
    make();
    const list = await dir.list();
    expect(list.map((e) => [e.name, e.loaded])).toEqual([['a', false], ['b', false]]);
    expect(st.reads.size).toBe(0);
  });

  it('opens on first use; concurrent opens read once and share the board', async () => {
    make();
    const [b1, b2] = await Promise.all([dir.open('a'), dir.open('a')]);
    expect(b1).toBe(b2);
    expect(st.reads.get('a')).toBe(1);
    expect((await dir.list()).map((e) => [e.name, e.loaded])).toEqual([['a', true], ['b', false]]);
  });

  it('opens a name in another letter case as the same board', async () => {
    make();
    const a = await dir.open('a');
    expect(await dir.open('A')).toBe(a);
  });

  it('a request spelled differently loads the board under its stored name', async () => {
    make({ case: text([n('x')]) });
    const board = await dir.open('CASE');
    expect(board.name).toBe('case');
    expect(st.watching).toBe(1);
    expect(st.reads.has('CASE')).toBe(false);
    expect(await dir.open('Case')).toBe(board);
  });

  it('a stored board opens whatever its name looks like; unknown names are still validated', async () => {
    make({ 'Q3:Q4': text([n('x')]), ' padded ': text([]) });
    expect((await dir.open('Q3:Q4')).name).toBe('Q3:Q4');
    expect((await dir.open(' padded ')).name).toBe(' padded ');
    for (const bad of ['../etc/passwd', '..', 'a/b', '.hidden']) expect(await status(dir.open(bad)), bad).toBe(400);
    expect(await status(dir.open('Q3:Q5'))).toBe(400);
    expect(await status(dir.open('fine'))).toBe(404);
    expect([...st.reads.keys()]).not.toContain('../etc/passwd');
  });

  it('a pinned name is never refused for its looks, even for a file that does not exist yet', async () => {
    make({}, { pinned: ['.odd:name'] });
    expect((await dir.open('.odd:name', { create: true })).name).toBe('.odd:name');
  });

  it('NFC and NFD spellings of a name are one board', async () => {
    const nfd = 'cafe\u0301';
    const nfc = 'caf\u00e9';
    make({ [nfd]: text([n('x')]) });
    const a = await dir.open(nfc);
    const b = await dir.open(nfd);
    expect(a).toBe(b);
    expect(a.name).toBe(nfd);
    expect(await status(dir.create(nfc))).toBe(409);
  });

  it('with fixed-board storage only the pinned board exists', async () => {
    make({ main: text([n('x')]), other: text([]) }, { pinned: ['main'] });
    (st as { mutable: boolean }).mutable = false;
    await dir.open('main');
    expect(await status(dir.open('phantom'))).toBe(404);
    expect(await status(dir.open('other'))).toBe(404);
    expect(dir.all().map((b) => b.name)).toEqual(['main']);
  });

  it('an unknown board is a 404, a bad name a 400', async () => {
    make();
    expect(await status(dir.open('nope'))).toBe(404);
    expect(await status(dir.open('a/b'))).toBe(400);
  });
});

describe('idle unload', () => {
  it('unloads after idleMs, not a ms before', async () => {
    make();
    await dir.open('a');
    const t = Date.now();
    await dir.sweep(t + IDLE - 1);
    expect(dir.loaded('a')).toBeDefined();
    await dir.sweep(t + IDLE);
    expect(dir.loaded('a')).toBeUndefined();
    expect(st.watching).toBe(0);
  });

  it('stays while a connection is attached, a request is in flight, a hold is open or a write is pending', async () => {
    make();
    const a = await dir.open('a');
    const c = fakeClient(a);
    await dir.sweep(later());
    expect(dir.loaded('a')).toBeDefined();
    c.disconnect();

    let release!: () => void;
    const inFlight = dir.use('a', () => new Promise<void>((r) => (release = r)));
    await vi.advanceTimersByTimeAsync(0);
    await dir.sweep(later());
    expect(dir.loaded('a')).toBeDefined();
    release();
    await inFlight;

    const done = a.hold();
    await dir.sweep(later());
    expect(dir.loaded('a')).toBeDefined();
    done();

    a.host.dispatch(claude, 'board.add', { id: 'z', text: 'unsaved' });
    expect(a.pending).toBe(true);
    await dir.sweep(later());
    expect(dir.loaded('a')).toBeDefined();
  });

  it('opening and idling a hand-made board leaves its file byte-identical', async () => {
    const hand = JSON.stringify({ nodes: [n('x')], edges: [] }, null, 2) + '\n';
    make({ hand });
    const b = await dir.open('hand');
    await vi.advanceTimersByTimeAsync(2000);
    await dir.sweep(later(10 * IDLE));
    expect(dir.loaded('hand')).toBeUndefined();
    expect(b.host.store.nodes.size).toBe(1);
    expect(st.files.get('hand')).toBe(hand);
    expect(st.states.size).toBe(0);
  });

  it('an edited board unloads once its write is done; reopening sees the edit', async () => {
    make();
    const a = await dir.open('a');
    a.host.dispatch(claude, 'board.add', { id: 'z', text: 'late' });
    await dir.sweep(later(10 * IDLE));
    expect(dir.loaded('a')).toBeDefined(); // the write is still pending
    await vi.advanceTimersByTimeAsync(400);
    await dir.sweep(later(10 * IDLE));
    expect(dir.loaded('a')).toBeUndefined();
    expect(JSON.parse(st.files.get('a')!).nodes.find((x: { id: string }) => x.id === 'z').text).toBe('late');
    expect((await dir.open('a')).host.store.doc.get('z')!.text).toBe('late');
  });

  it('a pinned board never unloads', async () => {
    make(undefined, { pinned: ['a'] });
    await dir.open('a');
    await dir.open('b');
    await dir.sweep(later(100 * IDLE));
    expect(dir.loaded('a')).toBeDefined();
    expect(dir.loaded('b')).toBeUndefined();
  });

  it('seats idle past seatIdleMs leave the table', async () => {
    make(undefined, { seatIdleMs: 500 });
    const a = await dir.open('a');
    a.host.dispatch(claude, 'board.add', { id: 'z' });
    expect(a.host.seated()).toHaveLength(1);
    await dir.sweep(Date.now() + 501);
    expect(a.host.seated()).toHaveLength(0);
  });
});

describe('concurrency', () => {
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };

  it('an open during an unload waits for it, then loads a fresh board', async () => {
    make();
    const old = await dir.open('a');
    const g = gate();
    const read = st.read.bind(st);
    st.read = async (name) => {
      if (name === 'a' && gateOn) await g.p; // the close's flush reads first
      return read(name);
    };
    let gateOn = true;
    const sweeping = dir.sweep(later());
    await vi.advanceTimersByTimeAsync(0);
    let opened = false;
    const op = dir.open('a').then((b) => ((opened = true), b));
    await vi.advanceTimersByTimeAsync(10);
    expect(opened).toBe(false); // waits for the close
    gateOn = false;
    g.open();
    await sweeping;
    const fresh = await op;
    expect(fresh).not.toBe(old);
    expect(dir.loaded('a')).toBe(fresh);
    expect(fresh.host.store.doc.get('x')!.text).toBe('x');
  });

  it('an acquire that races a rename gets a 404, never a closed board', async () => {
    make();
    await dir.open('a');
    const g = gate();
    const rename = st.rename.bind(st);
    st.rename = async (f, t) => {
      await g.p;
      return rename(f, t);
    };
    const renaming = dir.rename('a', 'c');
    await vi.advanceTimersByTimeAsync(0);
    const racing = dir.acquire('a').then(
      (r) => r.board.name,
      (e: DirError) => e.status,
    );
    await vi.advanceTimersByTimeAsync(10);
    g.open();
    await renaming;
    expect(await racing).toBe(404);
    expect((await dir.open('c')).name).toBe('c');
  });
});

describe('create', () => {
  it('makes a stamped empty board that shows in the list', async () => {
    make();
    expect(await dir.create(' new one'.trim())).toBe('new one');
    expect(JSON.parse(st.files.get('new one')!)).toEqual({ [FORMAT_KEY]: 1, nodes: [], edges: [] });
    expect((await dir.list()).map((e) => e.name)).toContain('new one');
  });

  it('with text writes it byte-identical; a newer, invalid or clashing one writes nothing', async () => {
    make();
    const t = text([n('z')]);
    expect(await dir.create('imp', t)).toBe('imp');
    expect(st.files.get('imp')).toBe(t);
    const newerText = text([n('z')], { [FORMAT_KEY]: 99 });
    await expect(dir.create('nw', newerText)).rejects.toBeInstanceOf(FormatError);
    await expect(dir.create('bad', '{not json')).rejects.toBeInstanceOf(BoardFileError);
    expect(st.files.has('nw')).toBe(false);
    expect(st.files.has('bad')).toBe(false);
    const before = st.files.get('a');
    expect(await status(dir.create('a', t))).toBe(409);
    expect(st.files.get('a')).toBe(before);
  });

  it('refuses a duplicate, in any letter case (409)', async () => {
    make();
    expect(await status(dir.create('a'))).toBe(409);
    expect(await status(dir.create('A'))).toBe(409);
  });

  it('refuses bad names (400)', async () => {
    make();
    for (const bad of ['', '  ', 'a/b', 'a\\b', 'a:b', '.x', 'x'.repeat(101), 'a\nb']) expect(await status(dir.create(bad)), JSON.stringify(bad)).toBe(400);
  });

  it('refuses on a storage with one fixed board (405)', async () => {
    make();
    (st as { mutable: boolean }).mutable = false;
    expect(await status(dir.create('c'))).toBe(405);
    expect(await status(dir.rename('a', 'c'))).toBe(405);
    expect(await status(dir.remove('a'))).toBe(405);
  });
});

describe('rename and delete', () => {
  it('renames an unloaded board, moving its history', async () => {
    make();
    st.states.set('a', new Uint8Array([1]));
    expect(await dir.rename('a', 'c')).toBe('c');
    expect([...st.files.keys()].sort()).toEqual(['b', 'c']);
    expect(st.states.has('c')).toBe(true);
  });

  it('renames a loaded board without leases: flushed, unloaded, moved', async () => {
    make();
    const a = await dir.open('a');
    a.host.dispatch(claude, 'board.add', { id: 'z', text: 'kept' });
    await dir.rename('a', 'c');
    expect(dir.loaded('a')).toBeUndefined();
    expect(JSON.parse(st.files.get('c')!).nodes.map((x: { id: string }) => x.id)).toEqual(['x', 'z']);
    expect(await status(dir.open('a'))).toBe(404);
  });

  it('refuses while a browser or a session has the board (409), changing nothing', async () => {
    make();
    const a = await dir.open('a');
    const c = fakeClient(a);
    await expect(dir.rename('a', 'c')).rejects.toThrow(/a is open \(1 browser\); close it first/);
    await expect(dir.remove('a')).rejects.toMatchObject({ status: 409 });
    c.disconnect();
    const done = a.hold();
    await expect(dir.rename('a', 'c')).rejects.toThrow(/1 session/);
    done();
    expect([...st.files.keys()].sort()).toEqual(['a', 'b']);
    expect(dir.loaded('a')).toBeDefined();
    await dir.rename('a', 'c'); // free now
  });

  it('refuses an existing target (409) and an unknown board (404)', async () => {
    make();
    expect(await status(dir.rename('a', 'b'))).toBe(409);
    expect(await status(dir.rename('a', 'B'))).toBe(409);
    expect(await status(dir.rename('zzz', 'q'))).toBe(404);
    expect(await status(dir.rename('a', 'bad/name'))).toBe(400);
  });

  it('deletes: gone from the list, open is a 404, the text is in the trash', async () => {
    make();
    await dir.open('a');
    await dir.remove('a');
    expect((await dir.list()).map((e) => e.name)).toEqual(['b']);
    expect(await status(dir.open('a'))).toBe(404);
    expect(st.trash.has('a')).toBe(true);
    expect(await status(dir.remove('a'))).toBe(404);
  });
});

describe('format', () => {
  const newer = text([n('x')], { [FORMAT_KEY]: 99 });

  it('opening a newer board throws FormatError, leaves the file, and the list then says why', async () => {
    make({ a: newer, b: text([]) });
    await expect(dir.open('a')).rejects.toBeInstanceOf(FormatError);
    expect(st.files.get('a')).toBe(newer);
    expect(dir.loaded('a')).toBeUndefined();
    const list = await dir.list();
    expect(list.find((e) => e.name === 'a')!.error).toMatch(/format 99/);
    expect(list.find((e) => e.name === 'b')!.error).toBeUndefined();
  });

  it('a file that is not a canvas throws BoardFileError, stays byte-identical, shows in the list; other boards open', async () => {
    make({ a: '{nope', b: text([]) });
    await expect(dir.open('a')).rejects.toBeInstanceOf(BoardFileError);
    expect(st.files.get('a')).toBe('{nope');
    expect(dir.loaded('a')).toBeUndefined();
    const list = await dir.list();
    expect(list.find((e) => e.name === 'a')!.error).toMatch(/not a canvas file/);
    await expect(dir.open('b')).resolves.toBeDefined();
  });

  it('the error is forgotten when the file is edited since', async () => {
    make({ a: newer });
    await expect(dir.open('a')).rejects.toBeInstanceOf(FormatError);
    await vi.advanceTimersByTimeAsync(10);
    st.externalWrite('a', text([]));
    expect((await dir.list())[0].error).toBeUndefined();
    await dir.open('a');
  });
});

describe('validName', () => {
  it('accepts ordinary names', () => {
    for (const ok of ['checkout-flow', 'Q3 plan', 'été', 'a.b']) expect(validName(ok), ok).toBeUndefined();
  });
});

describe('screenshot pages', () => {
  /** A provider whose pages are connections to the board; drop closes them. */
  const withShots = () => {
    const drops: string[] = [];
    const clients: ReturnType<typeof fakeClient>[] = [];
    const shots = {
      shoot: async () => {
        throw new Error('unused');
      },
      drop: async (name: string) => {
        drops.push(`${name}:${dir.loaded(name)?.connections}`);
        const open = clients.filter((c) => !c.closed);
        open.forEach((c) => c.disconnect());
        return open.length;
      },
      close: async () => {},
    };
    make(undefined, { shots });
    return { drops, clients };
  };

  it('rename and delete drop the pages first, so a warm page does not block them', async () => {
    const { drops, clients } = withShots();
    clients.push(fakeClient(await dir.open('a')));
    await dir.rename('a', 'c');
    expect(drops).toEqual(['a:1']);
    expect(st.files.has('c')).toBe(true);
    clients.push(fakeClient(await dir.open('b')));
    await dir.remove('b');
    expect(drops).toEqual(['a:1', 'b:1']);
  });

  it('a real browser still blocks a rename (409) after the pages are dropped', async () => {
    withShots();
    fakeClient(await dir.open('a'));
    expect(await status(dir.rename('a', 'c'))).toBe(409);
  });

  it('closeAll and the idle sweep drop the board’s pages before unloading', async () => {
    const { drops } = withShots();
    await dir.open('a');
    await dir.sweep(later());
    expect(drops).toEqual(['a:0']);
    await dir.open('b');
    await dir.closeAll();
    expect(drops).toEqual(['a:0', 'b:0']);
  });
});
