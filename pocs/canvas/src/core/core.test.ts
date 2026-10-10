import { describe, expect, it } from 'vitest';
import { parse, serialize } from './io';
import { Store } from './store';
import { registerCoreCommands } from './commands';
import type { CanvasDoc } from './doc';

const file = {
  version: '1.0-x',
  'x-app': { theme: 'felt' },
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A♠', color: '3' },
    { id: 'b', type: 'text', x: 5, y: 5, width: 10, height: 10, text: 'hi', 'x-other': { k: [1, 2] } },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'x', 'x-other': 1 }],
};

function store(doc?: CanvasDoc) {
  const s = new Store();
  registerCoreCommands(s);
  if (doc) s.load(doc);
  return s;
}

describe('io', () => {
  it('round-trips nodes, edges and unknown top-level fields through the Y store', () => {
    const s = store(parse(JSON.stringify(file)));
    expect(JSON.parse(serialize(s.exportDoc()))).toEqual(file);
  });
  it('exports nodes in z order without the z field', () => {
    const s = store(parse(JSON.stringify(file)));
    s.dispatch('core.front', { ids: ['a'] });
    const out = JSON.parse(serialize(s.exportDoc()));
    expect(out.nodes.map((n: any) => n.id)).toEqual(['b', 'a']);
    expect(out.nodes[0].z).toBeUndefined();
  });
  it('skips malformed nodes and dangling edges instead of failing', () => {
    const d = parse(
      JSON.stringify({ nodes: [{ id: 'a', type: 'text', x: '0', y: 0, width: 1, height: 1 }, file.nodes[0]], edges: file.edges }),
    );
    expect(d.nodes.map((n) => n.id)).toEqual(['a']);
    expect(d.edges).toEqual([]);
    expect(d.skipped).toHaveLength(2);
    expect(() => parse('[]')).toThrow();
  });
});

describe('store', () => {
  it('applies per-field changes and keeps plugin fields as nested maps', () => {
    const s = store(parse(JSON.stringify(file)));
    s.apply([{ op: 'set', id: 'b', key: 'x-other.k', value: 7 }, { op: 'set', id: 'a', key: 'color', value: undefined }]);
    expect(s.doc.get('b')!['x-other']).toEqual({ k: 7 });
    expect(s.doc.get('a')!.color).toBeUndefined();
    // a set on a deleted node doesn't resurrect it
    s.apply([{ op: 'del', id: 'a' }, { op: 'set', id: 'a', key: 'x', value: 1 }]);
    expect(s.doc.get('a')).toBeUndefined();
    expect(s.doc.edges).toEqual([]);
  });
  it('front is a no-op when already on top', () => {
    const s = store(parse(JSON.stringify(file)));
    expect(s.dispatch('core.front', { ids: ['b'] }).changes).toEqual([]);
    expect(s.dispatch('core.front', { ids: ['a'] }).changes).toHaveLength(1);
  });
  it('rejects bad args without throwing', () => {
    const s = store(parse(JSON.stringify(file)));
    expect(s.dispatch('core.move', { ids: 'a', dx: 1, dy: 1 }).changes).toEqual([]);
    expect(s.dispatch('core.move', null).changes).toEqual([]);
    expect(s.dispatch('nope', {}).ok).toBe(false);
  });
  it('undo/redo one dispatch at a time; merged dispatches undo together', () => {
    const s = store(parse(JSON.stringify(file)));
    s.dispatch('core.move', { ids: ['a'], dx: 10, dy: 0 });
    s.dispatch('core.move', { ids: ['a'], dx: 10, dy: 0 });
    s.dispatch('core.move', { ids: ['a'], dx: 10, dy: 0 }, { merge: true });
    expect(s.doc.get('a')!.x).toBe(30);
    s.undo();
    expect(s.doc.get('a')!.x).toBe(10);
    s.undo();
    expect(s.doc.get('a')!.x).toBe(0);
    s.redo();
    expect(s.doc.get('a')!.x).toBe(10);
  });
  it('selection drops deleted nodes', () => {
    const s = store(parse(JSON.stringify(file)));
    s.select(['a', 'b']);
    s.dispatch('core.delete', { ids: ['a'] });
    expect([...s.selection]).toEqual(['b']);
  });
});
