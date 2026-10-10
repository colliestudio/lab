import { describe, expect, it } from 'vitest';
import { applyChanges, type CanvasDoc } from './doc';
import { parse, serialize } from './io';
import { Store } from './store';
import { registerCoreCommands } from './commands';

const doc: CanvasDoc = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A♠', 'x-cards': { pack: 'standard-52', face: 'AS', faceUp: false } },
    { id: 'b', type: 'text', x: 5, y: 5, width: 10, height: 10, text: 'hi', color: '3' },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'x', 'x-other': 1 }],
};

describe('io', () => {
  it('round-trips JSON Canvas including plugin fields', () => {
    const text = serialize(doc);
    expect(parse(text)).toEqual(doc);
    expect(JSON.parse(text).nodes[0]['x-cards'].face).toBe('AS');
  });
  it('accepts a file with no edges', () => {
    expect(parse('{"nodes":[]}')).toEqual({ nodes: [], edges: [] });
  });
  it('rejects malformed nodes', () => {
    expect(() => parse('{"nodes":[{"id":"a","type":"text","x":"0","y":0,"width":1,"height":1}]}')).toThrow();
    expect(() => parse('[]')).toThrow();
  });
});

describe('changes', () => {
  it('put replaces in place, front reorders, del drops edges', () => {
    let d = applyChanges(doc, [{ op: 'put', node: { ...doc.nodes[0], x: 99 } }]);
    expect(d.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(d.nodes[0].x).toBe(99);
    expect(doc.nodes[0].x).toBe(0); // immutable
    d = applyChanges(d, [{ op: 'front', ids: ['a'] }]);
    expect(d.nodes.map((n) => n.id)).toEqual(['b', 'a']);
    d = applyChanges(d, [{ op: 'del', id: 'a' }]);
    expect(d.nodes.map((n) => n.id)).toEqual(['b']);
    expect(d.edges).toEqual([]);
  });
  it('store dispatches core commands and prunes selection', () => {
    const s = new Store();
    registerCoreCommands(s);
    s.setDoc(doc);
    s.dispatch('core.move', { ids: ['a', 'b'], dx: 2, dy: -1 });
    expect(s.doc.nodes.map((n) => [n.x, n.y])).toEqual([[2, -1], [7, 4]]);
    s.select(['a', 'b']);
    s.dispatch('core.delete', { ids: ['a'] });
    expect([...s.selection]).toEqual(['b']);
  });
});
