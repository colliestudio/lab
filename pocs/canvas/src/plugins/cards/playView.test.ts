// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { App, eventLine } from '../../core';
import { cardsPlugin, dealCandidates } from './index';
import { card, cardNode, cardsIn, deckNode, groupNode, isHand, standardDeck } from './deck';

// A Tiến Lên table on two synced screens: deal, sort, rearrange with keys, play several cards at once.

let roots: HTMLElement[] = [];
afterEach(() => {
  for (const r of roots) r.remove();
  roots = [];
  localStorage.clear();
});

function screen(id: string, name: string, color: string) {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const app = new App(root);
  app.viewer = id;
  app.player = { id, name, color };
  app.use(cardsPlugin);
  return { app, root };
}

/** Alice and Bob on one table: the whole pack in deck `d`, a Trick row (keeps facing) and a Played pile (face down on entry). */
function table() {
  const alice = screen('alice', 'Alice', '#e6194b');
  const bob = screen('bob', 'Bob', '#4363d8');
  const [da, db] = [alice.app.store.ydoc, bob.app.store.ydoc];
  da.on('update', (u: Uint8Array, origin: unknown) => origin !== 'net' && Y.applyUpdate(db, u, 'net'));
  db.on('update', (u: Uint8Array, origin: unknown) => origin !== 'net' && Y.applyUpdate(da, u, 'net'));
  alice.app.store.load({
    nodes: [
      deckNode('d', 0, 0, 1, undefined, true),
      ...standardDeck().map((face, i) => cardNode(`c${i}`, 0, 0, { face, faceUp: false, stack: 'd', order: i + 1, home: 'd' }, 2 + i)),
      { ...groupNode('trick', 600, 0, 60, { layout: 'row', spot: true, label: 'Trick' }), text: 'Trick' },
      { ...groupNode('played', 1400, 0, 61, { layout: 'stack', spot: true, enter: 'down', label: 'Played' }), text: 'Played' },
    ],
    edges: [],
  });
  const players = [
    { id: 'alice', label: "Alice's hand", color: '#e6194b' },
    { id: 'bob', label: "Bob's hand", color: '#4363d8' },
  ];
  alice.app.dispatch('cards.dealHands', { id: 'd', count: 13, players });
  const handOf = (owner: string) => alice.app.doc.nodes.find((n) => isHand(n) && n.owner === owner)!.id;
  return { alice, bob, ha: handOf('alice'), hb: handOf('bob') };
}
/** What `root` shows of card `id`: its face code, "back", or nothing (not rendered). */
const shows = (root: HTMLElement, app: App, id: string) => {
  const box = root.querySelector(`[data-node-id="${id}"]`);
  if (!box) return 'none';
  return box.querySelector('.pc-back') ? 'back' : card(app.node(id)!).face;
};
const lastLine = (app: App, viewer: string) => eventLine(app.store.log.toArray().at(-1)!, viewer);
const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods }));

describe('Tiến Lên on two screens', () => {
  it('deal 13 each: each player sees their own faces and the other’s backs; the log says it once', () => {
    const { alice, bob, ha, hb } = table();
    const mine = cardsIn(alice.app.doc, ha);
    const theirs = cardsIn(alice.app.doc, hb);
    expect(mine).toHaveLength(13);
    expect(mine.every((c) => shows(alice.root, alice.app, c.id) === card(c).face)).toBe(true);
    expect(mine.every((c) => shows(bob.root, bob.app, c.id) === 'back')).toBe(true);
    expect(theirs.every((c) => shows(alice.root, alice.app, c.id) === 'back')).toBe(true);
    expect(lastLine(bob.app, 'bob')).toBe('Alice dealt 13 to each of 2 players');
    expect(cardsIn(alice.app.doc, 'd')).toHaveLength(26);
  });

  it('sort Tiến Lên, then ←/→ move the selected cards within the hand (⇧ to the end)', () => {
    const { alice, ha } = table();
    alice.app.dispatch('cards.sort', { id: ha, mode: 'tienlen' });
    const order = () => cardsIn(alice.app.doc, ha).map((c) => c.id);
    const before = order();
    alice.app.store.select([before[0], before[1]]);
    key('ArrowRight');
    expect(order()).toEqual([before[2], before[0], before[1], ...before.slice(3)]);
    key('ArrowLeft');
    expect(order()).toEqual(before);
    key('ArrowRight', { shiftKey: true });
    expect(order()).toEqual([...before.slice(2), before[0], before[1]]);
    // nothing nudged: cards in a hand only move within it
    expect(alice.app.doc.parentOf(before[0])).toBe(ha);
  });

  it('play 3 selected to Trick by dropping them: face up for Bob only after the play, in hand order, one log line', () => {
    const { alice, bob, ha } = table();
    const three = cardsIn(alice.app.doc, ha).slice(4, 7).map((c) => c.id);
    expect(three.map((id) => shows(bob.root, bob.app, id))).toEqual(['back', 'back', 'back']);
    const trick = alice.app.node('trick')!;
    alice.app.typeOf(trick)!.onDrop!(trick, [three[2], three[0], three[1]], alice.app, { x: 700, y: 50 });
    expect(cardsIn(bob.app.doc, 'trick').map((c) => c.id)).toEqual(three);
    expect(three.map((id) => shows(bob.root, bob.app, id))).toEqual(three.map((id) => card(bob.app.node(id)!).face));
    const names = three.map((id) => bob.app.node(id)!.text).join(', ');
    expect(lastLine(bob.app, 'bob')).toBe(`Alice played ${names} to Trick`);
  });

  it('⌥ held at the drop plays face down; the Played pile turns them down whatever', () => {
    const { alice, bob, ha } = table();
    const [a, b] = cardsIn(alice.app.doc, ha).map((c) => c.id);
    const trick = alice.app.node('trick')!;
    alice.app.view.altKey = true;
    alice.app.typeOf(trick)!.onDrop!(trick, [a], alice.app, { x: 700, y: 50 });
    alice.app.view.altKey = false;
    expect(shows(bob.root, bob.app, a)).toBe('back');
    expect(lastLine(bob.app, 'bob')).toBe('Alice played a card to Trick');
    const played = alice.app.node('played')!;
    alice.app.typeOf(played)!.onDrop!(played, [b], alice.app, { x: 1450, y: 50 });
    expect(card(alice.app.node(b)!).faceUp).toBe(false);
  });

  it('the drop label says it: "Play to Trick", "· face down" with ⌥; Trick takes a card however little it overlaps', () => {
    const { alice, ha } = table();
    const c = alice.app.node(cardsIn(alice.app.doc, ha)[0].id)!;
    const trick = alice.app.node('trick')!;
    const t = alice.app.typeOf(trick)!;
    expect(t.canDrop!(trick, [c], alice.app, 0.1)).toBe('Play to Trick');
    alice.app.view.altKey = true;
    expect(t.canDrop!(trick, [c], alice.app, 0.9)).toBe('Play to Trick · face down');
    alice.app.view.altKey = false;
  });

  it('dropped on the table beside everything: put down together, face up, overlapping in hand order', () => {
    const { alice, bob, ha } = table();
    const two = cardsIn(alice.app.doc, ha).slice(0, 2).map((c) => c.id);
    const grabbed = alice.app.node(two[1])!;
    alice.app.typeOf(grabbed)!.onLocalDrop!(grabbed, { x: 2000, y: 900 }, alice.app, [two[1], two[0]]);
    const [p, q] = two.map((id) => bob.app.node(id)!);
    expect(bob.app.doc.parentOf(p.id)).toBeUndefined();
    expect(q.x).toBe(2000); // the grabbed card lands where it was dropped
    expect(p.x).toBeLessThan(q.x);
    expect(two.map((id) => shows(bob.root, bob.app, id))).toEqual(two.map((id) => card(bob.app.node(id)!).face));
  });

  it('P plays the selection to the zone under the pointer, then to the same zone again; ⇧P face down', () => {
    const { alice, bob, ha } = table();
    const cs = cardsIn(alice.app.doc, ha).map((c) => c.id);
    alice.app.store.select([cs[0], cs[1]]);
    alice.app.view.hovered = 'trick';
    key('p');
    expect(cardsIn(bob.app.doc, 'trick').map((c) => c.id)).toEqual([cs[0], cs[1]]);
    alice.app.store.select([cs[5]]);
    alice.app.view.hovered = undefined;
    key('P', { shiftKey: true });
    expect(cardsIn(bob.app.doc, 'trick').map((c) => c.id)).toEqual([cs[0], cs[1], cs[5]]);
    expect(shows(bob.root, bob.app, cs[5])).toBe('back');
  });

  it('click a card, ⇧click another: the run between them in the hand; ⌘click adds one more', () => {
    const { alice, ha } = table();
    const cs = cardsIn(alice.app.doc, ha).map((c) => c.id);
    const press = (id: string, mods: PointerEventInit = {}) => {
      const box = alice.root.querySelector(`[data-node-id="${id}"]`)!;
      box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 5, clientY: 5, ...mods }));
      alice.root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: 5, clientY: 5, ...mods }));
    };
    press(cs[2]);
    press(cs[5], { shiftKey: true });
    expect([...alice.app.store.selection].sort()).toEqual(cs.slice(2, 6).sort());
    press(cs[9], { metaKey: true });
    expect([...alice.app.store.selection].sort()).toEqual([...cs.slice(2, 6), cs[9]].sort());
  });

  it('a drag over a hand shows an insertion marker; it goes when the drag leaves', () => {
    const { alice, ha } = table();
    const hand = alice.app.node(ha)!;
    const cs = cardsIn(alice.app.doc, ha);
    const t = alice.app.typeOf(hand)!;
    t.dragOver!(hand, [cs[0]], alice.app, { x: cs[5].x + 10, y: cs[5].y + 50 });
    const m = alice.app.view.world.querySelector<HTMLElement>('.pc-insert');
    expect(m).toBeTruthy();
    expect(m!.style.transform).toMatch(/translate\(/);
    t.dragOver!(hand, [], alice.app, undefined);
    expect(alice.app.view.world.querySelector('.pc-insert')).toBeNull();
  });
});

describe('deal to players: who', () => {
  it('solo: me and a second seat ("Player 2"); untick / tick in the Players menu', () => {
    localStorage.setItem('canvas-poc:player', JSON.stringify({ id: 'me', name: 'Me', color: '#888888', named: true }));
    const { app } = screen('me', 'Me', '#888888');
    const c = dealCandidates(app);
    expect(c.map((x) => [x.seat.name, x.on])).toEqual([
      ['Me', true],
      ['Player 2', true],
    ]);
    // a hand of someone who was here before counts as the second seat instead
    app.dispatch('cards.newHand', { owner: 'ann', label: "Ann's hand" });
    expect(dealCandidates(app).map((x) => [x.seat.name, x.on])).toEqual([
      ['Me', true],
      ['Ann', true],
    ]);
  });
});
