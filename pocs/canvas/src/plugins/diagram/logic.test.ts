import { describe, expect, it } from 'vitest';
import { registerCoreCommands } from '../../core/commands';
import { parse, serialize } from '../../core/io';
import { Store } from '../../core/store';
import { registerDiagramLogic } from './logic';
import { isShape, shapeOf, textBox } from './model';

let n = 0;
function store() {
  const s = new Store({ ctx: { newId: () => `id${++n}`, random: () => 0.5, now: () => 1000 } });
  registerCoreCommands(s);
  registerDiagramLogic(s);
  return s;
}

describe('diagram.add', () => {
  it('makes a JSON Canvas text node with an x-shape look, centered where asked', () => {
    const s = store();
    const r = s.dispatch('diagram.add', { id: 'a', kind: 'ellipse', text: 'Start', cx: 100, cy: 50, stroke: '#e03131' });
    expect(r.ok).toBe(true);
    expect(r.select).toEqual(['a']);
    const a = s.doc.get('a')!;
    expect(a).toMatchObject({ type: 'text', text: 'Start', width: 160, height: 90, x: 20, y: 5 });
    expect(shapeOf(a)).toEqual({ kind: 'ellipse', stroke: '#e03131' });
    expect(isShape(a)).toBe(true);
  });

  it('refuses a duplicate id or a bad kind; a text shape is sized to its words', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a', text: 'x' });
    expect(s.dispatch('diagram.add', { id: 'a' }).changes).toEqual([]);
    expect(s.dispatch('diagram.add', { kind: 'blob' as never }).changes).toEqual([]);
    s.dispatch('diagram.add', { id: 't', kind: 'text', text: 'a long line of words\nsecond', x: 0, y: 0 });
    const t = s.doc.get('t')!;
    expect({ w: t.width, h: t.height }).toEqual(textBox('a long line of words\nsecond', 18));
  });

  it('puts the next shape beside the others when no place is given', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a', x: 0, y: 0 });
    s.dispatch('diagram.add', { id: 'b' });
    expect(s.doc.get('b')!.x).toBeGreaterThan(160);
  });

  it('one undo removes it', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a' });
    s.undo();
    expect(s.doc.nodes).toEqual([]);
  });
});

describe('x-shape in the file', () => {
  it('survives save, parse and load; the words stay in `text` for Obsidian', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a', kind: 'diamond', text: 'Valid?', x: 0, y: 0, fill: '#a5d8ff', dashed: true });
    s.dispatch('diagram.add', { id: 'b', kind: 'rect', text: 'Yes', x: 300, y: 0 });
    s.dispatch('core.connect', { id: 'e', from: 'a', to: 'b', fromSide: 'right', label: 'ok', dashed: true });
    const text = serialize(s.exportDoc());
    const file = JSON.parse(text);
    expect(file.nodes[0]).toMatchObject({ id: 'a', type: 'text', text: 'Valid?', 'x-shape': { kind: 'diamond', fill: '#a5d8ff', dashed: true } });
    expect(file.edges[0]).toMatchObject({ id: 'e', fromNode: 'a', toNode: 'b', fromSide: 'right', label: 'ok', 'x-edge': { dashed: true } });
    const s2 = store();
    const parsed = parse(text);
    expect(parsed.skipped).toEqual([]);
    s2.load(parsed);
    expect(shapeOf(s2.doc.get('a'))).toEqual({ kind: 'diamond', fill: '#a5d8ff', dashed: true });
    expect(s2.doc.edges[0]).toEqual(file.edges[0]);
  });
});

describe('diagram.update', () => {
  it('restyles several shapes in one undo step; null puts the default back', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a', x: 0, y: 0, stroke: '#e03131' });
    s.dispatch('diagram.add', { id: 'b', x: 200, y: 0 });
    s.dispatch('diagram.update', { ids: ['a', 'b'], fill: '#b2f2bb', dashed: true, size: 24 });
    expect(shapeOf(s.doc.get('b'))).toEqual({ kind: 'rect', fill: '#b2f2bb', dashed: true, size: 24 });
    s.undo();
    expect(shapeOf(s.doc.get('b'))).toEqual({ kind: 'rect' });
    s.redo();
    s.dispatch('diagram.update', { id: 'a', stroke: null, dashed: false });
    expect(shapeOf(s.doc.get('a'))).toEqual({ kind: 'rect', fill: '#b2f2bb', size: 24 });
  });

  it('edits text and moves; changing the kind of a bare text resizes it', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 't', kind: 'text', text: 'hi', x: 10, y: 10 });
    s.dispatch('diagram.update', { id: 't', text: 'a much longer line', dx: 5, y: 40 });
    const t = s.doc.get('t')!;
    expect(t).toMatchObject({ text: 'a much longer line', x: 15, y: 40 });
    expect(t.width).toBe(textBox('a much longer line', 18).w);
    s.dispatch('diagram.update', { id: 't', kind: 'sticky' });
    expect(shapeOf(s.doc.get('t'))!.kind).toBe('sticky');
  });

  it('ignores bad values and things that are not shapes', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a', x: 0, y: 0 });
    s.apply([{ op: 'add', node: { id: 'p', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'plain' } }]);
    expect(s.dispatch('diagram.update', { id: 'a', dashed: 'yes' as never, size: -3 }).changes).toEqual([]);
    expect(s.dispatch('diagram.update', { id: 'p', text: 'changed' }).changes).toEqual([]);
  });
});

describe('diagram.resize', () => {
  it('sets the box; never below the minimum, keeping the far corner', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a', x: 100, y: 100, width: 160, height: 80 });
    s.dispatch('diagram.resize', { id: 'a', x: 100, y: 100, width: 300, height: 120 });
    expect(s.doc.get('a')).toMatchObject({ x: 100, y: 100, width: 300, height: 120 });
    // dragging the west handle past the east side
    s.dispatch('diagram.resize', { id: 'a', x: 390, y: 100, width: 10, height: 120 });
    const a = s.doc.get('a')!;
    expect(a.width).toBe(24);
    expect(a.x + a.width).toBe(400);
  });
});

describe('arrows', () => {
  const two = () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a', x: 0, y: 0 });
    s.dispatch('diagram.add', { id: 'b', x: 300, y: 0 });
    return s;
  };

  it('core.connect makes a styled edge; bad ends, self loops and unknown nodes are refused', () => {
    const s = two();
    expect(s.dispatch('core.connect', { from: 'a', to: 'a' }).changes).toEqual([]);
    expect(s.dispatch('core.connect', { from: 'a', to: 'zz' }).changes).toEqual([]);
    expect(s.dispatch('core.connect', { from: 'a', to: 'b', toSide: 'middle' }).changes).toEqual([]);
    const r = s.dispatch('core.connect', { id: 'e', from: 'a', to: 'b', fromSide: 'right', toSide: 'left', label: 'go', toEnd: 'arrow', fromEnd: 'none', color: '4', curve: true });
    expect(r.select).toEqual(['e']);
    expect(s.doc.edge('e')).toEqual({ id: 'e', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', label: 'go', toEnd: 'arrow', fromEnd: 'none', color: '4', 'x-edge': { curve: true } });
    s.undo();
    expect(s.doc.edges).toEqual([]);
  });

  it('core.edge relabels, restyles and clears; one undo step each', () => {
    const s = two();
    s.dispatch('core.connect', { id: 'e', from: 'a', to: 'b' });
    s.dispatch('core.edge', { id: 'e', label: 'yes', dashed: true, toEnd: 'none', fromEnd: 'arrow' });
    expect(s.doc.edge('e')).toMatchObject({ label: 'yes', toEnd: 'none', fromEnd: 'arrow', 'x-edge': { dashed: true } });
    s.dispatch('core.edge', { id: 'e', label: null, dashed: false });
    expect(s.doc.edge('e')!.label).toBeUndefined();
    expect(s.doc.edge('e')!['x-edge']).toEqual({});
    s.undo();
    expect(s.doc.edge('e')!.label).toBe('yes');
    expect(s.dispatch('core.edge', { id: 'nope', label: 'x' }).changes).toEqual([]);
    expect(s.dispatch('core.edge', { id: 'e', toEnd: 'big' as never }).changes).toEqual([]);
  });

  it('an arrow can be selected and deleted with core.delete; undo brings it back', () => {
    const s = two();
    s.dispatch('core.connect', { id: 'e', from: 'a', to: 'b' });
    s.select(['e']);
    expect([...s.selection]).toEqual(['e']);
    s.dispatch('core.delete', { ids: [...s.selection] });
    expect(s.doc.edges).toEqual([]);
    expect([...s.selection]).toEqual([]);
    s.undo();
    expect(s.doc.edges).toHaveLength(1);
  });

  it('deleting a shape takes its arrows; undo restores both', () => {
    const s = two();
    s.dispatch('core.connect', { id: 'e', from: 'a', to: 'b' });
    s.dispatch('core.delete', { ids: ['b'] });
    expect(s.doc.edges).toEqual([]);
    s.undo();
    expect(s.doc.get('b')).toBeDefined();
    expect(s.doc.edges).toHaveLength(1);
  });

  it('addConnected: a new shape of the same kind with an arrow, in one undo step', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a', kind: 'ellipse', x: 0, y: 0, stroke: '#e03131' });
    const r = s.dispatch('diagram.addConnected', { from: 'a', side: 'bottom', id: 'b' });
    expect(r.select).toEqual(['b']);
    const b = s.doc.get('b')!;
    expect(shapeOf(b)).toMatchObject({ kind: 'ellipse', stroke: '#e03131' });
    expect(b.y).toBeGreaterThan(90);
    expect(s.doc.edges).toHaveLength(1);
    expect(s.doc.edges[0]).toMatchObject({ fromNode: 'a', toNode: 'b', fromSide: 'bottom', toSide: 'top' });
    s.undo();
    expect(s.doc.get('b')).toBeUndefined();
    expect(s.doc.edges).toEqual([]);
  });

  it('addConnected at a point: centered there, leaving by the side that faces it', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a', x: 0, y: 0, width: 100, height: 100 });
    s.dispatch('diagram.addConnected', { from: 'a', id: 'b', kind: 'diamond', at: { x: 500, y: 50 } });
    const b = s.doc.get('b')!;
    expect(b.x + b.width / 2).toBe(500);
    expect(s.doc.edges[0].fromSide).toBe('right');
  });
});

describe('duplicate and paste', () => {
  it('core.duplicate copies the arrows between the copied shapes', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a', x: 0, y: 0 });
    s.dispatch('diagram.add', { id: 'b', x: 300, y: 0 });
    s.dispatch('diagram.add', { id: 'c', x: 600, y: 0 });
    s.dispatch('core.connect', { id: 'e1', from: 'a', to: 'b', label: 'x' });
    s.dispatch('core.connect', { id: 'e2', from: 'b', to: 'c' });
    const r = s.dispatch('core.duplicate', { ids: ['a', 'b'] });
    expect(r.select).toHaveLength(2);
    expect(s.doc.nodes).toHaveLength(5);
    // e1 copied (both ends copied), e2 not (c wasn't)
    expect(s.doc.edges).toHaveLength(3);
    const copy = s.doc.edges.find((e) => e.id !== 'e1' && e.id !== 'e2')!;
    expect(r.select).toContain(copy.fromNode);
    expect(copy.label).toBe('x');
    s.undo();
    expect(s.doc.nodes).toHaveLength(3);
    expect(s.doc.edges).toHaveLength(2);
  });

  it('core.paste puts copies down with new ids and remapped arrows', () => {
    const s = store();
    s.dispatch('diagram.add', { id: 'a', x: 0, y: 0, text: 'A' });
    s.dispatch('diagram.add', { id: 'b', x: 300, y: 0, text: 'B' });
    s.dispatch('core.connect', { id: 'e', from: 'a', to: 'b' });
    const nodes = s.doc.nodes.map((x) => structuredClone(x));
    const edges = s.doc.edges.map((x) => structuredClone(x));
    s.dispatch('core.delete', { ids: ['a', 'b'] });
    const r = s.dispatch('core.paste', { nodes, edges, dx: 24, dy: 24 });
    expect(r.select).toHaveLength(2);
    expect(s.doc.nodes.map((x) => [x.text, x.x, x.y])).toEqual([['A', 24, 24], ['B', 324, 24]]);
    expect(s.doc.edges).toHaveLength(1);
    expect(s.doc.edges[0].fromNode).not.toBe('a');
    expect(r.select).toContain(s.doc.edges[0].toNode);
  });

  it('core.paste ignores junk', () => {
    const s = store();
    expect(s.dispatch('core.paste', { nodes: [{ id: 1 }, null] }).changes).toEqual([]);
    expect(s.dispatch('core.paste', {}).changes).toEqual([]);
  });
});
