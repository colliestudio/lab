import { describe, expect, it } from 'vitest';
import { Store, parse, serialize } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerCardsLogic } from './index';
import { card, cardNode, cardsIn, groupNode } from './deck';
import { COLUMN_STEP, PAD } from './layout';

function store() {
  const s = new Store();
  registerCoreCommands(s);
  registerCardsLogic(s);
  return s;
}
const loose = (id: string, face: string, x = 500) => cardNode(id, x, 0, { face, faceUp: true }, 10);

describe('table spots (generic)', () => {
  const area = (layout: 'column' | 'column-up' = 'column') => groupNode('f', 0, 0, 1, { layout, spot: true, slots: 3, max: 4, label: 'Flag 1 · A' });

  it('a column fills its next free slot, cascading; sized for max; a 5th card is refused', () => {
    const s = store();
    s.load({ nodes: [area(), ...['AS', '2S', '3S', '4S', '5S'].map((f, i) => loose(`c${i}`, f, 500 + i * 130))], edges: [] });
    expect(s.doc.get('f')!.height).toBe(2 * PAD + 168 + 3 * COLUMN_STEP);
    for (let i = 0; i < 4; i++) s.dispatch('cards.drop', { target: 'f', ids: [`c${i}`], at: { x: 10, y: 10 } });
    expect(cardsIn(s.doc, 'f').map((c) => card(c).face)).toEqual(['AS', '2S', '3S', '4S']);
    expect(cardsIn(s.doc, 'f').map((c) => c.y)).toEqual([0, 1, 2, 3].map((i) => PAD + i * COLUMN_STEP));
    s.dispatch('cards.drop', { target: 'f', ids: ['c4'] });
    expect(cardsIn(s.doc, 'f')).toHaveLength(4);
    expect(s.doc.parentOf('c4')).toBeUndefined();
  });

  it('column-up cascades upward from the bottom slot', () => {
    const s = store();
    s.load({ nodes: [area('column-up'), loose('a', 'AS'), loose('b', '2S', 700)], edges: [] });
    s.dispatch('cards.drop', { target: 'f', ids: ['a'] });
    s.dispatch('cards.drop', { target: 'f', ids: ['b'] });
    const h = s.doc.get('f')!.height;
    expect(cardsIn(s.doc, 'f').map((c) => c.y)).toEqual([h - PAD - 168, h - PAD - 168 - COLUMN_STEP]);
  });

  it('stays when down to one card or empty, survives Reset and a file round trip', () => {
    const s = store();
    s.load({ nodes: [area(), loose('a', 'AS'), loose('b', '2S', 700)], edges: [] });
    s.dispatch('cards.drop', { target: 'f', ids: ['a'] });
    s.dispatch('cards.drop', { target: 'f', ids: ['b'] });
    s.dispatch('cards.pullOut', { id: 'a' });
    s.dispatch('cards.pullOut', { id: 'b' });
    expect(s.doc.get('f')).toBeDefined();
    s.dispatch('cards.putOnTable', { id: 'f' });
    s.dispatch('core.reset', {});
    expect(s.doc.get('f')).toBeDefined();
    const t = store();
    t.load(parse(serialize(s.exportDoc())));
    const f = t.doc.get('f')!;
    expect(f['x-cards']).toMatchObject({ spot: true, slots: 3, max: 4, layout: 'column' });
    expect(f.label).toBe('Flag 1 · A');
  });
});
