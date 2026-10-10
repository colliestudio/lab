// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { App, mountLog } from './index';
import { cardsPlugin } from '../plugins/cards';
import { cardNode, deckNode, standardDeck } from '../plugins/cards/deck';

// Two players' screens on one synced table: the cue and the log panel each of them sees.

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
  const log = mountLog(app, root);
  return { app, root, log };
}

function table() {
  const alice = screen('alice', 'Alice', '#e6194b');
  const bob = screen('bob', 'Bob', '#4363d8');
  const [da, db] = [alice.app.store.ydoc, bob.app.store.ydoc];
  da.on('update', (u: Uint8Array, origin: unknown) => origin !== 'net' && Y.applyUpdate(db, u, 'net'));
  db.on('update', (u: Uint8Array, origin: unknown) => origin !== 'net' && Y.applyUpdate(da, u, 'net'));
  const faces = standardDeck().slice(0, 6);
  alice.app.store.load({
    nodes: [
      deckNode('d', 0, 0, 1, undefined, true),
      ...faces.map((face, i) => cardNode(`c${i}`, 0, 0, { face, faceUp: false, stack: 'd', order: i + 1, home: 'd' }, 2 + i)),
      cardNode('x', 400, 0, { face: 'KH', faceUp: false, home: 'd' }, 50),
    ],
    edges: [],
  });
  return { alice, bob };
}
const bubbles = (root: HTMLElement) => [...root.querySelectorAll('.cv-bubble-text')].map((e) => e.textContent);
const entries = (root: HTMLElement) => [...root.querySelectorAll('.cv-log-entry')].map((e) => e.textContent!.replace(/(now|\d+[smhd])$/, '').trim());

describe('event cues and log panel, two players', () => {
  it('a shuffle: the other player sees a bubble in the actor’s color and the deck wiggles', () => {
    const { alice, bob } = table();
    alice.app.dispatch('cards.shuffle', { ids: ['d'] });
    expect(bubbles(bob.root)).toEqual(['Alice shuffled the deck']);
    expect(bubbles(alice.root)).toEqual(['You shuffled the deck']);
    const label = bob.root.querySelector<HTMLElement>('.cv-bubble-text')!;
    expect(label.style.getPropertyValue('--cv-actor')).toBe('#e6194b');
    expect(bob.app.view.boxOf('d')!.classList.contains('cv-cue-shuffle')).toBe(true);
  });

  it('the panel lists entries per viewer: Bob never sees the face of a card going into Alice’s hand', () => {
    const { alice, bob } = table();
    alice.log.setOpen(true);
    bob.log.setOpen(true);
    const h = alice.app.dispatch('cards.newHand', { owner: 'alice', label: "Alice's hand", color: '#e6194b', x: 0, y: 600 }).select![0];
    alice.app.dispatch('cards.drop', { target: h, ids: ['x'] });
    expect(entries(bob.root)).toEqual(["Alice added Alice's hand", "Alice put a card into Alice's hand"]);
    expect(entries(alice.root)).toEqual(["You added Alice's hand", "You put K♥ into Alice's hand"]);
    expect(bob.root.textContent).not.toContain('K♥');
    // the cue sits on the hand, not on the (hidden) card
    expect(bubbles(bob.root)).toContain("Alice put a card into Alice's hand");
    expect(bob.app.view.boxOf('x')?.className ?? '').not.toContain('cv-cue');
  });

  it('collapsed: an unread badge counts the others’ entries; opening clears it; Shift+L toggles', () => {
    const { alice, bob } = table();
    bob.log.setOpen(false);
    const badge = bob.root.querySelector<HTMLElement>('.cv-log-badge')!;
    expect(badge.hidden).toBe(true);
    alice.app.dispatch('cards.shuffle', { ids: ['d'] });
    alice.app.dispatch('cards.draw', { id: 'd' });
    bob.app.dispatch('cards.shuffle', { ids: ['d'] }); // his own: not unread
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('2');
    bob.app.keys.get('shift+l')!.run(bob.app);
    expect(bob.log.panel.classList.contains('cv-log-open')).toBe(true);
    expect(badge.hidden).toBe(true);
    bob.app.keys.get('shift+l')!.run(bob.app);
    expect(badge.hidden).toBe(true); // all seen
  });

  it('clicking an entry pans to its object (zoom kept)', () => {
    const { alice, bob } = table();
    bob.log.setOpen(true);
    alice.app.dispatch('cards.flip', { ids: ['x'] });
    const vp = bob.app.viewport;
    vp.set(0, 0, 2);
    bob.root.querySelector<HTMLElement>('.cv-log-entry')!.click();
    const x = bob.app.node('x')!;
    expect(vp.zoom).toBe(2);
    expect(vp.x).toBe(bob.root.clientWidth / 2 - (x.x + x.width / 2) * 2);
  });
});
