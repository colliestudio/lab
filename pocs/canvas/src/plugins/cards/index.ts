import './cards.css';
import type { App, CanvasNode, Command, Plugin, Store } from '../../core';
import { commands, outCount } from './commands';
import { CARD_W, card, cardsIn, deckFacing, deckIdOf, homeFor, isCard, isCardish, isDeck, isHomeDeck } from './deck';
import { repairImport, shapeExport } from './io';
import { cardHtml, deckHtml } from './render';

const selectedCards = (app: App) => app.selected().filter(isCardish);
const ids = (ns: CanvasNode[]) => ns.map((n) => n.id);
const lastDeck = (app: App) => selectedCards(app).filter(isDeck).at(-1);
/** Home deck of what's under the mouse (card, pile or deck), else of the selection. */
const targetHome = (app: App) => {
  const h = app.view.hovered && app.node(app.view.hovered);
  return homeFor(app.doc, h || undefined) ?? homeFor(app.doc, selectedCards(app).at(-1));
};
/** Deck under the mouse, else the selected one. */
const targetDeck = (app: App) => {
  const h = app.view.hovered && app.node(app.view.hovered);
  return h && isDeck(h) ? h : lastDeck(app);
};

/** The data side of the plugin (commands, containment, import/export). No DOM; used by tests too. */
export function registerCardsLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`cards.${name}`, cmd as Command);
  store.addParentRule(deckIdOf);
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
  store.migrations.push(commands.repairHomes as Command);
  // a copied card would be a 53rd card of the pack: cards opt out of Duplicate
  store.duplicateRules.push((n) => (isCardish(n) ? null : undefined));
}

/** Actions offered by a deck's tab, all aimed at that deck. */
function tabMenu(app: App, deck: CanvasNode) {
  const id = deck.id;
  const home = homeFor(app.doc, deck);
  const items: { label: string; hint?: string; run: () => void }[] = [];
  // on a pile, say where the cards go: back to the home deck, not into this pile
  const gatherLabel = home === id ? `Gather all cards (${outCount(app.doc, home!)} out)` : 'Return all cards to the deck';
  if (home) items.push({ label: gatherLabel, hint: '⇧G', run: () => app.dispatch('cards.recall', { id: home }) });
  items.push(
    { label: 'Shuffle', hint: 'S', run: () => app.dispatch('cards.shuffle', { ids: [id] }) },
    { label: 'Deal 3', hint: '3', run: () => app.dispatch('cards.deal', { id, count: 3 }) },
    { label: 'Deal 5', hint: '5', run: () => app.dispatch('cards.deal', { id, count: 5 }) },
    { label: 'Flip', hint: 'F', run: () => app.dispatch('cards.flip', { ids: [id] }) },
    { label: 'All face up', run: () => app.dispatch('cards.face', { ids: [id], faceUp: true }) },
    { label: 'All face down', run: () => app.dispatch('cards.face', { ids: [id], faceUp: false }) },
    { label: 'Spread', hint: 'E', run: () => app.dispatch('cards.spread', { id, step: Math.round(CARD_W / 4) }) },
  );
  return items;
}

export const cardsPlugin: Plugin = {
  id: 'cards',
  setup(app) {
    registerCardsLogic(app.store);
    // setup lays out about 940 x 400 from its anchor, which sits near the top left of that
    app.registerKit({ id: 'cards.deck', label: 'Deck of cards', create: (a, at) => a.dispatch('cards.setup', { x: at.x - 470, y: at.y - 120 }) });

    const canDrop = (_t: CanvasNode, dropped: CanvasNode[]) => dropped.some(isCardish);
    const onDrop = (target: CanvasNode, dropped: string[], app: App) => app.dispatch('cards.drop', { target: target.id, ids: dropped });
    const flipOne = (node: CanvasNode, app: App) => app.dispatch('cards.flip', { ids: [node.id] });

    app.registerType({
      id: 'card',
      match: isCard,
      render(node, el) {
        el.innerHTML = cardHtml(card(node));
      },
      renderKey: (node) => `${card(node).face}${card(node).faceUp}`,
      onDoubleClick: flipOne,
      canDrop,
      onDrop,
    });

    app.registerType({
      id: 'deck',
      match: isDeck,
      render(node, el, { doc }) {
        const cards = cardsIn(doc, node.id);
        const top = cards.at(-1);
        el.innerHTML = deckHtml(top && card(top), cards.length, isHomeDeck(node));
      },
      renderKey(node, { doc }) {
        const cards = cardsIn(doc, node.id);
        const top = cards.at(-1);
        return `${cards.length}:${isHomeDeck(node)}:${top ? card(top).face + card(top).faceUp : ''}`;
      },
      onDoubleClick: flipOne,
      // Click on the tab (no drag): a small menu of deck actions anchored to it.
      onClick(node, down, app) {
        const tab = (down.target as Element | null)?.closest?.('[data-grip]');
        if (!tab) return false;
        app.view.openMenu(tabMenu(app, node), tab);
        return true;
      },
      // Dragging a deck takes its top card (orientation kept). The grip tab or Alt+drag moves the deck.
      onDragStart(node, down, app) {
        if (down.altKey || (down.target as Element | null)?.closest?.('[data-grip]')) return;
        return app.dispatch('cards.draw', { id: node.id, x: node.x, y: node.y }).select?.[0];
      },
      canDrop,
      onDrop,
    });

    const flipSel = (a: App) => a.dispatch('cards.flip', { ids: ids(selectedCards(a)) });
    const shuffleSel = (a: App) => a.dispatch('cards.shuffle', { ids: ids(selectedCards(a).filter(isDeck)) });
    // `flipped`: the card comes out the other way up from how it lies in the deck
    const drawSel = (flipped = false) => (a: App) => {
      const d = targetDeck(a);
      if (d) a.dispatch('cards.draw', { id: d.id, faceUp: flipped ? !deckFacing(a.doc, d.id) : undefined, select: 'deck' });
    };
    const flippedLabel = (verb: string) => () => {
      const d = lastDeck(app);
      return `${verb} ${d && deckFacing(app.doc, d.id) ? 'face down' : 'face up'}`;
    };
    const spreadSel = (a: App) => {
      const d = lastDeck(a);
      if (d) a.dispatch('cards.spread', { id: d.id, step: Math.round(CARD_W / 4) });
    };
    const recallHome = (a: App) => {
      const h = targetHome(a);
      if (h) a.dispatch('cards.recall', { id: h });
    };
    const gatherSel = (faceUp?: boolean) => (a: App) => a.dispatch('cards.gather', { ids: ids(selectedCards(a)), faceUp });

    app.registerKey({ key: 'f', label: 'Flip', run: flipSel });
    app.registerKey({ key: 's', label: 'Shuffle', run: shuffleSel });
    app.registerKey({ key: 'd', label: 'Draw', run: drawSel() });
    app.registerKey({ key: 'shift+d', label: 'Draw flipped', run: drawSel(true) });
    app.registerKey({ key: 'g', label: 'Gather into a deck', run: gatherSel() });
    app.registerKey({ key: 'shift+g', label: 'Gather all cards back to their deck', run: recallHome });
    app.registerKey({ key: 'e', label: 'Spread deck', run: spreadSel });
    const dealN = (count: number, flipped = false) => (a: App) => {
      const d = targetDeck(a);
      if (d) a.dispatch('cards.deal', { id: d.id, count, faceUp: flipped ? !deckFacing(a.doc, d.id) : undefined });
    };
    for (let k = 1; k <= 9; k++) {
      app.registerKey({ key: `${k}`, label: `Deal ${k}`, run: dealN(k) });
      app.registerKey({ key: `alt+${k}`, label: `Deal ${k} flipped`, run: dealN(k, true) });
    }

    const any = (_: App, sel: CanvasNode[]) => sel.some(isCardish);
    const hasDeck = (_: App, sel: CanvasNode[]) => sel.some(isDeck);
    const several = (_: App, sel: CanvasNode[]) => sel.filter(isCardish).length > 1;
    app.registerMenuItem({ label: 'Flip', hint: 'F', when: any, run: flipSel });
    app.registerMenuItem({ label: 'Shuffle', hint: 'S', when: hasDeck, run: shuffleSel });
    const faceSel = (faceUp: boolean) => (a: App) => a.dispatch('cards.face', { ids: ids(selectedCards(a)), faceUp });
    app.registerMenuItem({ label: 'All face up', when: any, run: faceSel(true) });
    app.registerMenuItem({ label: 'All face down', when: any, run: faceSel(false) });
    app.registerMenuItem({ label: 'Draw', hint: 'D', when: hasDeck, run: drawSel() });
    const drawFlippedLabel = flippedLabel('Draw');
    app.registerMenuItem({
      get label() {
        return drawFlippedLabel();
      },
      hint: '⇧D',
      when: hasDeck,
      run: drawSel(true),
    });
    app.registerMenuItem({ label: 'Deal 3', hint: '3', when: hasDeck, run: dealN(3) });
    app.registerMenuItem({ label: 'Deal 5', hint: '5', when: hasDeck, run: dealN(5) });
    app.registerMenuItem({ label: 'Spread out', hint: 'E', when: hasDeck, run: spreadSel });
    app.registerMenuItem({ label: 'Gather into deck', hint: 'G', when: several, run: gatherSel() });
    // label shows how many are out; built when the menu opens
    app.registerMenuItem({
      get label() {
        const h = homeFor(app.doc, selectedCards(app).at(-1));
        const onHome = app.store.selection.has(h ?? '');
        return onHome ? `Gather all cards (${h ? outCount(app.doc, h) : 0} out)` : 'Return all cards to the deck';
      },
      hint: '⇧G',
      when: (a, sel) => sel.length >= 1 && !!homeFor(a.doc, sel.filter(isCardish).at(-1)),
      run: (a) => {
        const h = homeFor(a.doc, selectedCards(a).at(-1));
        if (h) a.dispatch('cards.recall', { id: h });
      },
    });
    app.registerMenuItem({ label: 'Gather face down', when: several, run: gatherSel(false) });
  },
};

export { commands } from './commands';
