// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../core';
import { cardNode, deckNode, standardDeck } from './deck';
import { cardsPlugin } from './index';

// The real view + cards plugin on a DOM: what another player's screen shows of a private hand.

let roots: HTMLElement[] = [];
afterEach(() => {
  for (const r of roots) r.remove();
  roots = [];
});

/** Bob's screen of a table: Alice's hand `h` (hidden count) holding c0..c(n-1), loose cards l0, l1 on top. */
function bobsTable(n: number) {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const app = new App(root);
  app.viewer = 'bob';
  app.use(cardsPlugin);
  const faces = standardDeck();
  app.store.load({
    nodes: [
      deckNode('d', -400, 0, 1, undefined, true),
      ...faces.slice(0, n + 2).map((face, i) => cardNode(i < n ? `c${i}` : `l${i - n}`, 200 + i * 130, 0, { face, faceUp: false, home: 'd' }, 2 + i)),
    ],
    edges: [],
  });
  const h = app.dispatch('cards.newHand', { owner: 'alice', label: "Alice's hand", x: 0, y: 400 }).select![0];
  app.dispatch('cards.drop', { target: h, ids: faces.slice(0, n).map((_, i) => `c${i}`) });
  app.dispatch('cards.hideCount', { id: h, on: true });
  app.dispatch('core.front', { ids: ['l0', 'l1'] });
  return { app, root, h };
}
const zOf = (root: HTMLElement) =>
  Object.fromEntries([...root.querySelectorAll<HTMLElement>('[data-node-id]')].map((b) => [b.dataset.nodeId!, Number(b.style.zIndex)]));

describe('a hidden-count hand on another player’s screen', () => {
  it('z-index has no gaps for concealed cards: the loose cards on top get the same numbers whatever the hand holds', () => {
    for (const n of [1, 4]) {
      const { root } = bobsTable(n);
      const z = zOf(root);
      expect(Object.keys(z).filter((id) => id.startsWith('c'))).toEqual([]); // the hand's cards aren't rendered at all
      expect(Object.values(z).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]); // deck, hand, l0, l1
      expect([z.l0, z.l1]).toEqual([3, 4]);
    }
  });

  it('the hand frame is not rebuilt when its hidden count changes', () => {
    const { app, root, h } = bobsTable(2);
    const frame = () => root.querySelector<HTMLElement>(`[data-node-id="${h}"]`)!.firstElementChild;
    const before = frame();
    expect(before).toBeTruthy();
    app.dispatch('cards.drop', { target: h, ids: ['l0'] });
    expect(frame()).toBe(before);
  });
});
