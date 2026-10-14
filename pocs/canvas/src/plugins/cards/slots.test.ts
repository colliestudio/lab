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

describe('fixed areas and facing on entry (generic)', () => {
  it('a spread container with an area is at least that big; its cards start at its top-left', () => {
    const s = store();
    s.load({ nodes: [groupNode('z', 0, 0, 1, { layout: 'row', spot: true, area: { w: 900, h: 300 } }), loose('a', 'AS')], edges: [] });
    expect([s.doc.get('z')!.width, s.doc.get('z')!.height]).toEqual([900, 300]);
    s.dispatch('cards.drop', { target: 'z', ids: ['a'] });
    expect([s.doc.get('a')!.x, s.doc.get('a')!.y]).toEqual([PAD, PAD]);
  });

  it('a pile with an area: the area is its box, the pile sits in the middle; drawing takes from there', () => {
    const s = store();
    s.load({ nodes: [groupNode('p', 0, 0, 1, { layout: 'stack', spot: true, area: { w: 400, h: 300 } }), loose('a', 'AS'), loose('b', '2S', 700)], edges: [] });
    expect([s.doc.get('p')!.width, s.doc.get('p')!.height]).toEqual([400, 300]);
    s.dispatch('cards.drop', { target: 'p', ids: ['a'] });
    s.dispatch('cards.drop', { target: 'p', ids: ['b'] });
    expect(cardsIn(s.doc, 'p')).toHaveLength(2);
    // switching layout keeps the area where it is
    s.dispatch('cards.setLayout', { id: 'p', layout: 'fan' });
    expect([s.doc.get('p')!.x, s.doc.get('p')!.y]).toEqual([0, 0]);
    s.dispatch('cards.setLayout', { id: 'p', layout: 'stack' });
    const r = s.dispatch('cards.draw', { id: 'p' });
    expect(s.doc.get(r.select![0])!.x).toBe((400 - 120) / 2 + 120 + 24);
  });

  it('facing on entry turns cards that come in (drop, gather); a hand ignores it', () => {
    const s = store();
    const down = (id: string, x: number) => cardNode(id, x, 0, { face: 'AS', faceUp: false }, 10);
    s.load({ nodes: [groupNode('z', 0, 0, 1, { layout: 'row', spot: true, enter: 'up' }), groupNode('d', 0, 400, 1, { layout: 'stack', spot: true, enter: 'down' }), down('a', 500), loose('b', 'KS', 700)], edges: [] });
    s.dispatch('cards.drop', { target: 'z', ids: ['a'] });
    expect(card(s.doc.get('a')!).faceUp).toBe(true);
    s.dispatch('cards.drop', { target: 'd', ids: ['b'] });
    expect(card(s.doc.get('b')!).faceUp).toBe(false);
  });

  it('showdown keeps a seat (a private spot), empties it', () => {
    const s = store();
    s.load({ nodes: [groupNode('h', 0, 0, 1, { layout: 'fan', spot: true, owner: 'me', label: 'Seat' }), loose('a', 'AS')], edges: [] });
    s.dispatch('cards.drop', { target: 'h', ids: ['a'] });
    s.dispatch('cards.showdown', {});
    expect(s.doc.get('h')).toBeDefined();
    expect(cardsIn(s.doc, 'h')).toHaveLength(0);
  });

  it('area and facing survive a file round trip', () => {
    const s = store();
    s.load({ nodes: [groupNode('z', 0, 0, 1, { layout: 'row', spot: true, area: { w: 500, h: 200 }, enter: 'down' })], edges: [] });
    const t = store();
    t.load(parse(serialize(s.exportDoc())));
    expect(t.doc.get('z')!['x-cards']).toMatchObject({ area: { w: 500, h: 200 }, enter: 'down' });
  });
});
