import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, parse, serialize, type CanvasNode, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerCardsLogic } from './index';
import { FIELD, card, cardNode, cardsIn, deckNode, isCard, isDeck, standardDeck } from './deck';

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
    const r = s.dispatch('cards.deal', { id: 'd', count: 3 });
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

  it('gather stacks cards and decks at the first node, first on the bottom', () => {
    const s = withDeck(2, cardNode('a', 10, 20, { face: 'KH', faceUp: true }, 50), cardNode('b', 50, 50, { face: 'QH', faceUp: false }, 51));
    const r = s.dispatch('cards.gather', { ids: ['b', 'd', 'a'] });
    const deck = r.select![0];
    expect(cardsIn(s.doc, 'd')).toHaveLength(0); // merged away, stays as its cards' home
    expect(s.doc.visible.map((n) => n.id).sort()).toEqual(['d', deck].sort());
    expect([s.doc.get(deck)!.x, s.doc.get(deck)!.y]).toEqual([50, 50]);
    expect(faces(s, deck)).toEqual(['QH', 'AS', '2S', 'KH']);
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

  it('a merged deck keeps both homes; each recall pulls its own', () => {
    const s = withDeck(3, deckNode('e', 500, 0, 40), cardNode('k1', 500, 0, { face: 'KH', faceUp: false, stack: 'e', order: 1 }, 41), cardNode('k2', 500, 0, { face: 'KD', faceUp: false, stack: 'e', order: 2 }, 42));
    s.dispatch('cards.drop', { target: 'd', ids: ['e'] });
    expect(cardsIn(s.doc, 'd')).toHaveLength(5);
    expect(homeOf(s, 'k1')).toBe('e');
    s.dispatch('cards.recall', { id: 'e' });
    expect(faces(s, 'e')).toEqual(['KH', 'KD']);
    expect(faces(s)).toEqual(['AS', '2S', '3S']);
  });

  it('cards whose home was deleted adopt the deck they are gathered into', () => {
    const s = withDeck(2, deckNode('e', 500, 0, 40), cardNode('k1', 500, 0, { face: 'KH', faceUp: false, stack: 'e', order: 1 }, 41));
    s.dispatch('cards.spread', { id: 'e' }); // e stays as an empty home slot
    s.dispatch('core.delete', { ids: ['e'] });
    expect(s.dispatch('cards.recall', { id: 'e' }).changes).toEqual([]);
    s.dispatch('cards.drop', { target: 'd', ids: ['k1'] });
    expect(homeOf(s, 'k1')).toBe('d');
  });

  it('everything entering a deck takes its facing: gather, drop, recall; new deck = face down', () => {
    const up = (c: string) => card(s.doc.get(c)!).faceUp;
    const s = withDeck(2, cardNode('u1', 300, 0, { face: 'KH', faceUp: true }, 50), cardNode('u2', 500, 0, { face: 'QH', faceUp: true }, 51), cardNode('u3', 700, 0, { face: 'JH', faceUp: false }, 52));
    // drop a face-up card on a face-down deck
    s.dispatch('cards.drop', { target: 'd', ids: ['u1'] });
    expect(up('u1')).toBe(false);
    // flip the deck (all face up), then G-gather a face-down card into it
    s.dispatch('cards.flip', { ids: ['d'] });
    s.dispatch('cards.gather', { ids: ['d', 'u3'] });
    expect(cardsIn(s.doc, 'd').every((c) => card(c).faceUp)).toBe(true);
    // two face-up loose cards make a new face-down deck
    s.dispatch('cards.spread', { id: 'd' });
    const r = s.dispatch('cards.drop', { target: 'u2', ids: ['u1'] });
    expect(cardsIn(s.doc, r.select![0]).map((c) => card(c).faceUp)).toEqual([false, false]);
    // recall: face down, even if the deck was face up
    s.dispatch('cards.recall', { id: 'd' });
    expect(cardsIn(s.doc, 'd').length).toBeGreaterThan(0);
    expect(cardsIn(s.doc, 'd').every((c) => !card(c).faceUp)).toBe(true);
  });

  it('migration: deck cards get their deck, loose cards the only deck of their pack', () => {
    const t = store();
    const legacy = { pack: 'standard-52', face: 'AS', faceUp: true };
    t.load({
      nodes: [
        deckNode('d', 0, 0, 1),
        { ...cardNode('in', 0, 0, { face: '2S', faceUp: false, stack: 'd', order: 1 }, 2) },
        { id: 'loose', type: 'text', x: 0, y: 0, width: 1, height: 1, [FIELD]: legacy },
      ],
      edges: [],
    });
    expect(homeOf(t, 'in')).toBe('d');
    expect(homeOf(t, 'loose')).toBe('d');
    // two decks: a loose card's home is ambiguous, left unset
    const u = store();
    u.load({ nodes: [deckNode('d', 0, 0, 1), deckNode('e', 0, 0, 2), cardNode('x', 0, 0, { face: '2S', faceUp: false, stack: 'e', order: 1 }, 3), cardNode('y', 0, 0, { face: '3S', faceUp: false, stack: 'd', order: 1 }, 4), { id: 'l', type: 'text', x: 0, y: 0, width: 1, height: 1, [FIELD]: legacy }], edges: [] });
    expect(homeOf(u, 'l')).toBeUndefined();
    expect(homeOf(u, 'x')).toBe('e');
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
    expect(deck.text).toBe('Deck: 36 cards');
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
