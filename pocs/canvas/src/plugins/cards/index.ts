import './cards.css';
import type { App, CanvasNode, Command, Plugin, Store } from '../../core';
import { commands } from './commands';
import { CARD_W, card, cardsIn, deckIdOf, isCard, isCardish, isDeck } from './deck';
import { repairImport, shapeExport } from './io';
import { cardHtml, deckHtml } from './render';

const selectedCards = (app: App) => app.selected().filter(isCardish);
const ids = (ns: CanvasNode[]) => ns.map((n) => n.id);
const lastDeck = (app: App) => selectedCards(app).filter(isDeck).at(-1);

/** The data side of the plugin (commands, containment, import/export). No DOM; used by tests too. */
export function registerCardsLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`cards.${name}`, cmd as Command);
  store.addParentRule(deckIdOf);
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
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
        el.innerHTML = deckHtml(top && card(top), cards.length);
      },
      renderKey(node, { doc }) {
        const cards = cardsIn(doc, node.id);
        const top = cards.at(-1);
        return `${cards.length}:${top ? card(top).face + card(top).faceUp : ''}`;
      },
      onDoubleClick: flipOne,
      // Alt/Option + press pulls the top card off (offset so a plain alt-click shows it) and drags it.
      onPointerDown(node, e, app) {
        if (!e.altKey) return;
        const res = app.dispatch('cards.draw', { id: node.id, x: node.x + 28, y: node.y + 28 });
        return res.select?.[0];
      },
      canDrop,
      onDrop,
    });

    const flipSel = (a: App) => a.dispatch('cards.flip', { ids: ids(selectedCards(a)) });
    const shuffleSel = (a: App) => a.dispatch('cards.shuffle', { ids: ids(selectedCards(a).filter(isDeck)) });
    const drawSel = (faceUp: boolean) => (a: App) => {
      const d = lastDeck(a);
      if (d) a.dispatch('cards.draw', { id: d.id, faceUp, select: 'deck' });
    };
    const spreadSel = (a: App) => {
      const d = lastDeck(a);
      if (d) a.dispatch('cards.spread', { id: d.id, step: Math.round(CARD_W / 4) });
    };
    const gatherSel = (faceUp?: boolean) => (a: App) => a.dispatch('cards.gather', { ids: ids(selectedCards(a)), faceUp });

    app.registerKey({ key: 'f', label: 'Flip', run: flipSel });
    app.registerKey({ key: 's', label: 'Shuffle', run: shuffleSel });
    app.registerKey({ key: 'd', label: 'Draw face up', run: drawSel(true) });
    app.registerKey({ key: 'shift+d', label: 'Draw face down', run: drawSel(false) });
    app.registerKey({ key: 'g', label: 'Gather into a deck', run: gatherSel() });
    app.registerKey({ key: 'e', label: 'Spread deck', run: spreadSel });

    const any = (_: App, sel: CanvasNode[]) => sel.some(isCardish);
    const hasDeck = (_: App, sel: CanvasNode[]) => sel.some(isDeck);
    const several = (_: App, sel: CanvasNode[]) => sel.filter(isCardish).length > 1;
    app.registerMenuItem({ label: 'Flip', hint: 'F', when: any, run: flipSel });
    app.registerMenuItem({ label: 'Shuffle', hint: 'S', when: hasDeck, run: shuffleSel });
    app.registerMenuItem({ label: 'Draw face up', hint: 'D', when: hasDeck, run: drawSel(true) });
    app.registerMenuItem({ label: 'Draw face down', hint: '⇧D', when: hasDeck, run: drawSel(false) });
    app.registerMenuItem({ label: 'Spread out', hint: 'E', when: hasDeck, run: spreadSel });
    app.registerMenuItem({ label: 'Gather into deck', hint: 'G', when: several, run: gatherSel() });
    app.registerMenuItem({ label: 'Gather face down', when: several, run: gatherSel(false) });
  },
};

export { commands } from './commands';
