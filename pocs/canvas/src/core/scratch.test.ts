import { describe, expect, it } from 'vitest';
import { Store } from './store';
import { registerCoreCommands } from './commands';
import { Scratch } from './scratch';
import { applyChanges, set, type CanvasNode } from './doc';

const box = (id: string, x = 0): CanvasNode => ({ id, type: 'text', x, y: 0, width: 10, height: 10, text: id });
function store() {
  const s = new Store();
  registerCoreCommands(s);
  s.load({ nodes: [box('a'), box('b', 50)], edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] });
  return s;
}

describe('applyChanges', () => {
  it('applies sets (namespaced too), adds and deletes like the store, without touching the input', () => {
    const doc = { nodes: [box('a')], edges: [{ id: 'e', fromNode: 'a', toNode: 'a' }] };
    const out = applyChanges(doc, [set('a', 'x', 5), set('a', 'x-p.k', 1), set('a', 'x-p.j', 2), set('a', 'x-p.k', undefined), set('zz', 'x', 1), { op: 'add', node: box('c') }]);
    expect(out.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 5, 'x-p': { j: 2 } });
    expect(doc.nodes[0].x).toBe(0);
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(applyChanges(out, [{ op: 'del', id: 'a' }]).edges).toEqual([]);
  });
});

describe('Scratch', () => {
  it('each call sees the previous ones; the whole run is one dispatch = one undo step', () => {
    const s = store();
    s.register('test.twice', (doc, _a, ctx) => {
      const run = new Scratch(s, doc, ctx);
      run.call('core.move', { ids: ['a'], dx: 10, dy: 0 });
      run.call('core.move', { ids: ['a'], dx: run.doc.get('a')!.x, dy: 0 }); // reads the moved x (10)
      run.call('core.delete', { ids: ['b'] });
      expect(s.doc.get('a')!.x).toBe(0); // nothing applied yet
      return { changes: run.changes, events: [{ type: 'test', text: 'did it' }] };
    });
    s.dispatch('test.twice', {});
    expect(s.doc.get('a')!.x).toBe(20);
    expect(s.doc.get('b')).toBeUndefined();
    expect(s.log.length).toBe(1);
    s.undo();
    expect(s.doc.get('a')!.x).toBe(0);
    expect(s.doc.get('b')).toBeDefined();
  });
  it('unknown commands fail without changes', () => {
    const s = store();
    const run = new Scratch(s, s.doc, s.ctx);
    expect(run.call('nope', {}).ok).toBe(false);
    s.register('test.throws', () => {
      throw new Error('boom');
    });
    expect(run.call('test.throws', {}).error).toBe('test.throws: boom');
    expect(run.changes).toEqual([]);
    expect(run.failures).toEqual(['unknown command: nope', 'test.throws: boom']);
  });
});

describe('onDispatch', () => {
  it('fires after local dispatches that changed something; a listener can join the undo step', () => {
    const s = store();
    const seen: string[] = [];
    s.onDispatch((name) => {
      seen.push(name);
      if (name === 'core.move') s.dispatch('core.delete', { ids: ['b'] }, { merge: true });
    });
    s.dispatch('core.move', { ids: ['nope'], dx: 1, dy: 0 }); // no changes: no call
    s.dispatch('core.move', { ids: ['a'], dx: 5, dy: 0 });
    expect(seen).toEqual(['core.move', 'core.delete']);
    s.undo();
    expect(s.doc.get('a')!.x).toBe(0);
    expect(s.doc.get('b')).toBeDefined();
  });
});
