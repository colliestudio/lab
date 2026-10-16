import { describe, expect, it } from 'vitest';
import { registerCoreCommands } from '../../core/commands';
import { Store } from '../../core/store';
import { registerFramesLogic } from '../frames/logic';
import { graphOf, graphText } from './graph';
import { registerDiagramLogic } from './logic';

function store() {
  let n = 0;
  const s = new Store({ ctx: { newId: () => `id${++n}`, random: () => 0.5, now: () => 1000 } });
  registerCoreCommands(s);
  registerDiagramLogic(s);
  registerFramesLogic(s);
  return s;
}
const add = (s: Store, id: string, text: string, x: number, y: number, more: Record<string, unknown> = {}) => s.dispatch('diagram.add', { id, kind: 'rect', text, x, y, ...more });

describe('graphOf / graphText', () => {
  it('lists shapes with box, non-default style and frame, arrows with ends, label and style', () => {
    const s = store();
    add(s, 's1', 'Browser', 40, 80);
    add(s, 's2', 'API server', 300, 80, { fill: '#a5d8ff' });
    add(s, 's3', 'Database', 300, 260, { kind: 'ellipse', dashed: true, height: 90 });
    add(s, 's4', 'Cache', 560, 80);
    s.dispatch('core.connect', { id: 'e1', from: 's1', to: 's2', label: 'HTTPS requests' });
    s.dispatch('core.connect', { id: 'e2', from: 's2', to: 's3', label: 'SQL queries', dashed: true });
    s.dispatch('core.connect', { id: 'e3', from: 's2', to: 's4', fromEnd: 'arrow' });
    s.dispatch('core.connect', { id: 'e4', from: 's3', to: 's4', toEnd: 'none' });
    s.dispatch('frames.create', { around: ['s1', 's2', 's3', 's4'], label: 'Architecture' });
    const t = graphText(graphOf(s.doc));
    expect(t).toBe(
      [
        'Diagram: 4 shapes, 4 arrows',
        'Shapes:',
        '  rect “Browser” (s1) · 40,80 160x80 · in Architecture',
        '  rect “API server” (s2) · 300,80 160x80 · in Architecture · fill #a5d8ff',
        '  ellipse “Database” (s3) · 300,260 160x90 · in Architecture · dashed',
        '  rect “Cache” (s4) · 560,80 160x80 · in Architecture',
        'Arrows:',
        '  “Browser” (s1) → “API server” (s2): “HTTPS requests” (e1)',
        '  “API server” (s2) → “Database” (s3): “SQL queries” (e2) · dashed',
        '  “API server” (s2) ↔ “Cache” (s4): no label (e3)',
        '  “Database” (s3) — “Cache” (s4): no label (e4)',
      ].join('\n'),
    );
  });

  it('shows a multi-line text by its first line', () => {
    const s = store();
    add(s, 'a', 'First\nsecond', 0, 0);
    expect(graphText(graphOf(s.doc))).toContain('rect “First…” (a)');
  });

  it('lists an overlapping pair once; none gives no line; an empty board says how to start', () => {
    const s = store();
    add(s, 'a', 'A', 0, 0);
    add(s, 'b', 'B', 100, 40);
    add(s, 'c', 'C', 800, 0);
    const g = graphOf(s.doc);
    expect(g.overlaps).toEqual([['a', 'b']]);
    expect(graphText(g).match(/Overlapping/g)).toHaveLength(1);
    expect(graphText(g)).toContain('Overlapping: “A” (a) and “B” (b)');
    expect(graphText(graphOf(store().doc))).toBe('No diagram shapes yet. diagram.add {kind, text} adds one.');
    const apart = store();
    add(apart, 'a', 'A', 0, 0);
    expect(graphText(graphOf(apart.doc))).not.toContain('Overlapping');
  });

  it('the in filter keeps shapes inside that frame, nested frames included, and the arrows that touch them', () => {
    const s = store();
    add(s, 'a', 'A', 0, 0);
    add(s, 'b', 'B', 200, 0);
    add(s, 'far', 'Far', 3000, 0);
    s.dispatch('core.connect', { id: 'e1', from: 'a', to: 'far' });
    s.dispatch('frames.create', { around: ['a', 'b'], label: 'Outer' });
    s.dispatch('frames.create', { around: ['b'], label: 'Inner' });
    const outer = s.doc.nodes.find((n) => n.label === 'Outer')!.id;
    const inner = s.doc.nodes.find((n) => n.label === 'Inner')!.id;
    expect(graphOf(s.doc, outer).shapes.map((x) => x.id)).toEqual(['a', 'b']);
    expect(graphOf(s.doc, inner).shapes.map((x) => x.id)).toEqual(['b']);
    expect(graphOf(s.doc, outer).arrows.map((x) => x.id)).toEqual(['e1']);
    expect(graphOf(s.doc, inner).arrows).toEqual([]);
  });
});
