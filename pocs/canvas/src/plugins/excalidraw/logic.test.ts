import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../../core/store';
import { registerCoreCommands } from '../../core/commands';
import { FRAME, NS, PAD, BAR, elementsOf, viewOf, describe as shapesOf, liveElements, registerExcalidrawLogic, type XElement } from './logic';

let n = 0;
function store(ydoc?: Y.Doc) {
  const s = new Store({ ydoc, ctx: { newId: () => `id${++n}`, random: () => 0.25, now: () => 1000 } });
  registerCoreCommands(s);
  registerExcalidrawLogic(s);
  return s;
}
const el = (id: string, o: Partial<XElement> = {}): XElement => ({ id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version: 1, versionNonce: 1, index: 'a0', ...o });
const drawing = (s: Store) => s.doc.nodes.find((x) => x[NS])!;

describe('excalidraw drawings', () => {
  it('creates a frame (default size centered, or the dragged box) that keeps its size as the drawing grows', () => {
    const s = store();
    const id = s.dispatch('excalidraw.create', { x: 0, y: 0 }).select![0];
    expect(s.doc.get(id)).toMatchObject({ type: 'text', x: -410, y: -280, width: 820, height: 560, [NS]: {} });
    s.dispatch('excalidraw.put', { id, elements: [el('r', { x: -900, y: 20, width: 2000, height: 100 })] });
    expect(s.doc.get(id)).toMatchObject({ x: -410, width: 820, height: 560 });
    const d = s.dispatch('excalidraw.create', { x: 10, y: 20, width: 50, height: 300, title: ' Flow ' }).select![0];
    expect(s.doc.get(d)).toMatchObject({ x: 10, y: 20, width: 160, height: 300, [FRAME]: { title: 'Flow' } });
  });

  it('put writes what the editor sends (above a newer stored copy) and is one undo step', () => {
    const s = store();
    const id = s.dispatch('excalidraw.create', { x: 0, y: 0, elements: [el('r', { version: 3 })] }).select![0];
    s.dispatch('excalidraw.put', { id, elements: [el('r', { version: 3 })] });
    expect(s.undoManager.undoStack).toHaveLength(1); // same element: nothing written
    s.dispatch('excalidraw.put', { id, elements: [el('r', { version: 2, x: 99 })] });
    expect(elementsOf(s.doc.get(id))[0]).toMatchObject({ x: 99, version: 4 });
    s.dispatch('excalidraw.put', { id, elements: [el('r', { version: 9, x: 5 }), el('s', { index: 'a1' })] });
    expect(elementsOf(s.doc.get(id)).map((e) => [e.id, e.x, e.version])).toEqual([['r', 5, 9], ['s', 0, 1]]);
    s.undo();
    expect(elementsOf(s.doc.get(id)).map((e) => [e.id, e.x])).toEqual([['r', 99]]);
  });

  it('two people editing different elements both keep theirs (per-element fields)', () => {
    const a = store();
    const id = a.dispatch('excalidraw.create', { x: 0, y: 0, elements: [el('r'), el('s', { index: 'a1' })] }).select![0];
    const b = store(new Y.Doc());
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    a.dispatch('excalidraw.put', { id, elements: [el('r', { version: 2, x: 5 })] });
    b.dispatch('excalidraw.put', { id, elements: [el('s', { version: 2, index: 'a1', x: 7 })] });
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    for (const s of [a, b]) expect(elementsOf(s.doc.get(id)).map((e) => [e.id, e.x])).toEqual([['r', 5], ['s', 7]]);
  });

  it('agents add labelled shapes and bound arrows; arrows to existing shapes bump them', () => {
    const s = store();
    const id = s.dispatch('excalidraw.create', { x: 0, y: 0, shapes: [{ type: 'rectangle', ref: 'start', label: 'Start' }] }).select![0];
    s.dispatch('excalidraw.add', {
      id,
      shapes: [
        { type: 'diamond', ref: 'ok', label: 'OK?' },
        { type: 'arrow', from: 'start', to: 'ok', label: 'check' },
      ],
    });
    const els = liveElements(s.doc.get(id));
    const start = els.find((e) => e.id === 'start')!;
    const arrow = els.find((e) => e.type === 'arrow')!;
    expect(start.version).toBe(2);
    expect(start.boundElements?.map((b) => b.type).sort()).toEqual(['arrow', 'text']);
    expect(arrow).toMatchObject({ startBinding: { elementId: 'start' }, endBinding: { elementId: 'ok' }, endArrowhead: 'arrow' });
    // every element sorts after the ones before it (fractional indices)
    const idx = elementsOf(s.doc.get(id)).map((e) => e.index!);
    expect([...idx].sort()).toEqual(idx);
    expect(new Set(idx).size).toBe(idx.length);
    expect(shapesOf(s.doc.get(id)!)).toEqual([
      expect.objectContaining({ id: 'start', type: 'rectangle', label: 'Start' }),
      expect.objectContaining({ id: 'ok', type: 'diamond', label: 'OK?' }),
      expect.objectContaining({ type: 'arrow', label: 'check', from: 'start', to: 'ok' }),
    ]);
  });

  it('remove deletes shapes with their labels (tombstones, newer version)', () => {
    const s = store();
    const id = s.dispatch('excalidraw.create', { x: 0, y: 0, shapes: [{ type: 'ellipse', ref: 'e', label: 'Hi' }, { type: 'rectangle', ref: 'r' }] }).select![0];
    s.dispatch('excalidraw.remove', { id, ids: ['e'] });
    expect(liveElements(s.doc.get(id)).map((e) => e.id)).toEqual(['r']);
    expect(elementsOf(s.doc.get(id)).filter((e) => e.isDeleted)).toHaveLength(2);
  });

  it('exports as a valid JSON Canvas text node with the drawing words, and reopens the same', () => {
    const s = store();
    s.dispatch('excalidraw.create', { x: 0, y: 0, shapes: [{ type: 'rectangle', label: 'Order\nplaced' }] });
    const doc = s.exportDoc();
    const node = doc.nodes[0];
    expect(node.text).toContain('Excalidraw drawing');
    expect(node.text).toContain('- Order placed');
    const t = store();
    t.load(JSON.parse(JSON.stringify(doc)));
    expect(elementsOf(drawing(t))).toEqual(elementsOf(drawing(s)));
  });
});

describe('frame view, title, lock', () => {
  it('fits the drawing until a view is saved; frame command sets title, lock, view and size (one undo step each)', () => {
    const s = store();
    const id = s.dispatch('excalidraw.create', { x: 0, y: 0, width: 400, height: 300 + BAR, elements: [el('r', { x: 100, y: 100, width: 1000, height: 100 })] }).select![0];
    const fit = viewOf(s.doc.get(id)!);
    expect(fit.zoom).toBeCloseTo(400 / (1000 + PAD * 2));
    expect(fit.x + 400 / fit.zoom / 2).toBeCloseTo(600); // centered on the content
    s.dispatch('excalidraw.frame', { id, view: { x: 5, y: 6, zoom: 2 }, title: 'Plan', locked: true, width: 500 });
    expect(viewOf(s.doc.get(id)!)).toEqual({ x: 5, y: 6, zoom: 2 });
    expect(s.doc.get(id)).toMatchObject({ width: 500, [FRAME]: { title: 'Plan', locked: true } });
    s.dispatch('excalidraw.frame', { id, view: null, locked: false, title: '' });
    expect(s.doc.get(id)![FRAME]).toEqual({});
    s.undo();
    expect(s.doc.get(id)![FRAME]).toMatchObject({ title: 'Plan', locked: true });
  });

  it('an agent adding shapes outside the saved view goes back to fitting the drawing', () => {
    const s = store();
    const id = s.dispatch('excalidraw.create', { x: 0, y: 0 }).select![0];
    s.dispatch('excalidraw.frame', { id, view: { x: 0, y: 0, zoom: 1 } });
    s.dispatch('excalidraw.add', { id, shapes: [{ type: 'rectangle', x: 10, y: 10 }] });
    expect(s.doc.get(id)![FRAME]).toMatchObject({ view: { zoom: 1 } });
    s.dispatch('excalidraw.add', { id, shapes: [{ type: 'rectangle', x: 5000, y: 10 }] });
    expect(s.doc.get(id)![FRAME]).not.toHaveProperty('view');
  });

  it('export text names the frame', () => {
    const s = store();
    s.dispatch('excalidraw.create', { x: 0, y: 0, title: 'Checkout', shapes: [{ type: 'rectangle', label: 'Pay' }] });
    expect(s.exportDoc().nodes[0].text).toContain('**Checkout (Excalidraw)**');
  });
});

describe('bounds', () => {
  it('counts a rotated shape’s corners (fitting the frame)', async () => {
    const { bounds } = await import('./logic');
    const b = bounds([el('r', { x: 0, y: 0, width: 100, height: 20, angle: Math.PI / 2 })])!;
    expect(b.y).toBeCloseTo(-40);
    expect(b.h).toBeCloseTo(100);
  });
});
