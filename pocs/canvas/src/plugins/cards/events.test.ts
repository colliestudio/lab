import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, eventLine, textFor, type LogEvent } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerCardsLogic } from './index';
import { card, cardNode, cardsIn, deckNode, groupNode, standardDeck } from './deck';

// What the cards plugin logs, and that nobody's text names a card they couldn't see.

const ALICE = { id: 'alice', name: 'Alice', color: '#e6194b' };
const BOB = { id: 'bob', name: 'Bob', color: '#4363d8' };

function store(ydoc?: Y.Doc, who = ALICE) {
  let n = 0;
  let t = 1000;
  const s = new Store({ ydoc, ctx: { newId: () => `${who.id}${++n}`, random: () => 0.42, now: () => (t += 1000) } });
  s.actor = () => who;
  registerCoreCommands(s);
  registerCardsLogic(s);
  return s;
}
/** Home deck `d` with n face-down cards (top = last), loose face-down `x` (K♥) and face-up `u` (Q♣), a Discard spot. */
function table(n = 5, ydoc?: Y.Doc) {
  const s = store(ydoc);
  const faces = standardDeck().slice(0, n);
  s.load({
    nodes: [
      deckNode('d', 0, 0, 1, undefined, true),
      ...faces.map((face, i) => cardNode(`c${i}`, 0, 0, { face, faceUp: false, stack: 'd', order: i + 1, home: 'd' }, 2 + i)),
      cardNode('x', 400, 0, { face: 'KH', faceUp: false, home: 'd' }, 50),
      cardNode('u', 600, 0, { face: 'QC', faceUp: true, home: 'd' }, 51),
      { ...groupNode('discard', 800, 0, 52, { layout: 'stack', spot: true, enter: 'up', label: 'Discard' }), text: 'Discard' },
    ],
    edges: [],
  });
  return s;
}
const hand = (s: Store, opts: { hideCount?: boolean; showing?: boolean } = {}) => {
  const h = s.dispatch('cards.newHand', { owner: 'alice', label: "Alice's hand", color: ALICE.color, x: 0, y: 600 }).select![0];
  if (opts.hideCount) s.dispatch('cards.hideCount', { id: h, on: true });
  if (opts.showing) s.dispatch('cards.allowShowing', { id: h, on: true });
  return h;
};
const lines = (s: Store, viewer: string) => s.log.toArray().map((e) => eventLine(e, viewer));
const last = (s: Store, viewer = 'bob') => lines(s, viewer).at(-1);
const faceOf = (s: Store, id: string) => {
  const f = card(s.doc.get(id)!).face;
  return { AS: 'A♠', '2S': '2♠', '3S': '3♠', '4S': '4♠', '5S': '5♠', KH: 'K♥', QC: 'Q♣' }[f] ?? f;
};

describe('cards: what is logged', () => {
  it('shuffle: logged with the shuffle cue on the deck; moving cards around is not logged', () => {
    const s = table();
    s.dispatch('cards.move', { ids: ['x'], dx: 10, dy: 0 });
    s.dispatch('core.move', { ids: ['u'], dx: 10, dy: 0 });
    s.dispatch('cards.gather', { ids: ['x', 'u'] });
    expect(s.log.length).toBe(0);
    s.dispatch('cards.shuffle', { ids: ['d'] });
    expect(s.log.toArray()).toMatchObject([{ type: 'cards.shuffle', targets: ['d'], cue: 'shuffle', actor: { id: 'alice', name: 'Alice' } }]);
    expect(last(s)).toBe('Alice shuffled the deck');
    expect(last(s, 'alice')).toBe('You shuffled the deck');
  });

  it('draw: "a card" while it lies face down, its name when drawn face up', () => {
    const s = table();
    s.dispatch('cards.draw', { id: 'd' });
    expect(last(s)).toBe('Alice drew a card from the deck');
    expect(last(s, 'alice')).toBe('You drew a card from the deck'); // she didn't see it either
    s.dispatch('cards.draw', { id: 'd', faceUp: true });
    expect(last(s)).toBe('Alice drew 4♠ from the deck');
  });

  it('deal N: the count, plus names when dealt face up; the deal cue on the deck', () => {
    const s = table();
    s.dispatch('cards.deal', { id: 'd', count: 2 });
    expect(last(s)).toBe('Alice dealt 2 cards from the deck');
    expect(s.log.toArray().at(-1)!.cue).toBe('deal');
    s.dispatch('cards.deal', { id: 'd', count: 2, faceUp: true });
    expect(last(s)).toBe('Alice dealt 2 cards: 3♠, 2♠ from the deck');
  });

  it('flip: turning a card up names it, a pile turned over names its new top card', () => {
    const s = table();
    s.dispatch('cards.flip', { ids: ['x'] });
    expect(last(s)).toBe('Alice turned up K♥');
    s.dispatch('cards.flip', { ids: ['x'] });
    expect(last(s)).toBe('Alice turned K♥ face down');
    s.dispatch('cards.flip', { ids: ['d'] });
    expect(last(s)).toBe('Alice turned over the deck: A♠ on top');
  });

  it('a card played to a spot that turns cards up is named for everyone', () => {
    const s = table();
    s.dispatch('cards.drop', { target: 'discard', ids: ['x'] });
    expect(last(s)).toBe('Alice played K♥ to Discard');
    expect(s.log.toArray().at(-1)!.targets).toEqual(['x', 'discard']);
  });

  it('hands: what goes in is named only if everyone saw it; the owner gets the names', () => {
    const s = table();
    const h = hand(s);
    s.dispatch('cards.drop', { target: h, ids: ['x'] }); // face down on the table
    expect(last(s)).toBe("Alice put a card into Alice's hand");
    expect(last(s, 'alice')).toBe("You put K♥ into Alice's hand");
    s.dispatch('cards.drop', { target: h, ids: ['u'] }); // face up on the table: everyone saw it
    expect(last(s)).toBe("Alice put Q♣ into Alice's hand");
  });

  it('a private card leaving a hand face down: others get "a card", the owner its name', () => {
    const s = table();
    const h = hand(s);
    s.dispatch('cards.drop', { target: h, ids: ['x'] });
    s.dispatch('cards.pullOut', { id: 'x', x: 300, y: 300 });
    expect(last(s)).toBe('Alice played a card to the table face down');
    expect(last(s, 'alice')).toBe('You played K♥ to the table face down');
    expect(s.log.toArray().at(-1)!.targets).toEqual(['x']);
  });

  it('from a hand into a face-up spot: named for everyone', () => {
    const s = table();
    const h = hand(s);
    s.dispatch('cards.drop', { target: h, ids: ['x'] });
    s.dispatch('cards.drop', { target: 'discard', ids: ['x'] });
    expect(last(s)).toBe('Alice played K♥ to Discard');
  });

  it('show / hide to the table, by menu or by dragging in the hand', () => {
    const s = table();
    const h = hand(s, { showing: true });
    s.dispatch('cards.drop', { target: h, ids: ['x'] });
    s.dispatch('cards.show', { ids: ['x'], shown: true, by: 'alice' });
    expect(last(s)).toBe('Alice showed K♥ to the table');
    s.dispatch('cards.show', { ids: [h], shown: false, by: 'alice' });
    expect(last(s)).toBe('Alice took K♥ back from the table');
    s.dispatch('cards.drop', { target: h, ids: ['x'], shown: true }); // dragged up into the strip
    expect(last(s)).toBe('Alice showed K♥ to the table');
    const n = s.log.length;
    s.dispatch('cards.drop', { target: h, ids: ['x'], shown: true }); // rearranged: nothing new
    expect(s.log.length).toBe(n);
  });

  it('give, new hand', () => {
    const s = table();
    const h = hand(s);
    expect(last(s)).toBe("Alice added Alice's hand");
    s.dispatch('cards.give', { id: h, to: 'bob', label: "Bob's hand", by: 'alice' });
    expect(last(s)).toBe("Alice gave Alice's hand to Bob");
  });

  it('gather all: never counts what came out of a hand that hides its count', () => {
    const s = table();
    s.dispatch('cards.draw', { id: 'd' });
    s.dispatch('cards.recall', { id: 'd' });
    expect(last(s)).toBe('Alice gathered 3 cards back into the deck'); // the drawn one, x, u
    const h = hand(s, { hideCount: true });
    s.dispatch('cards.deal', { id: 'd', count: 2 });
    s.dispatch('cards.drop', { target: h, ids: s.doc.visible.filter((n) => n.id.startsWith('c')).map((n) => n.id) });
    s.dispatch('cards.recall', { id: 'd' });
    expect(last(s)).toBe('Alice gathered all cards back into the deck');
  });

  it('put on table / showdown name what everyone sees afterwards', () => {
    const s = table();
    const h = hand(s);
    s.dispatch('cards.drop', { target: h, ids: ['x', 'u'] });
    s.dispatch('cards.putOnTable', { id: h });
    expect(last(s)).toBe("Alice put Alice's hand on the table: 2 cards"); // private in the hand: they land face down
    expect(last(s, 'alice')).toBe("You put Alice's hand on the table: K♥, Q♣");
    const h2 = hand(s);
    s.dispatch('cards.drop', { target: h2, ids: ['x'] });
    s.dispatch('cards.showdown', {});
    expect(last(s)).toBe("Alice put every hand on the table, face up: Alice's hand K♥");
  });

  it('a draw dragged straight into a hand is one entry', () => {
    const s = table();
    const h = hand(s);
    const n = s.log.length;
    const top = s.dispatch('cards.draw', { id: 'd' }).select![0];
    s.dispatch('cards.drop', { target: h, ids: [top] });
    expect(s.log.length).toBe(n + 1);
    expect(last(s)).toBe('Alice drew a card from the deck');
  });

  it('undo of a logged step says so; the private names stay out of it', () => {
    const s = table();
    const h = hand(s);
    s.dispatch('cards.drop', { target: h, ids: ['x'] });
    s.undo();
    expect(last(s)).toBe("Alice undid: put a card into Alice's hand");
    expect(last(s, 'alice')).toBe("You undid: put a card into Alice's hand");
  });
});

describe('cards log: never a hidden face', () => {
  it("Bob's texts name only cards he could see, over a whole game with a hidden-count hand", () => {
    const da = new Y.Doc();
    const db = new Y.Doc();
    da.on('update', (u: Uint8Array) => Y.applyUpdate(db, u));
    db.on('update', (u: Uint8Array) => Y.applyUpdate(da, u));
    const s = table(5, da);
    const bob = store(db, BOB);
    const h = hand(s, { hideCount: true, showing: true });
    const secret = ['c0', 'c1', 'c2', 'c3', 'c4', 'x'].map((id) => faceOf(s, id));
    // Alice draws into her hand, plays one face down, puts one on the deck, shows one (named: public now), recalls
    for (let i = 0; i < 3; i++) {
      const top = s.dispatch('cards.draw', { id: 'd' }).select![0];
      s.dispatch('cards.drop', { target: h, ids: [top] });
    }
    s.dispatch('cards.drop', { target: h, ids: ['x'] });
    const inHand = () => cardsIn(s.doc, h).map((c) => c.id);
    s.dispatch('cards.pullOut', { id: inHand()[0], x: 300, y: 300 });
    s.dispatch('cards.drop', { target: 'd', ids: [inHand()[0]] });
    s.dispatch('cards.shuffle', { ids: ['d'] });
    const shownId = inHand()[0];
    s.dispatch('cards.show', { ids: [shownId], shown: true, by: 'alice' });
    s.dispatch('cards.recall', { id: 'd' });
    s.undo();
    const shown = faceOf(s, shownId);
    const bobSees = bob.log.toArray().map((e: LogEvent) => textFor(e, 'bob'));
    expect(bobSees.length).toBeGreaterThan(8);
    for (const t of bobSees) for (const f of secret.filter((f) => f !== shown)) expect(t, t).not.toContain(f);
    expect(bobSees.some((t) => t.includes(shown))).toBe(true);
    // Alice's own view has the names
    expect(s.log.toArray().some((e) => secret.some((f) => f !== shown && textFor(e, 'alice').includes(f)))).toBe(true);
    // and no count leaks from the hidden hand
    expect(bobSees.filter((t) => /gathered \d/.test(t))).toEqual([]);
  });
});

