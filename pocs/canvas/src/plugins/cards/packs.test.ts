import { describe, expect, it } from 'vitest';
import { Store, parse, serialize } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerCardsLogic } from './index';
import { FIELD, PACK, cardNode, card, cardsIn, groupNode, standardDeck } from './deck';
import { getPack, isPackFace, packFaces, packLabel, registerPack } from './packs';
import { cardHtml } from './render';

registerPack({
  id: 'test-runes',
  name: 'Runes',
  cards: ['fe', 'ur', 'thurs'].map((f) => ({ face: f, label: `Rune ${f}` })),
  face: (f) => `<div class="pc-card rune">${f}</div>`,
  back: '<div class="pc-card rune-back"></div>',
});

describe('pack registry', () => {
  it('standard-52 is a registered pack: 52 faces in suit-then-rank order, readable labels', () => {
    const p = getPack(PACK)!;
    expect(p.cards).toHaveLength(52);
    expect(packFaces(PACK).slice().sort()).toEqual(standardDeck().sort());
    expect(packFaces(PACK).slice(0, 2)).toEqual(['AS', '2S']);
    expect(packLabel(PACK, 'TH')).toBe('10♥');
    expect(cardHtml({ face: 'TH', faceUp: true })).toContain('pc-face');
    expect(cardHtml({ face: 'TH', faceUp: false })).toContain('pc-back');
  });

  it('a registered pack renders through its own face/back and labels its cards', () => {
    expect(cardHtml({ face: 'ur', faceUp: true, pack: 'test-runes' })).toContain('rune">ur');
    expect(cardHtml({ face: 'ur', faceUp: false, pack: 'test-runes' })).toContain('rune-back');
    expect(cardNode('c', 0, 0, { face: 'ur', faceUp: true }, 1, 'test-runes').text).toBe('Rune ur');
    expect(isPackFace('test-runes', 'ur')).toBe(true);
    expect(isPackFace('test-runes', 'AS')).toBe(false);
    expect(isPackFace('not-loaded', 'whatever')).toBe(true); // unknown packs keep their data
  });

  it('cards of another pack survive a JSON Canvas round trip and sort in pack order', () => {
    const s = new Store();
    registerCoreCommands(s);
    registerCardsLogic(s);
    s.load({
      nodes: [
        groupNode('g', 0, 0, 1, { layout: 'row', pack: 'test-runes' }),
        cardNode('a', 0, 0, { face: 'thurs', faceUp: true, stack: 'g', order: 1 }, 2, 'test-runes'),
        cardNode('b', 0, 0, { face: 'fe', faceUp: true, stack: 'g', order: 2 }, 3, 'test-runes'),
        cardNode('x', 0, 0, { face: 'bogus', faceUp: true }, 4, 'test-runes'),
      ],
      edges: [],
    });
    expect(s.doc.get('x')![FIELD]).toBeUndefined(); // not a face of that pack
    s.dispatch('cards.sort', { id: 'g' });
    expect(cardsIn(s.doc, 'g').map((c) => card(c).face)).toEqual(['fe', 'thurs']);
    const file = parse(serialize(s.exportDoc()));
    expect(file.nodes.find((n) => n.id === 'a')!.text).toBe('Rune thurs');
    const t = new Store();
    registerCoreCommands(t);
    registerCardsLogic(t);
    t.load(file);
    expect(cardsIn(t.doc, 'g').map((c) => card(c).face)).toEqual(['fe', 'thurs']);
  });
});

describe('Add menu: a whole pack', () => {
  const s0 = () => {
    const s = new Store();
    registerCoreCommands(s);
    registerCardsLogic(s);
    return s;
  };
  it('adds the home deck as a face-up 13 x 4 grid in pack order, centered; gather and reset work', () => {
    const s = s0();
    const home = s.dispatch('cards.addPack', { pack: PACK, x: 0, y: 0 }).select![0];
    const d = s.doc.get(home)!;
    expect(d['x-cards']).toMatchObject({ home: true, layout: 'grid', cols: 13 });
    const cards = cardsIn(s.doc, home);
    expect(cards.map((c) => card(c).face)).toEqual(packFaces(PACK));
    expect(cards.every((c) => card(c).faceUp && s.doc.isVisible(c.id))).toBe(true);
    expect(Math.abs(d.x + d.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(d.y + d.height / 2)).toBeLessThanOrEqual(1);
    expect(new Set(cards.map((c) => c.y)).size).toBe(4); // a suit per row
    expect(cards[13].x).toBe(cards[0].x);
    // take two out, gather all brings them back
    s.dispatch('cards.pullOut', { id: cards[0].id, x: 3000, y: 0 });
    s.dispatch('cards.pullOut', { id: cards[1].id, x: 3200, y: 0 });
    s.dispatch('cards.recall', { id: home });
    expect(cardsIn(s.doc, home)).toHaveLength(52);
    s.dispatch('core.reset', {});
    expect(s.doc.get(home)!['x-cards']).not.toHaveProperty('layout');
    expect(cardsIn(s.doc, home).every((c) => !card(c).faceUp)).toBe(true);
  });
});
