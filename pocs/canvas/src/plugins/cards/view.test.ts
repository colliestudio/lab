// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../core';
import { CARD_W, cardNode, deckNode, standardDeck } from './deck';
import { rowTop } from './layout';
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
      expect(Object.keys(z).filter((id) => /^c\d+$/.test(id))).toEqual([]); // the hand's cards aren't rendered at all
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

  it('a private card leaving the hand slides out from the middle of the hand, a shown one from its slot', async () => {
    const { app, root, h } = bobsTable(4);
    app.dispatch('cards.hideCount', { id: h, on: false }); // backs visible: slots are on screen
    app.dispatch('cards.allowShowing', { id: h, on: true });
    app.dispatch('cards.show', { ids: ['c3'], shown: true, by: 'alice' });
    const hand = app.node(h)!;
    const middle = `translate(${hand.x + hand.width / 2 - CARD_W / 2}px, ${hand.y + rowTop(hand)}px)`;
    /** Where a card's box slid out from while `fn` ran: the middle of the hand, or its own slot. */
    const starts = async (id: string, fn: () => void) => {
      const seen: string[] = [];
      const box = () => root.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
      const slot = app.node(id)!;
      const at = `translate(${slot.x}px, ${slot.y}px)`;
      const mo = new MutationObserver((rs) => rs.forEach((r) => seen.push(r.oldValue ?? '')));
      mo.observe(box(), { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
      fn();
      await Promise.resolve();
      mo.disconnect();
      // the slide's start is what the box showed with transitions off
      const start = seen.filter((v) => v.includes('transition: none'));
      return { fromMiddle: start.some((v) => v.includes(middle)), fromSlot: start.some((v) => v.includes(at)) };
    };
    // c0 sits left of the middle in a 4-card hand, so the two starting points differ
    expect(await starts('c0', () => app.dispatch('cards.pullOut', { id: 'c0', x: 900, y: 900 }))).toEqual({ fromMiddle: true, fromSlot: false });
    expect(await starts('c3', () => app.dispatch('cards.pullOut', { id: 'c3', x: 900, y: 1200 }))).toEqual({ fromMiddle: false, fromSlot: true });
  });
});
