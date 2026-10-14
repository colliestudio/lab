import { describe, expect, it } from 'vitest';
import { Store } from './store';
import { clipToBox } from './view';

const node = (id: string, x = 0) => ({ id, type: 'text', x, y: 0, width: 100, height: 50 });

describe('edge changes', () => {
  it('adds, replaces and removes edges; undo restores them', () => {
    const s = new Store();
    s.register('t.link', (_d, a: { id: string; from: string; to: string; label?: string }) => [{ op: 'edge', edge: { id: a.id, fromNode: a.from, toNode: a.to, label: a.label } }]);
    s.register('t.unlink', (_d, a: { id: string }) => [{ op: 'unedge', id: a.id }]);
    s.load({ nodes: [node('a'), node('b', 200)], edges: [] });
    s.dispatch('t.link', { id: 'e', from: 'a', to: 'b' });
    expect(s.doc.edges).toEqual([{ id: 'e', fromNode: 'a', toNode: 'b' }]);
    s.dispatch('t.link', { id: 'e', from: 'a', to: 'b', label: 'x' });
    expect(s.doc.edges[0].label).toBe('x');
    s.dispatch('t.unlink', { id: 'e' });
    expect(s.doc.edges).toEqual([]);
    s.undo();
    expect(s.doc.edges[0].label).toBe('x');
  });
  it('skips an edge whose ends are missing', () => {
    const s = new Store();
    s.load({ nodes: [node('a')], edges: [] });
    s.apply([{ op: 'edge', edge: { id: 'e', fromNode: 'a', toNode: 'zz' } }]);
    expect(s.doc.edges).toEqual([]);
  });
});

describe('clipToBox', () => {
  it('meets the border of the box on the way to its center', () => {
    expect(clipToBox({ x: 300, y: 25 }, { x: 50, y: 25 }, { x: 0, y: 0, w: 100, h: 50 })).toEqual({ x: 100, y: 25 });
    expect(clipToBox({ x: 50, y: 225 }, { x: 50, y: 25 }, { x: 0, y: 0, w: 100, h: 50 })).toEqual({ x: 50, y: 50 });
  });
});
