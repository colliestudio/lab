import './cards.css';
import type { App, CanvasNode, Command, Plugin, Store } from '../../core';
import { commands, outCount } from './commands';
import { CARD_W, FIELD, card, cardsIn, deckFacing, deckIdOf, hiddenFrom, homeFor, isCard, isCardish, isDeck, isHand, isHomeDeck, isSpreadOut, isStacked, layoutOf, type Layout } from './deck';
import { repairImport, shapeExport } from './io';
import { cardLayouts } from './layout';
import { cardHtml, deckHtml, groupHtml } from './render';

type Item = { label: string; hint?: string; run: () => void };
const LAYOUT_NAMES: Record<Layout, string> = { fan: 'Fan', row: 'Row', grid: 'Grid', stack: 'Stack (deck)' };

const selectedCards = (app: App) => app.selected().filter(isCardish);
const ids = (ns: CanvasNode[]) => ns.map((n) => n.id);
const lastDeck = (app: App) => selectedCards(app).filter(isStacked).at(-1);
/** Home deck of what's under the mouse (card, pile or deck), else of the selection. */
const targetHome = (app: App) => {
  const h = app.view.hovered && app.node(app.view.hovered);
  return homeFor(app.doc, h || undefined) ?? homeFor(app.doc, selectedCards(app).at(-1));
};
/** Deck under the mouse, else the selected one. */
const targetDeck = (app: App) => {
  const h = app.view.hovered && app.node(app.view.hovered);
  return h && isStacked(h) ? h : lastDeck(app);
};

/** The data side of the plugin (commands, containment, import/export). No DOM; used by tests too. */
export function registerCardsLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`cards.${name}`, cmd as Command);
  store.addParentRule(deckIdOf);
  store.addLayout(cardLayouts);
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
  store.migrations.push(commands.repairHomes as Command);
}

/** Tab menu of a group or hand: layout, facing, sort, gather/return, ungroup. */
function groupMenu(app: App, box: CanvasNode): Item[] {
  const id = box.id;
  const items: Item[] = [];
  const cur = layoutOf(box);
  for (const l of isHand(box) ? (['fan', 'row', 'grid'] as Layout[]) : (['fan', 'row', 'grid', 'stack'] as Layout[]))
    items.push({ label: `${l === cur ? '✓ ' : '   '}${LAYOUT_NAMES[l]}`, run: () => app.dispatch('cards.setLayout', { id, layout: l }) });
  items.push(
    { label: 'All face up', run: () => app.dispatch('cards.face', { ids: [id], faceUp: true }) },
    { label: 'All face down', run: () => app.dispatch('cards.face', { ids: [id], faceUp: false }) },
    { label: 'Sort by suit and rank', run: () => app.dispatch('cards.sort', { id }) },
  );
  const home = homeFor(app.doc, cardsIn(app.doc, id).at(-1));
  if (home) items.push({ label: 'Return all cards to the deck', hint: '⇧G', run: () => app.dispatch('cards.recall', { id: home }) });
  items.push({ label: isHand(box) ? 'Put the cards on the table' : 'Ungroup', run: () => app.dispatch('cards.ungroup', { id }) });
  return items;
}

/** Actions offered by a deck's tab, all aimed at that deck. */
function tabMenu(app: App, deck: CanvasNode): Item[] {
  if (!isHomeDeck(deck) && (isSpreadOut(deck) || isHand(deck))) return groupMenu(app, deck);
  const id = deck.id;
  const home = homeFor(app.doc, deck);
  const items: Item[] = [];
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
  if (!isHomeDeck(deck)) {
    for (const l of ['fan', 'row', 'grid'] as Layout[]) items.push({ label: `Lay out: ${LAYOUT_NAMES[l]}`, run: () => app.dispatch('cards.setLayout', { id, layout: l }) });
    items.push({ label: 'Ungroup', run: () => app.dispatch('cards.ungroup', { id }) });
  }
  return items;
}

export const cardsPlugin: Plugin = {
  id: 'cards',
  setup(app) {
    registerCardsLogic(app.store);

    const canDrop = (_t: CanvasNode, dropped: CanvasNode[]) => dropped.some(isCardish);
    const onDrop = (target: CanvasNode, dropped: string[], app: App, at: { x: number; y: number }) => app.dispatch('cards.drop', { target: target.id, ids: dropped, at });
    const flipOne = (node: CanvasNode, app: App) => app.dispatch('cards.flip', { ids: [node.id] });

    app.registerType({
      id: 'card',
      match: isCard,
      // in someone else's hand a card shows its back to you (trust mode; stage 3 makes it real)
      render(node, el, { doc, viewer }) {
        const c = card(node);
        el.innerHTML = cardHtml(hiddenFrom(doc, node, viewer) ? { ...c, faceUp: false } : c);
      },
      renderKey: (node, { doc, viewer }) => `${card(node).face}${card(node).faceUp}${hiddenFrom(doc, node, viewer)}`,
      onDoubleClick: flipOne,
      // a card shown in a group or hand: dragging pulls it out (dropping it back reorders)
      onDragStart(node, _down, app) {
        if (!app.doc.parentOf(node.id)) return;
        return app.dispatch('cards.pullOut', { id: node.id }).select?.[0];
      },
      canDrop,
      onDrop,
    });

    app.registerType({
      id: 'deck',
      match: isDeck,
      render(node, el, { doc, viewer }) {
        const cards = cardsIn(doc, node.id);
        if (isSpreadOut(node)) {
          const f = node[FIELD] as { color?: string };
          el.innerHTML = groupHtml(cards.length, { hand: isHand(node), label: node.label ?? node.text, color: f.color, mine: node.owner === viewer });
          return;
        }
        const top = cards.at(-1);
        el.innerHTML = deckHtml(top && card(top), cards.length, isHomeDeck(node));
      },
      renderKey(node, { doc, viewer }) {
        const cards = cardsIn(doc, node.id);
        const top = cards.at(-1);
        const f = node[FIELD] as { color?: string };
        return `${cards.length}:${isHomeDeck(node)}:${layoutOf(node)}:${node.label}:${f.color}:${node.owner === viewer}:${top ? card(top).face + card(top).faceUp : ''}`;
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
        if (!isStacked(node) || down.altKey || (down.target as Element | null)?.closest?.('[data-grip]')) return;
        return app.dispatch('cards.draw', { id: node.id, x: node.x, y: node.y }).select?.[0];
      },
      canDrop,
      onDrop,
    });

    const flipSel = (a: App) => a.dispatch('cards.flip', { ids: ids(selectedCards(a)) });
    const shuffleSel = (a: App) => a.dispatch('cards.shuffle', { ids: ids(selectedCards(a).filter(isStacked)) });
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
    app.registerKey({ key: 'g', label: 'Group the selection', run: gatherSel() });
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
    const hasDeck = (_: App, sel: CanvasNode[]) => sel.some(isStacked);
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
    app.registerMenuItem({ label: 'Group', hint: 'G', when: several, run: gatherSel() });
    app.registerMenuItem({ label: 'Make a deck (stack)', when: several, run: (a) => a.dispatch('cards.gather', { ids: ids(selectedCards(a)), layout: 'stack' }) });
    app.registerMenuItem({
      label: 'Group actions…',
      when: (_, sel) => sel.length === 1 && isDeck(sel[0]) && !isHomeDeck(sel[0]),
      run: (a, sel) => {
        const tab = a.view.boxOf(sel[0].id)?.querySelector('[data-grip]');
        if (tab) a.view.openMenu(tabMenu(a, sel[0]), tab);
      },
    });
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
    app.registerMenuItem({ label: 'Group face down', when: several, run: gatherSel(false) });
  },
};

export { commands } from './commands';
