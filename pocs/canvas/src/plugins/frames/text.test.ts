import { describe, expect, it } from 'vitest';
import { Store, type CanvasNode } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerChessLogic } from '../chess';
import { registerFramesLogic } from './index';
import { framesOf, framesText } from './text';

const box = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: 'text', text: id, x, y, width: 50, height: 50, ...extra });
const frame = (id: string, label: string, x: number, y: number, w: number, h: number, field: object = {}): CanvasNode => ({ id, type: 'group', label, x, y, width: w, height: h, 'x-frame': field });

function store(nodes: CanvasNode[], chess = false) {
  const s = new Store();
  registerCoreCommands(s);
  if (chess) registerChessLogic(s);
  registerFramesLogic(s);
  s.load({ nodes, edges: [] });
  return s;
}
const text = (s: Store) => framesText(framesOf(s.doc));

describe('framesText', () => {
  it('numbers frames in order (skipped included), slides without them, nesting, contents, loose nodes', () => {
    const s = store([
      frame('f1', 'Architecture', 0, 0, 980, 620, { order: 0 }),
      frame('f2', 'Notes', 1100, 0, 640, 420, { order: 1, skip: true }),
      frame('f3', 'Detail', 600, 300, 300, 200, { order: 2 }),
      box('s1', 40, 80, { text: 'Browser' }),
      box('t1', 650, 350, { text: 'Retry policy' }),
      box('t2', 5000, 0, { text: 'Legend' }),
    ]);
    expect(text(s)).toBe(
      [
        'Frames, in presentation order (3 frames, 2 slides):',
        ' 1. Architecture (f1) · slide 1 · 0,0 980x620 · 2 inside: “Browser” (s1), “Detail” (f3)',
        ' 2. Notes (f2) · skipped · 1100,0 640x420 · empty',
        ' 3. Detail (f3) · slide 2 · in Architecture · 600,300 300x200 · 1 inside: “Retry policy” (t1)',
        'Not in a frame: “Legend” (t2)',
      ].join('\n'),
    );
  });

  it('caps the inside list at 15', () => {
    const s = store([frame('f', 'Big', 0, 0, 5000, 200), ...Array.from({ length: 20 }, (_, i) => box(`n${i}`, 10 + i * 60, 50))]);
    const line = text(s).split('\n')[1];
    expect(line).toContain('20 inside');
    expect(line).toContain('(n14)');
    expect(line).not.toContain('(n15)');
    expect(line).toContain('… (+5 more)');
  });

  it('a chess piece on a board inside a frame is not loose and not listed beside its board', () => {
    const s = store([], true);
    s.dispatch('chess.create', { x: 0, y: 0 });
    s.dispatch('core.add', { nodes: [frame('f', 'Game', -1000, -1000, 5000, 3000)] });
    const v = framesOf(s.doc);
    expect(v.loose).toEqual([]);
    expect(v.frames[0].inside).toHaveLength(1);
  });

  it('portals: a line under their frame; outside frames in their own line', () => {
    const portal = (id: string, x: number, y: number): CanvasNode => ({ id, type: 'file', file: 'sprint-12.canvas', label: 'Sprint 12', x, y, width: 100, height: 100, 'x-portal': { room: 'sprint-12' } });
    const s = store([frame('f', 'Room', 0, 0, 500, 500), portal('p1', 100, 100), portal('p2', 2000, 0)]);
    const t = text(s);
    expect(t).toContain('      portal “Sprint 12” (p1) → room sprint-12');
    expect(t).toContain('Portals outside frames: “Sprint 12” (p2) → room sprint-12');
    expect(text(store([frame('f', 'Plain', 0, 0, 500, 500)]))).not.toContain('portal');
  });

  it('says how to start on an empty canvas', () => {
    expect(text(store([box('a', 0, 0)]))).toMatch(/^No frames yet\. frames\.create \{around/);
  });
});
