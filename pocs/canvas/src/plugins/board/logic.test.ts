import { describe, expect, it } from 'vitest';
import { Store } from '../../core/store';
import { registerBoardLogic, syncId, type SyncArgs } from './logic';

let n = 0;
function store() {
  const s = new Store({ ctx: { newId: () => `id${++n}`, random: () => 0.5, now: () => 1000 } });
  registerBoardLogic(s);
  s.actor = () => ({ id: 'agent:claude', name: 'Claude', color: '#d97757' });
  return s;
}

describe('board commands', () => {
  it('adds notes, links them, logs the actor, and undoes as one step each', () => {
    const s = store();
    expect(s.dispatch('board.add', { id: 'a', text: 'Order placed' }).ok).toBe(true);
    s.dispatch('board.add', { id: 'b', text: 'Payment taken', near: 'a' });
    expect(s.doc.get('b')!.y).toBeGreaterThan(s.doc.get('a')!.y);
    s.dispatch('board.connect', { from: 'a', to: 'b', label: 'then' });
    expect(s.doc.edges).toEqual([{ id: expect.any(String), fromNode: 'a', toNode: 'b', label: 'then' }]);
    const log = s.log.toArray();
    expect(log.map((e) => `${e.actor?.name} ${e.text}`)).toEqual(['Claude added note “Order placed”', 'Claude added note “Payment taken”', 'Claude linked “Order placed” → “Payment taken” (then)']);
    s.undo();
    expect(s.doc.edges).toEqual([]);
    expect(s.doc.get('b')).toBeDefined();
  });

  it('moving a column carries its notes', () => {
    const s = store();
    s.dispatch('board.add', { id: 'c', type: 'group', label: 'Todo', x: 0, y: 0 });
    s.dispatch('board.add', { id: 'a', text: 'x', column: 'c' });
    expect(s.doc.carrierOf('a')).toBe('c');
    s.dispatch('board.update', { id: 'c', dx: 100 });
    expect(s.doc.get('a')!.x).toBe(120);
  });

  it('update moves a note to another column', () => {
    const s = store();
    s.dispatch('board.add', { id: 'c1', type: 'group', label: 'A', x: 0, y: 0 });
    s.dispatch('board.add', { id: 'c2', type: 'group', label: 'B', x: 400, y: 0 });
    s.dispatch('board.add', { id: 'a', text: 'x', column: 'c1' });
    s.dispatch('board.update', { id: 'a', column: 'c2' });
    expect(s.doc.carrierOf('a')).toBe('c2');
  });
});

describe('board.sync', () => {
  const input = (items: SyncArgs['items']): SyncArgs => ({
    source: 'backlog',
    columns: [
      { key: 'todo', label: 'To Do' },
      { key: 'doing', label: 'In Progress' },
    ],
    items,
    at: { x: 0, y: 0 },
  });
  it('creates columns and notes, is idempotent, follows column changes, keeps manual placement, removes gone items', () => {
    const s = store();
    s.dispatch('board.sync', input([
      { key: 'T-1', column: 'todo', text: 'one' },
      { key: 'T-2', column: 'todo', text: 'two' },
    ]));
    const id1 = syncId('backlog', 'T-1');
    const id2 = syncId('backlog', 'T-2');
    expect(s.doc.carrierOf(id1)).toBe('backlog:col:todo');
    expect(s.doc.get(id2)!.y).toBeGreaterThan(s.doc.get(id1)!.y);
    // same input: nothing
    expect(s.dispatch('board.sync', input([
      { key: 'T-1', column: 'todo', text: 'one' },
      { key: 'T-2', column: 'todo', text: 'two' },
    ])).changes).toEqual([]);
    // a person nudges T-2 within its column: a re-sync leaves it
    s.dispatch('board.update', { id: id2, dx: 5 });
    const x2 = s.doc.get(id2)!.x;
    s.dispatch('board.sync', input([
      { key: 'T-1', column: 'doing', text: 'one!' },
      { key: 'T-2', column: 'todo', text: 'two' },
    ]));
    expect(s.doc.get(id2)!.x).toBe(x2);
    expect(s.doc.carrierOf(id1)).toBe('backlog:col:doing');
    expect(s.doc.get(id1)!.text).toBe('one!');
    s.dispatch('board.sync', input([{ key: 'T-1', column: 'doing', text: 'one!' }]));
    expect(s.doc.get(id2)).toBeUndefined();
    expect(s.log.toArray().at(-1)!.text).toBe('synced backlog: 1 removed');
  });
});
