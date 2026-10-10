import './cards.css';
import type { App, CanvasNode, Command, Plugin, Store } from '../../core';
import { commands, outCount } from './commands';
import { CARD_W, card, cardsIn, deckIdOf, homeFor, isCard, isCardish, isDeck, isHomeDeck } from './deck';
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
}

export const cardsPlugin: Plugin = {
  id: 'cards',
  setup(app) {
    registerCardsLogic(app.store);

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
        el.innerHTML = deckHtml(top && card(top), cards.length, isHomeDeck(node), isHomeDeck(node) ? outCount(doc, node.id) : 0);
      },
      renderKey(node, { doc }) {
        const cards = cardsIn(doc, node.id);
        const top = cards.at(-1);
        const out = isHomeDeck(node) ? outCount(doc, node.id) : -1;
        return `${cards.length}:${out}:${top ? card(top).face + card(top).faceUp : ''}`;
      },
      onDoubleClick: flipOne,
      onAction: (node, action, app) => {
        if (action === 'recall') app.dispatch('cards.recall', { id: node.id });
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
    const drawSel = (faceUp: boolean) => (a: App) => {
      const d = targetDeck(a);
      if (d) a.dispatch('cards.draw', { id: d.id, faceUp, select: 'deck' });
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
    app.registerKey({ key: 'd', label: 'Draw face up', run: drawSel(true) });
    app.registerKey({ key: 'shift+d', label: 'Draw face down', run: drawSel(false) });
    app.registerKey({ key: 'g', label: 'Gather into a deck', run: gatherSel() });
    app.registerKey({ key: 'shift+g', label: 'Gather all cards back to their deck', run: recallHome });
    app.registerKey({ key: 'e', label: 'Spread deck', run: spreadSel });
    const dealN = (count: number, faceUp: boolean) => (a: App) => {
      const d = targetDeck(a);
      if (d) a.dispatch('cards.deal', { id: d.id, count, faceUp });
    };
    for (let k = 1; k <= 9; k++) {
      app.registerKey({ key: `${k}`, label: `Deal ${k} face up`, run: dealN(k, true) });
      app.registerKey({ key: `shift+${k}`, label: `Deal ${k} face down`, run: dealN(k, false) });
    }

    const any = (_: App, sel: CanvasNode[]) => sel.some(isCardish);
    const hasDeck = (_: App, sel: CanvasNode[]) => sel.some(isDeck);
    const several = (_: App, sel: CanvasNode[]) => sel.filter(isCardish).length > 1;
    app.registerMenuItem({ label: 'Flip', hint: 'F', when: any, run: flipSel });
    app.registerMenuItem({ label: 'Shuffle', hint: 'S', when: hasDeck, run: shuffleSel });
    app.registerMenuItem({ label: 'Draw face up', hint: 'D', when: hasDeck, run: drawSel(true) });
    app.registerMenuItem({ label: 'Draw face down', hint: '⇧D', when: hasDeck, run: drawSel(false) });
    app.registerMenuItem({ label: 'Deal 3 face up', hint: '3', when: hasDeck, run: dealN(3, true) });
    app.registerMenuItem({ label: 'Deal 5 face up', hint: '5', when: hasDeck, run: dealN(5, true) });
    app.registerMenuItem({ label: 'Deal 5 face down', hint: '⇧5', when: hasDeck, run: dealN(5, false) });
    app.registerMenuItem({ label: 'Spread out', hint: 'E', when: hasDeck, run: spreadSel });
    app.registerMenuItem({ label: 'Gather into deck', hint: 'G', when: several, run: gatherSel() });
    // label shows how many are out; built when the menu opens
    app.registerMenuItem({
      get label() {
        const h = homeFor(app.doc, selectedCards(app).at(-1));
        return `Gather all cards (${h ? outCount(app.doc, h) : 0} out)`;
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
