import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, parse, serialize, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { parseControl, registerClockLogic } from './index';
import { FIELD, clock, fmt, remaining, type ClockField } from './model';

function ctx(prefix = 'id'): CommandCtx {
  let n = 0;
  return { newId: () => `${prefix}${++n}`, random: () => 0.5 };
}
function store(ydoc?: Y.Doc, p = 'id') {
  const s = new Store({ ctx: ctx(p), ydoc });
  registerCoreCommands(s);
  registerClockLogic(s);
  return s;
}
const MIN = 60_000;
/** A store with a 5+3 clock `id1`. */
function withClock(base = 5 * MIN, inc = 3000) {
  const s = store();
  s.dispatch('clock.create', { x: 0, y: 0, base, inc });
  return s;
}
const c = (s: Store) => clock(s.doc.get('id1')!);
const tap = (s: Store, side: 0 | 1, now: number) => s.dispatch('clock.tap', { id: 'id1', side, now }, { undoable: false });
const left = (s: Store, side: 0 | 1, now: number) => remaining(c(s), side, now);

describe('clock time math', () => {
  it('first tap starts the other side; taps add the increment and switch', () => {
    const s = withClock();
    expect(left(s, 0, 999)).toBe(5 * MIN);
    tap(s, 1, 1000); // black starts white's clock
    expect(c(s)).toMatchObject({ run: 0, since: 1000 });
    expect(left(s, 0, 11_000)).toBe(5 * MIN - 10_000);
    expect(left(s, 1, 11_000)).toBe(5 * MIN);
    expect(tap(s, 1, 5000).changes).toEqual([]); // the waiting side can't tap
    tap(s, 0, 11_000);
    expect(c(s)).toMatchObject({ run: 1, since: 11_000, left0: 5 * MIN - 10_000 + 3000 });
    expect(left(s, 1, 31_000)).toBe(5 * MIN - 20_000);
    tap(s, 1, 31_000);
    expect(c(s).left1).toBe(5 * MIN - 20_000 + 3000);
    expect(c(s).run).toBe(0);
  });

  it('pause freezes the running side; resume continues from there', () => {
    const s = withClock();
    tap(s, 1, 0);
    s.dispatch('clock.pause', { id: 'id1', now: 4000 });
    expect(c(s)).toMatchObject({ paused: true, left0: 5 * MIN - 4000, run: 0 });
    expect(c(s).since).toBeUndefined();
    expect(left(s, 0, 999_999)).toBe(5 * MIN - 4000);
    expect(tap(s, 0, 5000).changes).toEqual([]); // no taps while paused
    s.dispatch('clock.resume', { id: 'id1', now: 100_000 });
    expect(left(s, 0, 101_000)).toBe(5 * MIN - 5000);
  });

  it('flags at 0: red side, clock stops; reset and time controls start over', () => {
    const s = withClock(10_000, 0);
    tap(s, 1, 0);
    expect(s.dispatch('clock.flag', { id: 'id1', now: 9_999 }).changes).toEqual([]); // not yet
    s.dispatch('clock.flag', { id: 'id1', now: 10_050 });
    expect(c(s)).toMatchObject({ flag: 0, left0: 0 });
    expect(left(s, 0, 50_000)).toBe(0);
    expect(left(s, 1, 50_000)).toBe(10_000);
    expect(tap(s, 0, 11_000).changes).toEqual([]);
    expect(s.dispatch('clock.flag', { id: 'id1', now: 12_000 }).changes).toEqual([]); // idempotent
    s.dispatch('clock.reset', { id: 'id1' });
    expect(c(s)).toEqual({ kind: 'clock', base: 10_000, inc: 0, left0: 10_000, left1: 10_000 });
    s.dispatch('clock.control', { id: 'id1', base: 3 * MIN, inc: 2000 });
    expect(c(s)).toEqual({ kind: 'clock', base: 3 * MIN, inc: 2000, left0: 3 * MIN, left1: 3 * MIN });
    expect(s.dispatch('clock.control', { id: 'id1', base: -1, inc: 0 }).changes).toEqual([]);
  });

  it('a tap after time ran out flags instead of adding the increment', () => {
    const s = withClock(5000, 3000);
    tap(s, 1, 0);
    tap(s, 0, 6000);
    expect(c(s)).toMatchObject({ flag: 0, left0: 0, run: 0 });
  });

  it('not-undoable dispatches stay out of undo; core.reset resets clocks', () => {
    const s = withClock();
    tap(s, 1, 0);
    tap(s, 0, 2000);
    s.undo(); // undoes the creation (the only undoable step), not the taps
    expect(s.doc.get('id1')).toBeUndefined();
    const t = withClock();
    tap(t, 1, 0);
    t.dispatch('core.reset', {});
    expect(c(t).run).toBeUndefined();
    expect(c(t).left0).toBe(5 * MIN);
  });

  it('undoing a table reset leaves a reset clock reset (no running clock with a stale start time)', () => {
    const s = withClock();
    s.dispatch('clock.create', { x: 400, y: 0 });
    tap(s, 1, 0);
    tap(s, 0, 2000);
    s.dispatch('clock.rotate', { id: 'id2' });
    s.dispatch('core.reset', {}); // only clocks to reset: not an undo step at all
    s.undo(); // undoes the rotate; the clocks stay as reset
    expect(clock(s.doc.get('id2')!).rot).toBeUndefined();
    expect(c(s).run).toBeUndefined();
    expect(c(s).since).toBeUndefined();
    expect(c(s).left0).toBe(5 * MIN);
  });

  it('concurrent taps on two peers converge to one state', () => {
    const a = withClock();
    const b = store(new Y.Doc(), 'p');
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    tap(a, 1, 0);
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(b.ydoc)));
    // both players hit white's side at nearly the same time
    tap(a, 0, 10_000);
    tap(b, 0, 10_200);
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(b.ydoc)));
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.ydoc)));
    expect(c(a)).toEqual(c(b));
    expect(c(a).run).toBe(1);
    expect([5 * MIN - 10_000 + 3000, 5 * MIN - 10_200 + 3000]).toContain(c(a).left0);
  });

  it('formats times and round-trips through JSON Canvas with readable text', () => {
    expect([fmt(3_600_000 + 65_000), fmt(299_001), fmt(20_000), fmt(19_450), fmt(-5)]).toEqual(['1:01:05', '5:00', '0:20', '19.4', '0.0']);
    const s = withClock();
    tap(s, 1, 0);
    const text = serialize(s.exportDoc());
    const node = JSON.parse(text).nodes[0];
    expect(node.text).toBe('Game clock 5+3: White 5:00 / Black 5:00');
    const t = store();
    t.load(parse(text));
    expect(clock(t.doc.get('id1')!)).toEqual(c(s));
    // bad data is dropped or repaired
    t.load(
      parse(
        JSON.stringify({
          nodes: [
            { id: 'a', type: 'text', x: 0, y: 0, width: 1, height: 1, [FIELD]: { kind: 'clock', base: 'x', inc: 0 } },
            { id: 'b', type: 'text', x: 0, y: 0, width: 1, height: 1, [FIELD]: { kind: 'clock', base: 60000, inc: 0, run: 0, left0: -4 } },
          ],
          edges: [],
        }),
      ),
    );
    expect(t.doc.get('a')![FIELD]).toBeUndefined();
    expect(t.doc.get('b')![FIELD] as ClockField).toEqual({ kind: 'clock', base: 60000, inc: 0, left0: 60000, left1: 60000, run: 0, paused: true });
  });

  it('per-side controls: each side starts from and gains its own; reset and export follow', () => {
    const s = withClock();
    s.dispatch('clock.control', { id: 'id1', base: 5 * MIN, inc: 0, base1: 3 * MIN, inc1: 2000 });
    expect(c(s)).toMatchObject({ base: 5 * MIN, inc: 0, base1: 3 * MIN, inc1: 2000, left0: 5 * MIN, left1: 3 * MIN });
    tap(s, 1, 0);
    tap(s, 0, 10_000); // white: no increment
    expect(c(s).left0).toBe(5 * MIN - 10_000);
    tap(s, 1, 15_000); // black: +2 s
    expect(c(s).left1).toBe(3 * MIN - 5000 + 2000);
    expect(JSON.parse(serialize(s.exportDoc())).nodes[0].text).toMatch(/^Game clock 5\+0 \/ 3\+2:/);
    s.dispatch('clock.reset', { id: 'id1' });
    expect([c(s).left0, c(s).left1]).toEqual([5 * MIN, 3 * MIN]);
    // a round trip keeps the handicap
    const t = store();
    t.load(parse(serialize(s.exportDoc())));
    expect(clock(t.doc.get('id1')!)).toEqual(c(s));
    // presets / same-for-both drop it; a "split" equal to the shared control isn't stored
    s.dispatch('clock.control', { id: 'id1', base: MIN, inc: 0 });
    expect(c(s).base1).toBeUndefined();
    s.dispatch('clock.control', { id: 'id1', base: MIN, inc: 0, base1: MIN, inc1: 0 });
    expect(c(s).base1).toBeUndefined();
    expect(s.dispatch('clock.control', { id: 'id1', base: MIN, inc: 0, base1: -1, inc1: 0 }).changes).toEqual([]);
    expect(parseControl('5+0')).toEqual({ base: 5 * MIN, inc: 0 });
    expect(parseControl(' 0.5 + 2 ')).toEqual({ base: 30_000, inc: 2000 });
    expect(parseControl('x')).toBeUndefined();
  });

  it('rotate cycles 0/90/180/270 around the center, tall at 90/270, and round-trips', () => {
    const s = withClock();
    const n0 = s.doc.get('id1')!;
    const mid = (n: typeof n0) => [n.x + n.width / 2, n.y + n.height / 2];
    const seen: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      s.dispatch('clock.rotate', { id: 'id1' });
      const n = s.doc.get('id1')!;
      seen.push([c(s).rot, n.width > n.height ? 'wide' : 'tall']);
      expect(mid(n)).toEqual(mid(n0));
    }
    expect(seen).toEqual([[90, 'tall'], [180, 'wide'], [270, 'tall'], [undefined, 'wide']]);
    s.dispatch('clock.rotate', { id: 'id1' });
    const t = store();
    t.load(parse(serialize(s.exportDoc())));
    expect(clock(t.doc.get('id1')!).rot).toBe(90);
    expect(t.doc.get('id1')!.height).toBeGreaterThan(t.doc.get('id1')!.width);
  });

  it('log: start, pause, resume, flag fall (by nobody), reset, time control; plain taps are not logged', () => {
    const s = withClock(1000, 0);
    s.actor = () => ({ id: 'a', name: 'Ann', color: '#f00' });
    const texts = () => s.log.toArray().map((e) => (e.actor ? `${e.actor.name} ` : '') + e.text);
    tap(s, 1, 0);
    tap(s, 0, 100);
    s.dispatch('clock.pause', { id: 'id1', now: 200 }, { undoable: false });
    s.dispatch('clock.resume', { id: 'id1', now: 300 }, { undoable: false });
    s.dispatch('clock.flag', { id: 'id1', now: 5000 }, { undoable: false });
    s.dispatch('clock.flag', { id: 'id1', now: 5100 }, { undoable: false });
    s.dispatch('clock.reset', { id: 'id1' }, { undoable: false });
    s.dispatch('clock.control', { id: 'id1', base: 5 * MIN, inc: 3000 }, { undoable: false });
    expect(texts()).toEqual(['Ann started the clock (White to move)', 'Ann paused the clock', 'Ann resumed the clock', 'Black’s time ran out', 'Ann reset the clock', 'Ann set the clock to 5+3']);
  });
});
