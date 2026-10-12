// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { App, JsonSession, MASK } from '../../core';
import { cardNode, deckNode, standardDeck } from './deck';
import { cardsPlugin } from './index';

// The JSON panel must show a viewer only what their screen shows: no face of a card they can't see.

let roots: HTMLElement[] = [];
afterEach(() => {
  for (const r of roots) r.remove();
  roots = [];
});

/** Alice's hand `h` holds c0..c2 (faces AS 2S 3S); l0 = a face-up card (4S) on the table; d = a deck with face-down 5S, 6S. */
function table(hideCount: boolean) {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const app = new App(root);
  app.use(cardsPlugin);
  const f = standardDeck();
  app.store.load({
    nodes: [
      deckNode('d', -400, 0, 1, undefined, true),
      ...[0, 1, 2].map((i) => cardNode(`c${i}`, 200 + i * 130, 0, { face: f[i], faceUp: false, home: 'd' }, 2 + i)),
      cardNode('l0', 0, 300, { face: f[3], faceUp: true, home: 'd' }, 6),
      cardNode('k0', 0, 500, { face: f[4], faceUp: false, home: 'd' }, 7),
    ],
    edges: [],
  });
  const h = app.dispatch('cards.newHand', { owner: 'alice', label: "Alice's hand", x: 0, y: 700 }).select![0];
  app.dispatch('cards.drop', { target: h, ids: ['c0', 'c1', 'c2'] });
  if (hideCount) app.dispatch('cards.hideCount', { id: h, on: true });
  const as = (viewer: string) => new JsonSession(app.store, app.redactors, () => viewer);
  return { app, h, as };
}
const cardsOf = (text: string) => Object.fromEntries((JSON.parse(text).nodes as any[]).filter((n) => n['x-cards']?.face).map((n) => [n.id, n]));

describe('the JSON panel and hidden cards', () => {
  it("another player sees backs for a hand's cards, and the face of the table card", () => {
    const { as } = table(false);
    const c = cardsOf(as('bob').text);
    for (const id of ['c0', 'c1', 'c2']) {
      expect(c[id]['x-cards'].face).toBe(MASK);
      expect(c[id].text).toBe(MASK);
    }
    expect(c.l0['x-cards'].face).toBe('4S');
    expect(c.k0['x-cards'].face).toBe(MASK); // face down on the table: nobody knows it
    expect(as('bob').text).not.toMatch(/AS|2S|3S|5S/);
  });

  it('the owner sees their own cards', () => {
    const { as } = table(false);
    const c = cardsOf(as('alice').text);
    expect(['c0', 'c1', 'c2'].map((id) => c[id]['x-cards'].face)).toEqual(['AS', '2S', '3S']);
    expect(c.k0['x-cards'].face).toBe(MASK);
  });

  it('a hand that hides its count leaves its cards out entirely for others', () => {
    const { as } = table(true);
    const c = cardsOf(as('bob').text);
    expect(Object.keys(c).sort()).toEqual(['k0', 'l0']);
    expect(Object.keys(cardsOf(as('alice').text))).toContain('c0');
  });

  it("viewing as others (hold \\) hides the owner's own cards too", () => {
    const { as } = table(false);
    expect(cardsOf(as('alice').text).c0['x-cards'].face).toBe('AS');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\' }));
    expect(cardsOf(as('alice').text).c0['x-cards'].face).toBe(MASK);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: '\\' }));
    expect(cardsOf(as('alice').text).c0['x-cards'].face).toBe('AS');
  });

  it('editing next to masked cards keeps the secrets and never writes the mask', () => {
    const { app, as } = table(false);
    const j = as('bob');
    expect(j.apply(j.text)).toMatchObject({ ok: true, line: null });
    const t = JSON.parse(j.text);
    t.nodes.find((n: any) => n.id === 'l0').color = '4';
    t.nodes.find((n: any) => n.id === 'c0').text = 'forged'; // typing over a masked field is a real edit...
    const r = j.apply(JSON.stringify(t));
    expect(r.ok).toBe(true);
    expect(app.node('l0')!.color).toBe('4');
    expect(app.node('c0')!['x-cards']).toMatchObject({ face: 'AS' }); // the face itself is never touched
  });
});
