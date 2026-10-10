import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, parse, serialize, type CanvasNode, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerCardsLogic } from './index';
import { DROP_FAN, DROP_STACK, dropMode, freeSpot } from './commands';
import { FIELD, card, cardNode, cardsIn, deckNode, hiddenFrom, isCard, isDeck, isHomeDeck, layoutOf, standardDeck } from './deck';
import { PAD, slots } from './layout';

function ctx(prefix = 'id', seed = 1): CommandCtx {
  let n = 0;
  let s = seed;
  return { newId: () => `${prefix}${++n}`, random: () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646 };
}
function store(c = ctx(), ydoc?: Y.Doc) {
  const s = new Store({ ctx: c, ydoc });
  registerCoreCommands(s);
  registerCardsLogic(s);
  return s;
}
/** A deck `d` at (0,0) with n cards (AS..), face down, plus `extra` nodes. */
function withDeck(n: number, ...extra: CanvasNode[]) {
  const s = store();
  const faces = standardDeck().slice(0, n);
  s.load({
    nodes: [deckNode('d', 0, 0, 1), ...faces.map((face, i) => cardNode(`c${i}`, 0, 0, { face, faceUp: false, stack: 'd', order: i + 1 }, 2 + i)), ...extra],
    edges: [],
  });
  return s;
}
const faces = (s: Store, deck = 'd') => cardsIn(s.doc, deck).map((c) => card(c).face);
const allFaces = (s: Store) => s.doc.nodes.filter(isCard).map((c) => card(c).face).sort();
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};

describe('cards commands', () => {
  it('setup makes 52 card nodes, a deck holding 36, all with readable labels', () => {
    const s = store();
    s.dispatch('cards.setup', {});
    expect(allFaces(s)).toEqual(standardDeck().sort());
    const deck = s.doc.nodes.find(isDeck)!;
    expect(cardsIn(s.doc, deck.id)).toHaveLength(36);
    expect(s.doc.visible.filter(isCard)).toHaveLength(16); // cards in the deck aren't on the table
    const c = s.doc.visible.find(isCard)!;
    expect(c.type).toBe('text');
    expect(c.text).toMatch(/^(10|[2-9AJQK])[♠♥♦♣]$/);
  });

  it('flip toggles a card and turns a deck over', () => {
    const s = withDeck(3, cardNode('x', 300, 0, { face: 'KH', faceUp: false }, 10));
    s.dispatch('cards.flip', { ids: ['x', 'd'] });
    expect(card(s.doc.get('x')!).faceUp).toBe(true);
    expect(faces(s)).toEqual(['3S', '2S', 'AS']);
    expect(cardsIn(s.doc, 'd').every((c) => card(c).faceUp)).toBe(true);
  });

  it('shuffle permutes a deck deterministically for a given rng', () => {
    const a = withDeck(13);
    const b = withDeck(13);
    a.dispatch('cards.shuffle', { ids: ['d'] });
    b.dispatch('cards.shuffle', { ids: ['d'] });
    expect(faces(a)).toEqual(faces(b));
    expect(faces(a)).not.toEqual(standardDeck().slice(0, 13));
    expect([...faces(a)].sort()).toEqual(standardDeck().slice(0, 13).sort());
  });

  it('draw takes the top card into a free slot; an emptied home deck stays as a slot', () => {
    const s = withDeck(2);
    const r = s.dispatch('cards.draw', { id: 'd', faceUp: true, select: 'deck' });
    expect(r.select).toEqual(['d']);
    const c1 = s.doc.get('c1')!;
    expect(s.doc.parentOf('c1')).toBeUndefined();
    expect(card(c1)).toMatchObject({ face: '2S', faceUp: true });
    expect(c1.x).toBeGreaterThan(0);
    s.dispatch('cards.draw', { id: 'd' });
    expect(cardsIn(s.doc, 'd')).toHaveLength(0);
    expect(s.doc.get('d')).toBeDefined(); // still home to its cards
    expect(s.dispatch('cards.draw', { id: 'd' }).changes).toEqual([]); // empty: nothing to draw
    const xs = s.doc.visible.filter((n) => n.id !== 'd').map((n) => n.x);
    expect(new Set(xs).size).toBe(2); // second draw went to the next slot
    expect(s.dispatch('cards.draw', { id: 'c0' }).changes).toEqual([]); // a card isn't a deck
  });

  it('deal puts the top N cards in a fanned row beside the deck, top card leftmost', () => {
    const s = withDeck(6);
    const r = s.dispatch('cards.deal', { id: 'd', count: 3, faceUp: true });
    expect(r.select).toEqual(['d']);
    expect(faces(s)).toEqual(['AS', '2S', '3S']);
    const dealt = s.doc.visible.filter((n) => n.id !== 'd').sort((a, b) => a.x - b.x);
    expect(dealt.map((c) => card(c).face)).toEqual(['6S', '5S', '4S']);
    expect(dealt.every((c) => card(c).faceUp)).toBe(true);
    expect(dealt[0].x).toBeGreaterThanOrEqual(120);
    expect(dealt[1].x - dealt[0].x).toBe(30);
    // dealing again finds free space instead of covering the first row
    s.dispatch('cards.deal', { id: 'd', count: 2, faceUp: false });
    const second = s.doc.visible.filter((n) => n.id !== 'd' && !card(n).faceUp);
    expect(second).toHaveLength(2);
    expect(Math.min(...second.map((c) => c.x))).toBeGreaterThan(dealt[2].x + 120 - 1);
  });

  it('deal more than the deck holds empties it; bad args are a no-op', () => {
    const s = withDeck(2);
    expect(s.dispatch('cards.deal', { id: 'd', count: 0 }).changes).toEqual([]);
    expect(s.dispatch('cards.deal', { id: 'd', count: 'x' }).changes).toEqual([]);
    const r = s.dispatch('cards.deal', { id: 'd', count: 9 });
    expect(cardsIn(s.doc, 'd')).toHaveLength(0);
    expect(r.select).toHaveLength(2);
  });

  it('drawing at the deck position (deck drag) keeps orientation; a non-home deck goes when empty', () => {
    const s = withDeck(1);
    const r = s.dispatch('cards.draw', { id: 'd', x: 0, y: 0 });
    expect(r.select).toEqual(['c0']);
    expect(card(s.doc.get('c0')!).faceUp).toBe(false);
    expect([s.doc.get('c0')!.x, s.doc.get('c0')!.y]).toEqual([0, 0]);
    expect(s.doc.get('d')).toBeDefined(); // home deck stays
    // a deck that is nobody's home disappears with its last card
    const t = store();
    t.load({ nodes: [deckNode('d', 0, 0, 1), deckNode('p', 300, 0, 2), cardNode('c', 300, 0, { face: 'AS', faceUp: false, stack: 'p', order: 1, home: 'd' }, 3)], edges: [] });
    t.dispatch('cards.draw', { id: 'p' });
    expect(t.doc.get('p')).toBeUndefined();
    expect(t.doc.get('d')).toBeDefined();
  });

  it('G with a deck in the selection puts the rest into it; without one, a fan group where the first card was', () => {
    const s = withDeck(2, cardNode('a', 10, 20, { face: 'KH', faceUp: true }, 50), cardNode('b', 50, 50, { face: 'QH', faceUp: false }, 51));
    const r = s.dispatch('cards.gather', { ids: ['b', 'd', 'a'] });
    expect(r.select).toEqual(['d']);
    expect(faces(s)).toEqual(['AS', '2S', 'QH', 'KH']);
    const t = withDeck(2, cardNode('a', 10, 20, { face: 'KH', faceUp: true }, 50), cardNode('b', 50, 50, { face: 'QH', faceUp: false }, 51));
    const g = t.dispatch('cards.gather', { ids: ['a', 'b'] }).select![0];
    expect(layoutOf(t.doc.get(g)!)).toBe('fan');
    expect(faces(t, g)).toEqual(['KH', 'QH']);
    // the first card stays where it was; every card is visible, with its own facing
    expect([t.doc.get('a')!.x, t.doc.get('a')!.y]).toEqual([10, 20]);
    expect(t.doc.isVisible('a') && t.doc.isVisible('b')).toBe(true);
    expect(card(t.doc.get('a')!).faceUp && !card(t.doc.get('b')!).faceUp).toBe(true);
  });

  it('drop onto a deck puts cards on top and keeps the deck id; drop needs card targets', () => {
    const s = withDeck(2, cardNode('a', 300, 0, { face: 'KH', faceUp: true }, 50), { id: 't', type: 'text', x: 0, y: 0, width: 9, height: 9, text: 'note' });
    expect(s.dispatch('cards.drop', { target: 't', ids: ['a'] }).changes).toEqual([]);
    s.dispatch('cards.drop', { target: 'd', ids: ['a'] });
    expect(faces(s)).toEqual(['AS', '2S', 'KH']);
  });

  it('spread lays a deck out as cards', () => {
    const s = withDeck(4);
    const r = s.dispatch('cards.spread', { id: 'd' });
    expect(cardsIn(s.doc, 'd')).toHaveLength(0);
    expect(r.select).toHaveLength(4);
    expect(s.doc.visible.filter((n) => n.id !== 'd').map((n) => n.x)).toEqual([144, 174, 204, 234]);
  });

  it('delete removes a deck with its cards; undo brings them back', () => {
    const s = withDeck(3);
    s.dispatch('core.delete', { ids: ['d'] });
    expect(s.doc.nodes).toHaveLength(0);
    s.undo();
    expect(faces(s)).toEqual(['AS', '2S', '3S']);
  });
});

describe('home decks, gather all, uniform facing', () => {
  const homeOf = (s: Store, id: string) => card(s.doc.get(id)!).home;

  it('setup gives every card the deck as home', () => {
    const s = store();
    s.dispatch('cards.setup', {});
    const deck = s.doc.nodes.find(isDeck)!.id;
    expect(s.doc.nodes.filter(isCard).every((c) => card(c).home === deck)).toBe(true);
  });

  it('recall pulls loose cards and cards from another deck back, face down, one undo step', () => {
    const s = withDeck(6);
    s.dispatch('cards.deal', { id: 'd', count: 4 }); // 6S..3S out face up
    s.dispatch('cards.gather', { ids: ['c5', 'c4'] }); // two of them into a new pile
    const pile = s.doc.parentOf('c5')!;
    expect(homeOf(s, 'c5')).toBe('d'); // gathering elsewhere keeps the home
    const r = s.dispatch('cards.recall', { id: 'd' });
    expect(r.select).toEqual(['d']);
    expect(cardsIn(s.doc, 'd')).toHaveLength(6);
    expect(cardsIn(s.doc, 'd').every((c) => !card(c).faceUp)).toBe(true);
    expect(s.doc.get(pile)).toBeUndefined(); // emptied pile (nobody's home) is gone
    expect(s.doc.visible.map((n) => n.id)).toEqual(['d']);
    s.undo();
    expect(cardsIn(s.doc, 'd')).toHaveLength(2);
    expect(s.doc.get(pile)).toBeDefined();
  });

  it('every card keeps its own facing in decks and piles (Alex: draw 1, draw 2, flip 2, gather, spread)', () => {
    const s = withDeck(5);
    const c1 = s.dispatch('cards.draw', { id: 'd', x: 400, y: 0 }).select![0];
    const c2 = s.dispatch('cards.draw', { id: 'd', x: 600, y: 0 }).select![0];
    s.dispatch('cards.flip', { ids: [c2] });
    s.dispatch('cards.recall', { id: 'd' });
    expect(card(s.doc.get(c2)!).faceUp).toBe(true);
    expect(card(s.doc.get(c1)!).faceUp).toBe(false);
    s.dispatch('cards.spread', { id: 'd' });
    expect(card(s.doc.get(c2)!).faceUp).toBe(true);
    // G gather and drops keep facing too; only an explicit faceUp turns them all
    const r = s.dispatch('cards.gather', { ids: [c1, c2] });
    expect(cardsIn(s.doc, r.select![0]).map((c) => card(c).faceUp).sort()).toEqual([false, true]);
    s.dispatch('cards.gather', { ids: [r.select![0]], faceUp: false });
    s.dispatch('cards.face', { ids: [r.select![0]], faceUp: false });
    expect(cardsIn(s.doc, r.select![0]).every((c) => !card(c).faceUp)).toBe(true);
  });

});

describe('home deck vs piles', () => {
  const homeOf = (s: Store, id: string) => card(s.doc.get(id)!).home;

  it('piles never become homes; gathering keeps homes; an emptied pile disappears', () => {
    const s = withDeck(4);
    expect(isHomeDeck(s.doc.get('d'))).toBe(true); // migration made the only stack the home
    s.dispatch('cards.deal', { id: 'd', count: 3 });
    const r = s.dispatch('cards.drop', { target: 'c3', ids: ['c2'] });
    const pile = r.select![0];
    expect(isHomeDeck(s.doc.get(pile))).toBe(false);
    expect(homeOf(s, 'c2')).toBe('d');
    expect(homeOf(s, 'c3')).toBe('d');
    s.dispatch('cards.draw', { id: pile });
    s.dispatch('cards.draw', { id: pile });
    expect(s.doc.get(pile)).toBeUndefined();
    s.dispatch('cards.deal', { id: 'd', count: 1 });
    expect(s.doc.get('d')).toBeDefined(); // home deck stays as the empty slot
    expect(s.dispatch('cards.recall', { id: pile }).changes).toEqual([]); // piles can't be recalled to
  });

  it("repairs a table like Alex's: one home, piles unflagged, empty piles gone, recall gets all 52", () => {
    // what the old model could produce: several stacks that are homes, empty dashed ones, split homes
    const s = store();
    s.dispatch('cards.setup', {});
    const initial = s.doc.nodes.find(isDeck)!.id;
    const exp = JSON.parse(serialize(s.exportDoc()));
    const faces52 = exp.nodes.filter((n: any) => n[FIELD]?.face);
    const mk = (id: string, x: number) => ({ id, type: 'text', x, y: 400, width: 120, height: 168, [FIELD]: { pack: 'standard-52', deck: true } });
    const nodes: any[] = [{ ...exp.nodes.find((n: any) => n.id === initial), [FIELD]: { pack: 'standard-52', deck: true } }];
    nodes.push(mk('e1', 600), mk('e2', 800), mk('e3', 1000), mk('p2', 1200), mk('p11', 1400));
    faces52.forEach((c: any, i: number) => {
      const f = { ...c[FIELD] };
      delete f.stack;
      delete f.order;
      if (i < 2) Object.assign(f, { stack: 'p2', order: i, home: 'p2' });
      else if (i < 13) Object.assign(f, { stack: 'p11', order: i, home: i < 8 ? 'p11' : 'e1', faceUp: i % 2 === 0 });
      else if (i < 20) Object.assign(f, { stack: initial, order: i, home: initial });
      else Object.assign(f, { faceUp: i % 2 === 0, home: i % 3 ? initial : 'e2' });
      nodes.push({ ...c, x: 100 + i * 10, [FIELD]: f });
    });
    const t = store(ctx('t'));
    t.load(parse(JSON.stringify({ nodes, edges: [] })));
    const stacks = t.doc.nodes.filter(isDeck);
    const homes = stacks.filter(isHomeDeck);
    expect(homes.map((h) => h.id)).toEqual([initial]); // most cards claimed it
    expect(stacks.map((st) => st.id).sort()).toEqual([initial, 'p11', 'p2'].sort()); // empty e1-e3 deleted
    expect(t.doc.nodes.filter(isCard).every((c) => card(c).home === initial)).toBe(true);
    // idempotent
    const before = JSON.stringify(t.ydoc.getMap('nodes').toJSON());
    t.migrate();
    expect(JSON.stringify(t.ydoc.getMap('nodes').toJSON())).toBe(before);
    // one gather brings everything back face down; the piles go
    t.dispatch('cards.recall', { id: initial });
    expect(cardsIn(t.doc, initial)).toHaveLength(52);
    expect(t.doc.visible.map((n) => n.id)).toEqual([initial]);
  });

  it('repair without any stack creates a home deck left of the cards; with only loose legacy cards', () => {
    const t = store();
    t.load({
      nodes: [
        { id: 'a', type: 'text', x: 300, y: 50, width: 120, height: 168, [FIELD]: { pack: 'standard-52', face: 'AS', faceUp: true } },
        { id: 'b', type: 'text', x: 500, y: 50, width: 120, height: 168, [FIELD]: { pack: 'standard-52', face: 'KS', faceUp: true } },
      ],
      edges: [],
    });
    const home = t.doc.nodes.find(isHomeDeck)!;
    expect(home.x).toBeLessThan(300);
    expect(homeOf(t, 'a')).toBe(home.id);
    t.dispatch('cards.recall', { id: home.id });
    expect(cardsIn(t.doc, home.id)).toHaveLength(2);
  });

  it('a stage-1 deck (cards inside the deck node) becomes the home on import', () => {
    const t = store();
    t.load(parse(JSON.stringify({ nodes: [{ id: 'old', type: 'text', x: 0, y: 0, width: 120, height: 168, [FIELD]: { stack: [{ face: 'AS' }, { face: 'KD' }] } }] })));
    expect(isHomeDeck(t.doc.get('old'))).toBe(true);
    expect(faces(t, 'old')).toEqual(['AS', 'KD']);
  });
});

describe('groups and hands', () => {
  const loose = (...faces: string[]) => faces.map((f, i) => cardNode(`l${i}`, 400 + i * 200, 400, { face: f, faceUp: i % 2 === 0 }, 100 + i));
  const order = (s: Store, box: string) => faces(s, box);

  it('layouts: fan overlaps with a slight arc, row and grid show every card, sizes follow the count', () => {
    const fan = slots('fan', 5);
    expect(fan.at[1].dx - fan.at[0].dx).toBeLessThan(120); // overlapping
    expect(fan.at[0].angle).toBeLessThan(0);
    expect(fan.at[4].angle).toBeGreaterThan(0);
    expect(fan.at[2].angle).toBeUndefined(); // middle card upright
    const row = slots('row', 3);
    expect(row.at.map((a) => a.dx)).toEqual([PAD, PAD + 130, PAD + 260]);
    const grid = slots('grid', 5);
    expect(new Set(grid.at.map((a) => a.dy)).size).toBe(2); // 3 + 2
    expect(slots('fan', 10).w).toBeGreaterThan(slots('fan', 3).w);
  });

  it('dropping a card on a loose card makes a fan group; every card shown in order at its slot', () => {
    const s = withDeck(1, ...loose('KH', 'QS', 'JD'));
    const g = s.dispatch('cards.drop', { target: 'l0', ids: ['l1'] }).select![0];
    expect(layoutOf(s.doc.get(g)!)).toBe('fan');
    const box = s.doc.get(g)!;
    expect(order(s, g)).toEqual(['KH', 'QS']);
    expect(s.doc.visible.map((n) => n.id)).toEqual(expect.arrayContaining([g, 'l0', 'l1']));
    expect(s.doc.get('l1')!.x).toBeGreaterThan(s.doc.get('l0')!.x);
    expect(box.width).toBe(slots('fan', 2).w);
    // facing kept per card
    expect(card(s.doc.get('l0')!).faceUp).toBe(true);
    expect(card(s.doc.get('l1')!).faceUp).toBe(false);
    // moving the group moves its cards (layout is derived, one node written)
    const r = s.dispatch('core.move', { ids: [g], dx: 100, dy: 0 });
    expect(r.changes).toHaveLength(2);
    expect(s.doc.get('l0')!.x).toBe(box.x + 100 + slots('fan', 2).at[0].dx);
  });

  it('drop onto a group inserts at the drop point; pull out; a group of one dissolves', () => {
    const s = withDeck(1, ...loose('KH', 'QS', 'JD'));
    const g = s.dispatch('cards.drop', { target: 'l0', ids: ['l1'] }).select![0];
    const box = s.doc.get(g)!;
    // drop JD near the left edge -> first
    s.dispatch('cards.drop', { target: g, ids: ['l2'], at: { x: box.x + PAD + 5, y: box.y + 50 } });
    expect(order(s, g)).toEqual(['JD', 'KH', 'QS']);
    // pull KH out where it is shown
    const shown = s.doc.get('l0')!;
    s.dispatch('cards.pullOut', { id: 'l0' });
    expect(s.doc.parentOf('l0')).toBeUndefined();
    expect([s.doc.get('l0')!.x, s.doc.get('l0')!.y]).toEqual([shown.x, shown.y]);
    expect(order(s, g)).toEqual(['JD', 'QS']);
    s.dispatch('cards.pullOut', { id: 'l2' });
    expect(s.doc.get(g)).toBeUndefined(); // one card left: just a card
    expect(s.doc.parentOf('l1')).toBeUndefined();
    expect(s.doc.isVisible('l1')).toBe(true);
  });

  it('setLayout, sort, ungroup; a group set to stack acts like a deck', () => {
    const s = withDeck(1, ...loose('KH', '2S', 'AS'));
    const g = s.dispatch('cards.gather', { ids: ['l0', 'l1', 'l2'] }).select![0];
    s.dispatch('cards.sort', { id: g });
    expect(order(s, g)).toEqual(['AS', '2S', 'KH']);
    s.dispatch('cards.setLayout', { id: g, layout: 'grid' });
    expect(layoutOf(s.doc.get(g)!)).toBe('grid');
    s.dispatch('cards.setLayout', { id: g, layout: 'stack' });
    expect(s.doc.isVisible('l0')).toBe(false); // hidden in the pile
    const drawn = s.dispatch('cards.draw', { id: g }).select![0];
    expect(card(s.doc.get(drawn)!).face).toBe('KH');
    s.dispatch('cards.setLayout', { id: g, layout: 'row' });
    const r = s.dispatch('cards.ungroup', { id: g });
    expect(s.doc.get(g)).toBeUndefined();
    expect(r.select).toHaveLength(2);
  });

  it('hands: owned groups, any number, persist when empty, reorder by dropping, others see backs', () => {
    const s = withDeck(1, ...loose('KH', 'QS', 'JD'));
    const h = s.dispatch('cards.newHand', { owner: 'alice', label: "Alice's hand", color: '#e6194b', x: 0, y: 600 }).select![0];
    const h2 = s.dispatch('cards.newHand', { owner: 'alice', x: 0, y: 600 }).select![0];
    expect(h2).not.toBe(h); // a new one each time…
    const [a1, a2] = [s.doc.get(h)!, s.doc.get(h2)!];
    expect(a2.x >= a1.x + a1.width || a2.x + a2.width <= a1.x || a2.y + a2.height <= a1.y).toBe(true); // …never on top of another
    s.dispatch('cards.drop', { target: h, ids: ['l0'] });
    s.dispatch('cards.drop', { target: h, ids: ['l1'] });
    s.dispatch('cards.drop', { target: h, ids: ['l2'] });
    expect(order(s, h)).toEqual(['KH', 'QS', 'JD']);
    // drag JD out and drop it back at the front
    s.dispatch('cards.pullOut', { id: 'l2' });
    const box = s.doc.get(h)!;
    s.dispatch('cards.drop', { target: 'l0', ids: ['l2'], at: { x: box.x + PAD + 2, y: box.y + 60 } });
    expect(order(s, h)).toEqual(['JD', 'KH', 'QS']);
    expect(hiddenFrom(s.doc, s.doc.get('l0')!, 'bob')).toBe(true);
    expect(hiddenFrom(s.doc, s.doc.get('l0')!, 'alice')).toBe(false);
    // emptied hand stays; can't become a pile
    for (const id of ['l0', 'l1', 'l2']) s.dispatch('cards.pullOut', { id });
    expect(s.doc.get(h)).toBeDefined();
    expect(s.dispatch('cards.setLayout', { id: h, layout: 'stack' }).changes).toEqual([]);
    s.dispatch('cards.handLabel', { owner: 'alice', label: "Ali's hand", color: '#3cb44b' });
    expect(s.doc.get(h)!.label).toBe("Ali's hand");
    // gather-all reaches into hands, the hand stays
    s.dispatch('cards.drop', { target: h, ids: ['l0'] });
    s.dispatch('cards.recall', { id: 'd' });
    expect(s.doc.get(h)).toBeDefined();
    expect(cardsIn(s.doc, h)).toHaveLength(0);
  });

  it('old piles (stacks without a layout) load unchanged, as stack groups that can be spread out', () => {
    const t = store();
    t.load({
      nodes: [
        deckNode('home', 0, 0, 1, undefined, true),
        deckNode('pile', 300, 0, 2),
        cardNode('a', 300, 0, { face: 'AS', faceUp: true, stack: 'pile', order: 1, home: 'home' }, 3),
        cardNode('b', 300, 0, { face: 'KS', faceUp: false, stack: 'pile', order: 2, home: 'home' }, 4),
      ],
      edges: [],
    });
    expect(layoutOf(t.doc.get('pile')!)).toBe('stack');
    expect(t.doc.isVisible('a')).toBe(false);
    t.dispatch('cards.setLayout', { id: 'pile', layout: 'fan' });
    expect(t.doc.isVisible('a') && t.doc.isVisible('b')).toBe(true);
  });

  it('export: a hand is a JSON Canvas group sized to its layout, cards at their slots; round-trips', () => {
    const s = withDeck(1, ...loose('KH', 'QS'));
    const h = s.dispatch('cards.newHand', { owner: 'alice', label: "Alice's hand", x: 0, y: 600 }).select![0];
    s.dispatch('cards.drop', { target: h, ids: ['l0', 'l1'] });
    const json = JSON.parse(serialize(s.exportDoc()));
    const g = json.nodes.find((n: any) => n.id === h);
    expect(g).toMatchObject({ type: 'group', label: "Alice's hand", owner: 'alice' });
    expect(g.width).toBe(slots('fan', 2, 3).w);
    const kh = json.nodes.find((n: any) => n.id === 'l0');
    expect(kh.x).toBe(s.doc.get('l0')!.x);
    expect(json.nodes.indexOf(kh)).toBeGreaterThan(json.nodes.indexOf(g)); // drawn above the group
    const t = store();
    t.load(parse(serialize(s.exportDoc())));
    expect(JSON.parse(serialize(t.exportDoc()))).toEqual(JSON.parse(serialize(s.exportDoc())));
    expect(faces(t, h)).toEqual(['KH', 'QS']);
  });

  it('two peers dropping into the same hand at once: both cards end up in it, same order everywhere', () => {
    const a = store(ctx('a'));
    a.load({ nodes: [deckNode('d', 0, 0, 1, undefined, true), ...loose('KH', 'QS', 'JD').map((c) => ({ ...c, [FIELD]: { ...(c[FIELD] as object), home: 'd' } }))], edges: [] });
    const h = a.dispatch('cards.newHand', { owner: 'alice', x: 0, y: 600 }).select![0];
    a.dispatch('cards.drop', { target: h, ids: ['l0'] });
    const b = store(ctx('b'));
    sync(a.ydoc, b.ydoc);
    a.dispatch('cards.drop', { target: h, ids: ['l1'] });
    b.dispatch('cards.drop', { target: h, ids: ['l2'] });
    b.dispatch('cards.pullOut', { id: 'l0' }); // and b takes one out meanwhile
    sync(a.ydoc, b.ydoc);
    expect(a.ydoc.getMap('nodes').toJSON()).toEqual(b.ydoc.getMap('nodes').toJSON());
    expect(faces(a, h).sort()).toEqual(['JD', 'QS']);
    expect(faces(a, h)).toEqual(faces(b, h));
    expect(a.doc.isVisible('l0') && !a.doc.parentOf('l0')).toBe(true);
  });
});

describe('drop modes, stack ⇄ fan, private groups', () => {
  const loose = (...faces: string[]) => faces.map((f, i) => cardNode(`l${i}`, 400 + i * 200, 400, { face: f, faceUp: true }, 100 + i));

  it('classifies drops: squarely on a loose card = stack, partly = fan, barely = nothing; containers = add', () => {
    const s = withDeck(3, ...loose('KH', 'QS'));
    const c = s.doc.get('l0')!;
    expect(dropMode(s.doc, c, 1)).toBe('stack');
    expect(dropMode(s.doc, c, DROP_STACK)).toBe('stack');
    expect(dropMode(s.doc, c, 0.6)).toBe('fan');
    expect(dropMode(s.doc, c, DROP_FAN)).toBe('fan');
    expect(dropMode(s.doc, c, 0.2)).toBeNull();
    expect(dropMode(s.doc, s.doc.get('d')!, 0.9)).toBe('add');
    expect(dropMode(s.doc, s.doc.get('d')!, 0.4)).toBe('add');
    const g = s.dispatch('cards.drop', { target: 'l0', ids: ['l1'], as: 'fan' }).select![0];
    expect(dropMode(s.doc, s.doc.get('l1')!, 0.5)).toBe('add'); // a card shown in a group = its group
    expect(layoutOf(s.doc.get(g)!)).toBe('fan');
  });

  it("drop as 'stack' makes a subdeck (cards hidden, acts like a deck)", () => {
    const s = withDeck(1, ...loose('KH', 'QS'));
    const g = s.dispatch('cards.drop', { target: 'l0', ids: ['l1'], as: 'stack' }).select![0];
    expect(layoutOf(s.doc.get(g)!)).toBe('stack');
    expect(s.doc.isVisible('l0') || s.doc.isVisible('l1')).toBe(false);
    expect([s.doc.get(g)!.x, s.doc.get(g)!.y]).toEqual([400, 400]);
    expect(card(s.doc.get(s.dispatch('cards.draw', { id: g }).select![0])!).face).toBe('QS');
  });

  it('toggleStack (L) converts subdeck ⇄ fan group in one step; private groups stay spread', () => {
    const s = withDeck(1, ...loose('KH', 'QS', 'JD'));
    const g = s.dispatch('cards.drop', { target: 'l0', ids: ['l1', 'l2'], as: 'stack' }).select![0];
    s.dispatch('cards.toggleStack', { id: g });
    expect(layoutOf(s.doc.get(g)!)).toBe('fan');
    expect(['l0', 'l1', 'l2'].every((id) => s.doc.isVisible(id))).toBe(true);
    s.dispatch('cards.toggleStack', { id: g });
    expect(layoutOf(s.doc.get(g)!)).toBe('stack');
    s.undo();
    expect(layoutOf(s.doc.get(g)!)).toBe('fan'); // one undo step per conversion
    s.dispatch('cards.own', { id: g, owner: 'alice', label: "Alice's hand" });
    expect(s.dispatch('cards.toggleStack', { id: g }).changes).toEqual([]);
  });

  it('make mine / make public: owner drives who sees backs; owning a subdeck spreads it', () => {
    const s = withDeck(1, ...loose('KH', 'QS'));
    const g = s.dispatch('cards.drop', { target: 'l0', ids: ['l1'], as: 'stack' }).select![0];
    s.dispatch('cards.own', { id: g, owner: 'alice', label: "Alice's hand", color: '#3cb44b' });
    const box = s.doc.get(g)!;
    expect(box.owner).toBe('alice');
    expect(layoutOf(box)).toBe('fan');
    expect(hiddenFrom(s.doc, s.doc.get('l0')!, 'bob')).toBe(true);
    expect(hiddenFrom(s.doc, s.doc.get('l0')!, 'alice')).toBe(false);
    s.dispatch('cards.own', { id: g, owner: null });
    expect(s.doc.get(g)!.owner).toBeUndefined();
    expect(hiddenFrom(s.doc, s.doc.get('l0')!, 'bob')).toBe(false);
    expect(s.dispatch('cards.own', { id: 'd', owner: 'alice' }).changes).toEqual([]); // not the home deck
  });

  it('migrates stage-2 hands (hand: true) to owned groups', () => {
    const t = store();
    t.load({
      nodes: [
        deckNode('d', 0, 0, 1, undefined, true),
        { id: 'h', type: 'text', x: 0, y: 500, width: 120, height: 168, z: 2, owner: 'alice', label: "Alice's hand", [FIELD]: { pack: 'standard-52', deck: true, layout: 'fan', hand: true } },
        cardNode('c', 0, 0, { face: 'AS', faceUp: true, stack: 'h', order: 1, home: 'd' }, 3),
      ],
      edges: [],
    });
    expect((t.doc.get('h')![FIELD] as any).hand).toBeUndefined();
    expect(t.doc.get('h')!.owner).toBe('alice');
    expect(hiddenFrom(t.doc, t.doc.get('c')!, 'bob')).toBe(true);
  });

  it('freeSpot slides a box off occupied space', () => {
    const s = withDeck(1, cardNode('x', 0, 0, { face: 'KH', faceUp: true }, 5));
    const p = freeSpot(s.doc, 0, 0, 200, 200);
    const occupied = s.doc.visible.filter((n) => !s.doc.parentOf(n.id));
    expect(occupied.every((n) => n.x >= p.x + 200 || n.x + n.width <= p.x || n.y >= p.y + 200 || n.y + n.height <= p.y)).toBe(true);
  });
});

describe('JSON Canvas', () => {
  it('a set-up table survives export → import, cards in decks exported at the deck', () => {
    const s = store();
    s.dispatch('cards.setup', { x: 100, y: 50 });
    const text = serialize(s.exportDoc());
    const json = JSON.parse(text);
    expect(json.nodes).toHaveLength(53);
    const deck = json.nodes.find((n: any) => n[FIELD].deck);
    expect(deck.type).toBe('group');
    expect(deck.label).toBe('Deck: 36 cards');
    const inDeck = json.nodes.filter((n: any) => n[FIELD].stack === deck.id);
    expect(inDeck.every((n: any) => n.x === 100 && n.y === 50)).toBe(true);
    const t = store();
    t.load(parse(text));
    expect(serialize(t.exportDoc())).toBe(text);
  });

  it('repairs bad card data on import', () => {
    const t = store();
    t.load(
      parse(
        JSON.stringify({
          nodes: [
            { id: 'empty', type: 'text', x: 0, y: 0, width: 1, height: 1, [FIELD]: { deck: true } },
            { id: 'old', type: 'text', x: 0, y: 0, width: 1, height: 1, [FIELD]: { stack: [] } },
            { id: 'old2', type: 'text', x: 0, y: 0, width: 1, height: 1, [FIELD]: { stack: [{ face: 'AS', faceUp: true }, { face: 'ZZ' }, { face: 'KD' }] } },
            { id: 'bad', type: 'text', x: 0, y: 0, width: 1, height: 1, [FIELD]: { face: 'nope' } },
            { id: 'junk', type: 'text', x: 0, y: 0, width: 1, height: 1, [FIELD]: 'x' },
            { id: 'orphan', type: 'text', x: 0, y: 0, width: 1, height: 1, [FIELD]: { face: 'QS', stack: 'gone' } },
          ],
        }),
      ),
    );
    const ids = t.doc.visible.map((n) => n.id).sort();
    expect(ids).toEqual(['bad', 'junk', 'old2', 'orphan']);
    expect(t.doc.get('bad')![FIELD]).toBeUndefined();
    expect(faces(t, 'old2')).toEqual(['AS', 'KD']);
    expect(card(t.doc.get('orphan')!).stack).toBeUndefined();
  });
});

describe('concurrent edits (two Y.Docs)', () => {
  function pair() {
    const a = store(ctx('a'));
    a.dispatch('cards.setup', {});
    const b = store(ctx('b'));
    sync(a.ydoc, b.ydoc);
    return { a, b, deck: a.doc.nodes.find(isDeck)!.id };
  }

  it('two peers drawing at once never duplicate a card', () => {
    const { a, b, deck } = pair();
    a.dispatch('cards.draw', { id: deck, faceUp: true });
    a.dispatch('cards.draw', { id: deck, faceUp: true });
    b.dispatch('cards.draw', { id: deck, faceUp: false });
    sync(a.ydoc, b.ydoc);
    expect(a.ydoc.getMap('nodes').toJSON()).toEqual(b.ydoc.getMap('nodes').toJSON());
    expect(allFaces(a)).toEqual(standardDeck().sort()); // still exactly 52, no dupes
    // b drew the same top card a drew first: 2 distinct cards left the deck, not 3
    expect(cardsIn(a.doc, deck)).toHaveLength(34);
  });

  it('flip on one peer and move on the other both survive', () => {
    const { a, b } = pair();
    const id = a.doc.visible.find((n) => isCard(n) && card(n).face === 'AH')!.id;
    a.dispatch('cards.flip', { ids: [id] });
    b.dispatch('core.move', { ids: [id], dx: 40, dy: 15 });
    sync(a.ydoc, b.ydoc);
    for (const s of [a, b]) {
      const n = s.doc.get(id)!;
      expect(card(n).faceUp).toBe(true);
      expect([n.x, n.y]).toEqual([340 + 40, 228 + 15]);
    }
  });

  it('gather on one peer and draw on the other converge without loss', () => {
    const { a, b, deck } = pair();
    const loose = a.doc.visible.filter((n) => isCard(n)).slice(0, 3).map((n) => n.id);
    a.dispatch('cards.drop', { target: deck, ids: loose });
    b.dispatch('cards.draw', { id: deck });
    sync(a.ydoc, b.ydoc);
    expect(a.ydoc.getMap('nodes').toJSON()).toEqual(b.ydoc.getMap('nodes').toJSON());
    expect(allFaces(a)).toEqual(standardDeck().sort());
  });

  it('recall on one peer and draws on the other converge without duplicates', () => {
    const { a, b, deck } = pair();
    b.dispatch('cards.deal', { id: deck, count: 3 });
    sync(a.ydoc, b.ydoc);
    a.dispatch('cards.recall', { id: deck });
    b.dispatch('cards.draw', { id: deck, faceUp: true });
    b.dispatch('cards.deal', { id: deck, count: 2 });
    sync(a.ydoc, b.ydoc);
    expect(a.ydoc.getMap('nodes').toJSON()).toEqual(b.ydoc.getMap('nodes').toJSON());
    expect(allFaces(a)).toEqual(standardDeck().sort());
    // every card is either in the deck or on the table, exactly once
    const inDeck = cardsIn(a.doc, deck).length;
    const loose = a.doc.visible.filter(isCard).length;
    expect(inDeck + loose).toBe(52);
  });

  it('undo only reverts local changes', () => {
    const { a, b } = pair();
    const id = a.doc.visible.find(isCard)!.id;
    a.dispatch('core.move', { ids: [id], dx: 100, dy: 0 });
    sync(a.ydoc, b.ydoc);
    b.undo(); // nothing local on b
    expect(b.doc.get(id)!.x).toBe(a.doc.get(id)!.x);
    a.undo();
    sync(a.ydoc, b.ydoc);
    expect(b.doc.get(id)!.x).toBe(a.doc.get(id)!.x);
  });
});

describe('one-card piles', () => {
  it('a pile down to one card dissolves into that card; a home deck stays a deck', () => {
    const s = withDeck(3);
    // draw two cards out, stack them into a pile of 2
    const a = s.dispatch('cards.draw', { id: 'd', x: 400, y: 0 }).select![0];
    const b = s.dispatch('cards.draw', { id: 'd', x: 600, y: 0 }).select![0];
    const pile = s.dispatch('cards.drop', { target: b, ids: [a] }).select![0];
    expect(cardsIn(s.doc, pile)).toHaveLength(2);
    // take one out: the pile is gone, the other card lies loose where the pile was
    const out = s.dispatch('cards.draw', { id: pile, x: 900, y: 0 }).select![0];
    expect(s.doc.get(pile)).toBeUndefined();
    const rest = [a, b].find((id) => id !== out)!;
    expect(s.doc.parentOf(rest)).toBeUndefined();
    expect(s.doc.get(rest)!.x).toBe(600);
    // the home deck with one card left is still a deck
    expect(cardsIn(s.doc, 'd')).toHaveLength(1);
    expect(s.doc.get('d')).toBeDefined();
  });
});

describe('facing is kept unless asked', () => {
  it('deal keeps facing; recall keeps facing; face sets all', () => {
    const s = withDeck(4);
    s.dispatch('cards.deal', { id: 'd', count: 2 });
    const loose = s.doc.visible.filter((n) => n.id !== 'd');
    expect(loose.every((c) => !card(c).faceUp)).toBe(true); // deck was face down
    s.dispatch('cards.recall', { id: 'd' });
    expect(cardsIn(s.doc, 'd').every((c) => !card(c).faceUp)).toBe(true);
    s.dispatch('cards.face', { ids: ['d'], faceUp: true });
    expect(cardsIn(s.doc, 'd').every((c) => card(c).faceUp)).toBe(true);
    s.dispatch('cards.face', { ids: ['d'], faceUp: false });
    expect(cardsIn(s.doc, 'd').every((c) => !card(c).faceUp)).toBe(true);
  });
});

describe('kinds, layouts, put on table, showdown', () => {
  const loose = (...faces: string[]) => faces.map((f, i) => cardNode(`l${i}`, 400 + i * 200, 400, { face: f, faceUp: i % 2 === 0 }, 100 + i));
  const homeTable = (...extra: CanvasNode[]) => {
    const s = store();
    s.load({
      nodes: [
        deckNode('d', 0, 0, 1, undefined, true),
        ...['AS', '2S', '3S', '4S'].map((face, i) => cardNode(`c${i}`, 0, 0, { face, faceUp: i === 3, stack: 'd', order: i + 1, home: 'd' }, 2 + i)),
        ...extra,
      ],
      edges: [],
    });
    return s;
  };

  it('the home deck switches layouts (L too) and stays the home: gather all still fills it', () => {
    const s = homeTable();
    s.dispatch('cards.setLayout', { id: 'd', layout: 'grid' });
    expect(layoutOf(s.doc.get('d')!)).toBe('grid');
    expect(isHomeDeck(s.doc.get('d')!)).toBe(true);
    expect(['c0', 'c1', 'c2', 'c3'].every((id) => s.doc.isVisible(id))).toBe(true);
    s.dispatch('cards.toggleStack', { id: 'd' });
    expect(layoutOf(s.doc.get('d')!)).toBe('stack');
    s.dispatch('cards.toggleStack', { id: 'd' });
    expect(layoutOf(s.doc.get('d')!)).toBe('fan');
    s.dispatch('cards.draw', { id: 'd', x: 900, y: 900 });
    s.dispatch('cards.recall', { id: 'd' });
    expect(cardsIn(s.doc, 'd')).toHaveLength(4);
    s.migrate();
    expect(isHomeDeck(s.doc.get('d')!)).toBe(true); // repair keeps a spread-out home deck
  });

  it('turnInto: deck ⇄ group ⇄ hand; hand → deck goes public; the home deck is never a hand', () => {
    const s = homeTable(...loose('KH', 'QS', 'JD'));
    const g = s.dispatch('cards.gather', { ids: ['l0', 'l1', 'l2'], layout: 'stack' }).select![0];
    s.dispatch('cards.turnInto', { id: g, kind: 'group' });
    expect(layoutOf(s.doc.get(g)!)).toBe('fan');
    s.dispatch('cards.turnInto', { id: g, kind: 'hand', owner: 'alice', label: "Alice's hand", color: '#3cb44b' });
    expect(s.doc.get(g)!.owner).toBe('alice');
    expect(hiddenFrom(s.doc, s.doc.get('l0')!, 'bob')).toBe(true);
    s.dispatch('cards.turnInto', { id: g, kind: 'deck' });
    expect(s.doc.get(g)!.owner).toBeUndefined();
    expect(layoutOf(s.doc.get(g)!)).toBe('stack');
    s.undo();
    expect(s.doc.get(g)!.owner).toBe('alice'); // one undo step
    s.dispatch('cards.turnInto', { id: g, kind: 'group' });
    expect(s.doc.get(g)!.owner).toBeUndefined();
    expect(layoutOf(s.doc.get(g)!)).toBe('fan');
    expect(s.dispatch('cards.turnInto', { id: 'd', kind: 'hand', owner: 'alice' }).changes).toEqual([]);
    s.dispatch('cards.turnInto', { id: 'd', kind: 'group' });
    expect(layoutOf(s.doc.get('d')!)).toBe('fan');
  });

  it('put cards on table: a row where the group was, facing kept, group gone, one undo step', () => {
    const s = homeTable(...loose('KH', 'QS', 'JD'));
    const g = s.dispatch('cards.gather', { ids: ['l0', 'l1', 'l2'] }).select![0];
    const box = s.doc.get(g)!;
    const r = s.dispatch('cards.putOnTable', { id: g });
    expect(s.doc.get(g)).toBeUndefined();
    expect(r.select).toEqual(['l0', 'l1', 'l2']);
    const cs = ['l0', 'l1', 'l2'].map((id) => s.doc.get(id)!);
    expect(cs.every((c) => !s.doc.parentOf(c.id) && c.y === box.y + PAD)).toBe(true);
    expect(cs[0].x).toBe(box.x + PAD);
    expect(cs[1].x - cs[0].x).toBeGreaterThanOrEqual(120); // a row, not overlapping
    expect(cs.map((c) => card(c).faceUp)).toEqual([true, false, true]);
    s.undo();
    expect(cardsIn(s.doc, g)).toHaveLength(3);
  });

  it('put cards on table from a deck and from the home deck (the empty home slot stays)', () => {
    const s = homeTable(...loose('KH', 'QS'));
    const p = s.dispatch('cards.gather', { ids: ['l0', 'l1'], layout: 'stack' }).select![0];
    s.dispatch('cards.putOnTable', { id: p });
    expect(s.doc.get(p)).toBeUndefined();
    expect(s.doc.get('l0')!.x).toBe(400);
    s.dispatch('cards.putOnTable', { id: 'd' });
    expect(isHomeDeck(s.doc.get('d')!)).toBe(true);
    expect(cardsIn(s.doc, 'd')).toHaveLength(0);
    expect(s.doc.get('c0')!.x).toBeGreaterThanOrEqual(120);
    expect(card(s.doc.get('c3')!).faceUp).toBe(true);
    expect(card(s.doc.get('c0')!).faceUp).toBe(false);
    s.dispatch('cards.recall', { id: 'd' });
    expect(cardsIn(s.doc, 'd')).toHaveLength(6);
  });

  it('showdown: every hand becomes a face-up row in place, rows never overlap, the rest untouched', () => {
    const s = homeTable(...loose('KH', 'QS', 'JD', '9C', '8C'));
    const a = s.dispatch('cards.newHand', { owner: 'alice', x: 0, y: 600 }).select![0];
    const b = s.dispatch('cards.newHand', { owner: 'bob', x: 300, y: 600 }).select![0];
    s.dispatch('cards.drop', { target: a, ids: ['l0', 'l1', 'l2'] });
    s.dispatch('cards.drop', { target: b, ids: ['l3'] });
    const r = s.dispatch('cards.showdown', {});
    expect(s.doc.get(a)).toBeUndefined();
    expect(s.doc.get(b)).toBeUndefined();
    expect(r.select!.sort()).toEqual(['l0', 'l1', 'l2', 'l3']);
    const cs = ['l0', 'l1', 'l2', 'l3'].map((id) => s.doc.get(id)!);
    expect(cs.every((c) => card(c).faceUp && !s.doc.parentOf(c.id))).toBe(true);
    const [lo, hi] = [cs.slice(0, 3), cs.slice(3)];
    const apart = (p: CanvasNode[], q: CanvasNode[]) =>
      Math.max(...p.map((c) => c.x)) + 120 <= Math.min(...q.map((c) => c.x)) || Math.max(...q.map((c) => c.x)) + 120 <= Math.min(...p.map((c) => c.x)) || Math.abs(p[0].y - q[0].y) >= 168;
    expect(apart(lo, hi)).toBe(true); // rows don't overlap
    expect(s.doc.get('l4')!.x).toBe(1200); // the loose card is untouched
    s.undo();
    expect(cardsIn(s.doc, a)).toHaveLength(3);
    expect(s.dispatch('cards.showdown', {}).changes).not.toEqual([]);
    expect(store().dispatch('cards.showdown', {}).changes).toEqual([]);
  });
});
