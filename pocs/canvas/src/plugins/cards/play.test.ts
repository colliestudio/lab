import { describe, expect, it } from 'vitest';
import { Store, eventLine } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerCardsLogic } from './index';
import { SORT_MODES } from './commands';
import { card, cardNode, cardsIn, deckNode, groupNode, isHand, standardDeck } from './deck';

// Playing a Tiến Lên hand: deal to players, sort, rearrange, play several cards at once (face up).

const ALICE = { id: 'alice', name: 'Alice', color: '#e6194b' };

function store() {
  let n = 0;
  let s = 7;
  const st = new Store({ ctx: { newId: () => `n${++n}`, random: () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646 } });
  st.actor = () => ALICE;
  registerCoreCommands(st);
  registerCardsLogic(st);
  return st;
}
/** Home deck `d` with the whole pack face down (top = last), plus spots: Trick (row, keeps facing), Played (pile, face down on entry). */
function table() {
  const s = store();
  s.load({
    nodes: [
      deckNode('d', 0, 0, 1, undefined, true),
      ...standardDeck().map((face, i) => cardNode(`c${i}`, 0, 0, { face, faceUp: false, stack: 'd', order: i + 1, home: 'd' }, 2 + i)),
      { ...groupNode('trick', 600, 0, 60, { layout: 'row', spot: true, label: 'Trick' }), text: 'Trick' },
      { ...groupNode('upzone', 600, 300, 61, { layout: 'row', spot: true, enter: 'up', label: 'Up' }), text: 'Up' },
      { ...groupNode('played', 1200, 0, 62, { layout: 'stack', spot: true, enter: 'down', label: 'Played' }), text: 'Played' },
    ],
    edges: [],
  });
  return s;
}
/** Take cards out of the deck onto the table (a drop only takes what's on the table). */
const take = (s: Store, ids: string[]) => {
  ids.forEach((id, i) => s.dispatch('cards.pullOut', { id, x: 2000 + i * 130, y: 0 }));
  return ids;
};
const faces = (s: Store, box: string) => cardsIn(s.doc, box).map((c) => card(c).face);
const handOf = (s: Store, owner: string) => s.doc.nodes.find((n) => isHand(n) && n.owner === owner)!;
const lastLog = (s: Store, viewer = 'alice') => eventLine(s.log.toArray().at(-1)!, viewer);
const players = [
  { id: 'alice', label: "Alice's hand", color: ALICE.color },
  { id: 'bob', label: "Bob's hand", color: '#4363d8' },
];

describe('deal to players', () => {
  it('13 each, round-robin from the top, into new private hands below the deck; the rest stays; one undo step, one log line', () => {
    const s = table();
    const before = s.log.length;
    s.dispatch('cards.dealHands', { id: 'd', count: 13, players });
    const a = handOf(s, 'alice');
    const b = handOf(s, 'bob');
    expect(cardsIn(s.doc, a.id)).toHaveLength(13);
    expect(cardsIn(s.doc, b.id)).toHaveLength(13);
    expect(cardsIn(s.doc, 'd')).toHaveLength(26);
    // the top card went to Alice, the next to Bob, and so on
    expect(cardsIn(s.doc, a.id)[0].id).toBe('c51');
    expect(cardsIn(s.doc, b.id)[0].id).toBe('c50');
    expect(cardsIn(s.doc, a.id)[1].id).toBe('c49');
    expect([...cardsIn(s.doc, a.id), ...cardsIn(s.doc, b.id)].every((c) => !card(c).faceUp)).toBe(true);
    expect(a.label).toBe("Alice's hand");
    // below the deck, side by side, not overlapping
    expect(a.y).toBeGreaterThan(168);
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x).toBe(true);
    expect(s.log.length).toBe(before + 1);
    expect(lastLog(s, 'bob')).toBe('Alice dealt 13 to each of 2 players');
    s.undo();
    expect(cardsIn(s.doc, 'd')).toHaveLength(52);
    expect(s.doc.nodes.some(isHand)).toBe(false);
  });

  it('into the hands players already have; "even" deals the whole deck evenly; uneven rounds stop when the deck runs out', () => {
    const s = table();
    const h = s.dispatch('cards.newHand', { owner: 'bob', label: "Bob's hand" }).select![0];
    s.dispatch('cards.drop', { target: h, ids: take(s, ['c0']) });
    s.dispatch('cards.dealHands', { id: 'd', count: 'even', players: [...players, { id: 'carol', label: "Carol's hand" }] });
    expect(handOf(s, 'bob').id).toBe(h);
    expect(cardsIn(s.doc, h)).toHaveLength(18); // its own card + 17
    expect(cardsIn(s.doc, handOf(s, 'alice').id)).toHaveLength(17);
    expect(cardsIn(s.doc, 'd')).toHaveLength(0);
    expect(lastLog(s)).toBe('You dealt 17 to each of 3 players');

    const t = table();
    t.dispatch('cards.dealHands', { id: 'd', count: 30, players });
    expect(cardsIn(t.doc, handOf(t, 'alice').id)).toHaveLength(26);
    expect(lastLog(t)).toBe('You dealt 26 to each of 2 players');
  });

  it('bad args are a no-op', () => {
    const s = table();
    expect(s.dispatch('cards.dealHands', { id: 'd', count: 0, players }).changes).toEqual([]);
    expect(s.dispatch('cards.dealHands', { id: 'd', count: 5, players: [] }).changes).toEqual([]);
    expect(s.dispatch('cards.dealHands', { id: 'nope', count: 5, players }).changes).toEqual([]);
  });
});

describe('Tiến Lên sort', () => {
  it('3 lowest … A, 2 highest; ties by suit ♠ ♣ ♦ ♥; remembered like the other modes', () => {
    expect(SORT_MODES).toContain('tienlen');
    const s = table();
    const h = s.dispatch('cards.newHand', { owner: 'alice' }).select![0];
    const pick = ['2H', '3D', 'AS', '3S', 'KC', '2S', 'TD', '3H', '3C'];
    const ids = s.doc.nodes.filter((n) => pick.includes(card(n)?.face)).map((n) => n.id);
    s.dispatch('cards.drop', { target: h, ids: take(s, ids) });
    s.dispatch('cards.sort', { id: h, mode: 'tienlen' });
    expect(faces(s, h)).toEqual(['3S', '3C', '3D', '3H', 'TD', 'KC', 'AS', '2S', '2H']);
    expect(s.doc.get(h)!['x-cards']).toMatchObject({ sort: { mode: 'tienlen' } });
  });
});

describe('rearranging a hand', () => {
  /** Alice's hand with AS..6S in order. */
  const sixInHand = () => {
    const s = table();
    const h = s.dispatch('cards.newHand', { owner: 'alice' }).select![0];
    s.dispatch('cards.drop', { target: h, ids: take(s, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']) });
    return { s, h };
  };
  it('← / → move the selected cards one place as a block; start / end; at the edge nothing moves', () => {
    const { s, h } = sixInHand();
    s.dispatch('cards.reorder', { ids: ['c2', 'c3'], by: -1 });
    expect(faces(s, h)).toEqual(['AS', '3S', '4S', '2S', '5S', '6S']);
    s.dispatch('cards.reorder', { ids: ['c2', 'c3'], by: -1 });
    expect(faces(s, h)).toEqual(['3S', '4S', 'AS', '2S', '5S', '6S']);
    expect(s.dispatch('cards.reorder', { ids: ['c2', 'c3'], by: -1 }).changes).toEqual([]);
    s.dispatch('cards.reorder', { ids: ['c0', 'c5'], by: 1 });
    expect(faces(s, h)).toEqual(['3S', '4S', '2S', 'AS', '5S', '6S']);
    s.dispatch('cards.reorder', { ids: ['c1', 'c4'], to: 'end' });
    expect(faces(s, h)).toEqual(['3S', '4S', 'AS', '6S', '2S', '5S']);
    s.dispatch('cards.reorder', { ids: ['c5'], to: 'start' });
    expect(faces(s, h)).toEqual(['6S', '3S', '4S', 'AS', '2S', '5S']);
  });
  it('a shown card moves only among the shown ones (the private row keeps its order)', () => {
    const { s, h } = sixInHand();
    s.dispatch('cards.allowShowing', { id: h, on: true });
    s.dispatch('cards.show', { ids: ['c1', 'c4'], shown: true });
    s.dispatch('cards.reorder', { ids: ['c4'], by: -1 });
    const all = faces(s, h);
    expect(all.filter((f) => f === '2S' || f === '5S')).toEqual(['5S', '2S']);
    expect(all.filter((f) => f !== '2S' && f !== '5S')).toEqual(['AS', '3S', '4S', '6S']);
  });
});

describe('playing cards from a hand', () => {
  /** Alice's private hand holding AS..5S (face down in the doc: private). */
  const inHand = () => {
    const s = table();
    const h = s.dispatch('cards.newHand', { owner: 'alice', label: "Alice's hand" }).select![0];
    s.dispatch('cards.drop', { target: h, ids: take(s, ['c0', 'c1', 'c2', 'c3', 'c4']) });
    return { s, h };
  };
  it('into a zone that keeps facing: face up (a play), in hand order, one log line naming them', () => {
    const { s } = inHand();
    s.dispatch('cards.drop', { target: 'trick', ids: ['c1', 'c2', 'c3'], faceUp: true });
    expect(faces(s, 'trick')).toEqual(['2S', '3S', '4S']);
    expect(cardsIn(s.doc, 'trick').every((c) => card(c).faceUp)).toBe(true);
    expect(lastLog(s, 'bob')).toBe('Alice played 2♠, 3♠, 4♠ to Trick');
  });
  it('⌥ (faceUp: false) plays face down; the log names no card to others', () => {
    const { s } = inHand();
    s.dispatch('cards.drop', { target: 'trick', ids: ['c1', 'c2'], faceUp: false });
    expect(cardsIn(s.doc, 'trick').every((c) => !card(c).faceUp)).toBe(true);
    expect(lastLog(s, 'bob')).toBe('Alice played 2 cards to Trick');
  });
  it('a zone’s facing on entry wins: Face up zone turns them up even for ⌥, the Played pile face down', () => {
    const { s } = inHand();
    s.dispatch('cards.drop', { target: 'upzone', ids: ['c0'], faceUp: false });
    expect(card(s.doc.get('c0')!).faceUp).toBe(true);
    s.dispatch('cards.drop', { target: 'played', ids: ['c1'], faceUp: true });
    expect(card(s.doc.get('c1')!).faceUp).toBe(false);
    // a hand card dropped onto a card already in the zone goes into the zone, turned up too
    s.dispatch('cards.drop', { target: 'c0', ids: ['c2'] });
    expect(s.doc.parentOf('c2')).toBe('upzone');
    expect(card(s.doc.get('c2')!).faceUp).toBe(true);
  });
  it('cards from the table keep their facing; into another hand they stay private', () => {
    const { s } = inHand();
    const loose = s.dispatch('cards.draw', { id: 'd' }).select![0];
    s.dispatch('cards.drop', { target: 'trick', ids: [loose], faceUp: true });
    expect(card(s.doc.get(loose)!).faceUp).toBe(false);
    const bob = s.dispatch('cards.newHand', { owner: 'bob', label: "Bob's hand" }).select![0];
    s.dispatch('cards.drop', { target: bob, ids: ['c4'], faceUp: true });
    expect(card(s.doc.get('c4')!).faceUp).toBe(false);
  });
  it('onto the table: put down together, overlapping in order, face up; one undo step', () => {
    const { s, h } = inHand();
    s.dispatch('cards.putDown', { ids: ['c3', 'c1'], x: 500, y: 900, faceUp: true });
    const [a, b] = [s.doc.get('c3')!, s.doc.get('c1')!];
    expect(s.doc.parentOf('c3')).toBeUndefined();
    expect([a.x, a.y, b.y]).toEqual([500, 900, 900]);
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.x - a.x).toBeLessThan(120);
    expect(card(a).faceUp && card(b).faceUp).toBe(true);
    expect(lastLog(s, 'bob')).toBe('Alice played 4♠, 2♠ to the table');
    expect(faces(s, h)).toEqual(['AS', '3S', '5S']);
    s.undo();
    expect(faces(s, h)).toEqual(['AS', '2S', '3S', '4S', '5S']);
  });
  it('onto the table with ⌥: face down', () => {
    const { s } = inHand();
    s.dispatch('cards.putDown', { ids: ['c0'], x: 0, y: 900, faceUp: false });
    expect(card(s.doc.get('c0')!).faceUp).toBe(false);
    expect(lastLog(s, 'bob')).toBe('Alice played a card to the table face down');
  });
});
