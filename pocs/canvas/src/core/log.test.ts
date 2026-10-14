import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { set, type CanvasNode } from './doc';
import { LOG_CAP, eventLine, textFor, type LogEvent } from './log';
import { Store } from './store';

const node = (id: string): CanvasNode => ({ id, type: 'text', x: 0, y: 0, width: 10, height: 10 });

let n = 0;
function store(ydoc?: Y.Doc, who = { id: 'alice', name: 'Alice', color: '#f00' }) {
  const s = new Store({ ydoc, ctx: { newId: () => `id${++n}`, random: Math.random, now: () => 1000 } });
  s.actor = () => who;
  s.register('t.paint', (_doc, a: { id: string; color: string }) => ({
    changes: [set(a.id, 'color', a.color)],
    events: (after) => [{ type: 't.paint', text: `painted it ${after.get(a.id)?.color}`, targets: [a.id] }],
  }));
  s.register('t.quiet', (_doc, a: { id: string }) => [set(a.id, 'x', 5)]);
  s.register('t.secret', () => ({
    changes: [],
    events: [{ type: 't.secret', text: 'drew a card', private: [{ to: ['alice'], text: 'drew 7♥' }], key: 'k1' }],
  }));
  s.load({ nodes: [node('a')], edges: [] });
  return s;
}
const log = (s: Store) => s.log.toArray();

describe('event log', () => {
  it('commands log events computed from the state after their changes; plain moves log nothing', () => {
    const s = store();
    s.dispatch('t.quiet', { id: 'a' });
    expect(log(s)).toEqual([]);
    s.dispatch('t.paint', { id: 'a', color: 'red' });
    expect(log(s)).toMatchObject([{ type: 't.paint', text: 'painted it red', targets: ['a'], actor: { id: 'alice', name: 'Alice' }, time: 1000 }]);
  });

  it('logging is not an undo step: undo reverts the change and logs "undid", redo logs "redid"', () => {
    const s = store();
    s.dispatch('t.paint', { id: 'a', color: 'red' });
    s.dispatch('t.paint', { id: 'a', color: 'blue' });
    s.undo();
    expect(s.doc.get('a')!.color).toBe('red');
    expect(log(s).map((e) => e.text)).toEqual(['painted it red', 'painted it blue', 'undid: painted it blue']);
    s.redo();
    expect(s.doc.get('a')!.color).toBe('blue');
    expect(log(s).at(-1)!.text).toBe('redid: painted it blue');
    s.undo();
    s.undo();
    expect(s.doc.get('a')!.color).toBeUndefined();
    expect(log(s).at(-1)!.text).toBe('undid: painted it red');
  });

  it('a step without events undoes silently', () => {
    const s = store();
    s.dispatch('t.quiet', { id: 'a' });
    s.undo();
    expect(log(s)).toEqual([]);
  });

  it('per viewer text: the private variant only for the players it names', () => {
    const s = store();
    s.dispatch('t.secret', {});
    const e = log(s)[0];
    expect(textFor(e, 'alice')).toBe('drew 7♥');
    expect(textFor(e, 'bob')).toBe('drew a card');
    expect(eventLine(e, 'alice')).toBe('You drew 7♥');
    expect(eventLine(e, 'bob')).toBe('Alice drew a card');
    expect(eventLine({ ...e, actor: null, text: 'white’s time ran out' } as LogEvent, 'bob')).toBe('White’s time ran out');
  });

  it('a repeated key from the same actor within a few seconds is logged once', () => {
    const s = store();
    s.dispatch('t.secret', {});
    s.dispatch('t.secret', {});
    expect(log(s)).toHaveLength(1);
  });

  it('keeps only the last LOG_CAP entries', () => {
    const s = store();
    for (let i = 0; i < LOG_CAP + 7; i++) s.appendLog([{ type: 't', text: `e${i}` }]);
    expect(log(s)).toHaveLength(LOG_CAP);
    expect(log(s)[0].text).toBe('e7');
  });

  it('syncs to other peers like the doc; loading a new table starts a new log', () => {
    const da = new Y.Doc();
    const db = new Y.Doc();
    da.on('update', (u: Uint8Array) => Y.applyUpdate(db, u));
    db.on('update', (u: Uint8Array) => Y.applyUpdate(da, u));
    const a = store(da);
    const b = store(db, { id: 'bob', name: 'Bob', color: '#00f' });
    a.dispatch('t.paint', { id: 'a', color: 'red' });
    expect(log(b).map((e) => [e.actor?.name, e.text])).toEqual([['Alice', 'painted it red']]);
    b.load({ nodes: [], edges: [] });
    expect(log(a)).toEqual([]);
  });
});
