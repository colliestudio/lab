import './cards.css';
import { loadPlayer, type App, type CanvasNode, type Command, type MenuEntry, type Plugin, type Store } from '../../core';
import { commands, dropMode, kindOf, outCount, type DropMode, type Kind } from './commands';
import { CARD_W, FIELD, card, cardsIn, deckFacing, deckIdOf, handOf, hiddenFrom, homeFor, isBlind, isCard, isCardish, isDeck, isHand, isHomeDeck, isSpreadOut, isStacked, layoutOf, ownerSees, type Layout } from './deck';
import { mountHandUx, VIEW_AS_KEY, type HandUx } from './handUx';
import { repairImport, shapeExport } from './io';
import { RAISE, cardLayouts, liftedDrop, slotIndex } from './layout';
import { cardHtml, deckHtml, groupHtml } from './render';

const LAYOUT_NAMES: Record<Exclude<Layout, 'stack'>, string> = { fan: 'Fan', row: 'Row', grid: 'Grid' };

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
  store.migrations.push(commands.migrateHands as Command);
  store.migrations.push(commands.repairHomes as Command);
  store.resets.push(commands.resetAll as Command);
  // a copied card would be a 53rd card of the pack: cards opt out of Duplicate
  store.duplicateRules.push((n) => (isCardish(n) ? null : undefined));
}

/** The local player (in a room: presence; solo: this browser's stored player). */
const me = (app: App) => app.presence?.me ?? loadPlayer();
export const handLabelOf = (name: string) => `${name}'s hand`;

/** What a container is called: "Deck", "Group", "Alice's hand" (menu titles, tabs). */
export function kindName(box: CanvasNode): string {
  const k = kindOf(box);
  if (k === 'hand') return box.label ?? 'Hand';
  return k === 'deck' ? 'Deck' : 'Group';
}
const titleOf = (box: CanvasNode) => kindName(box) + (isHomeDeck(box) ? ' (home deck)' : '');

const PRIVATE_NO_STACK = 'A hand can’t be a deck (its top card would show): Turn into ▸ Deck makes it public first';

/** Gather all / return all, for whatever leads to a home deck. */
function gatherEntry(app: App, from: CanvasNode | undefined): MenuEntry[] {
  const home = homeFor(app.doc, from);
  if (!home) return [];
  const label = from?.id === home ? `Gather all cards (${outCount(app.doc, home)} out)` : 'Return all cards to the deck';
  return [{ label, hint: '⇧G', run: () => app.dispatch('cards.recall', { id: home }) }];
}

const facingMenu = (app: App, ids: () => string[]): MenuEntry => ({
  label: 'Facing',
  items: [
    { label: 'Flip', hint: 'F', run: () => app.dispatch('cards.flip', { ids: ids() }) },
    { label: 'All face up', run: () => app.dispatch('cards.face', { ids: ids(), faceUp: true }) },
    { label: 'All face down', run: () => app.dispatch('cards.face', { ids: ids(), faceUp: false }) },
  ],
});

/** Deal ▸ 1, 2, 3, 5, 7, N… from deck `id`. */
function dealMenu(app: App, id: string): MenuEntry {
  const n = cardsIn(app.doc, id).length;
  const deal = (count: number) => () => app.dispatch('cards.deal', { id, count });
  return {
    label: 'Deal',
    disabled: n ? false : 'The deck is empty',
    items: () => [
      ...[1, 2, 3, 5, 7].map((k): MenuEntry => ({ label: `Deal ${k}`, hint: String(k), run: deal(k), disabled: k > n ? `Only ${n} in the deck` : false })),
      { label: 'Deal', separator: true, number: { value: Math.min(4, n), min: 1, max: Math.max(1, n), action: 'Deal', run: (k) => deal(k)() } },
      { label: 'Turned over: ⌥1–9', disabled: true },
    ],
  };
}

/** Turn into ▸ Deck / Group / Hand. The current kind is checked; L's target shows "L". */
function turnIntoMenu(app: App, box: CanvasNode): MenuEntry {
  const id = box.id;
  const kind = kindOf(box);
  const mine = box.owner === app.viewer;
  const to = (k: Kind) => () => app.dispatch('cards.turnInto', { id, kind: k, owner: me(app).id, label: handLabelOf(me(app).name), color: me(app).color });
  const hand: MenuEntry = isHomeDeck(box)
    ? { label: 'Hand', disabled: 'The home deck stays public (gather all fills it)' }
    : kind === 'hand' && !mine
      ? { label: 'Hand (make it yours)', run: () => app.dispatch('cards.own', { id, owner: me(app).id, label: handLabelOf(me(app).name), color: me(app).color }) }
      : { label: 'Hand (others see backs)', checked: kind === 'hand', disabled: kind === 'hand', run: to('hand') };
  return {
    label: 'Turn into',
    items: [
      { label: kind === 'hand' ? 'Deck (makes it public)' : 'Deck', hint: kind === 'group' ? 'L' : undefined, checked: kind === 'deck', disabled: kind === 'deck', run: to('deck') },
      { label: kind === 'hand' ? 'Group (makes it public)' : 'Group', hint: kind === 'deck' ? 'L' : undefined, checked: kind === 'group', disabled: kind === 'group', run: to('group') },
      hand,
    ],
  };
}

/** Layout ▸ Fan / Row / Grid, for groups and hands. */
function layoutMenu(app: App, box: CanvasNode): MenuEntry {
  const cur = layoutOf(box);
  return {
    label: 'Layout',
    items: (['fan', 'row', 'grid'] as const).map((l) => ({ label: LAYOUT_NAMES[l], checked: cur === l, run: () => app.dispatch('cards.setLayout', { id: box.id, layout: l }) })),
  };
}

const HAND_FLIP_HINT = 'In a hand, flipping doesn’t reveal: drag the card up, or right-click ▸ Show to table';
const showColor = (h: CanvasNode) => (h[FIELD] as { color?: string }).color ?? '#2f4b7c';
const ownerOnly = (h: CanvasNode) => `Only ${h.label?.replace(/’s hand$|'s hand$/, '') || 'its owner'} can show these cards`;

/** Show to table / Hide for cards in hands (multi-select: counts), plus "Flip for me" in a blind hand. */
function showEntries(app: App, cards: CanvasNode[]): MenuEntry[] {
  const mine = cards.filter((c) => handOf(app.doc, c)?.owner === app.viewer);
  if (!mine.length) {
    const h = handOf(app.doc, cards[0])!;
    return [{ label: 'Show to table', disabled: ownerOnly(h) }];
  }
  const hidden = mine.filter((c) => !card(c).faceUp);
  const shown = mine.filter((c) => card(c).faceUp);
  const n = (k: number) => (k > 1 ? ` ${k}` : '');
  const out: MenuEntry[] = [
    { label: `Show${n(hidden.length)} to table`, disabled: hidden.length ? false : 'Already shown (raised)', run: () => app.dispatch('cards.show', { ids: ids(hidden), shown: true, by: app.viewer }) },
    { label: `Hide${n(shown.length)}`, disabled: shown.length ? false : 'Not shown: only you see it', run: () => app.dispatch('cards.show', { ids: ids(shown), shown: false, by: app.viewer }) },
  ];
  const blindPrivate = hidden.filter((c) => isBlind(handOf(app.doc, c)!));
  if (blindPrivate.length) out.push({ label: 'Flip for me (others still see the back)', hint: 'F', run: () => app.dispatch('cards.flip', { ids: ids(blindPrivate), by: app.viewer }) });
  return out;
}

/** A hand's own entries: show/hide all, See my cards, View as others. */
function handMenu(app: App, box: CanvasNode, ux: HandUx): MenuEntry[] {
  const cards = cardsIn(app.doc, box.id);
  if (box.owner !== app.viewer) return [{ label: 'Show all to table', disabled: ownerOnly(box) }];
  const hidden = cards.filter((c) => !card(c).faceUp).length;
  const shown = cards.length - hidden;
  return [
    { label: 'Show all to table', disabled: hidden ? false : 'Nothing private', run: () => app.dispatch('cards.show', { ids: [box.id], shown: true, by: app.viewer }) },
    { label: 'Hide all', disabled: shown ? false : 'Nothing shown', run: () => app.dispatch('cards.show', { ids: [box.id], shown: false, by: app.viewer }) },
    { label: 'See my cards', separator: true, checked: !isBlind(box), run: () => app.dispatch('cards.seeMine', { id: box.id, on: isBlind(box) }) },
    { label: 'View as others', hint: `hold ${VIEW_AS_KEY}`, checked: ux.sticky(), run: () => ux.toggle() },
  ];
}

/** Everything you can do to one container: its tab menu, and its right-click menu. */
function containerMenu(app: App, box: CanvasNode, ux: HandUx): MenuEntry[] {
  const id = box.id;
  const kind = kindOf(box);
  const out: MenuEntry[] = [...gatherEntry(app, box)];
  if (kind === 'deck') {
    const flippedTo = deckFacing(app.doc, id) ? 'face down' : 'face up';
    out.push(
      { label: 'Draw', hint: 'D', run: () => app.dispatch('cards.draw', { id, select: 'deck' }) },
      { label: `Draw ${flippedTo}`, hint: '⇧D', run: () => app.dispatch('cards.draw', { id, faceUp: !deckFacing(app.doc, id), select: 'deck' }) },
      dealMenu(app, id),
      { label: 'Shuffle', hint: 'S', run: () => app.dispatch('cards.shuffle', { ids: [id] }) },
    );
  } else out.push({ label: 'Sort by suit and rank', run: () => app.dispatch('cards.sort', { id }) });
  if (kind === 'hand') out.push(...handMenu(app, box, ux));
  else out.push(facingMenu(app, () => [id]));
  out.push({ ...turnIntoMenu(app, box), separator: true });
  if (kind !== 'deck') out.push(layoutMenu(app, box));
  out.push({
    label: isHomeDeck(box) ? 'Put cards on table (deck slot stays)' : 'Put cards on table',
    separator: true,
    run: () => app.dispatch('cards.putOnTable', { id }),
  });
  if (kind === 'deck') out.push({ label: 'Spread on table, overlapping', hint: 'E', run: () => app.dispatch('cards.spread', { id, step: Math.round(CARD_W / 4) }) });
  return out;
}

export const cardsPlugin: Plugin = {
  id: 'cards',
  setup(app) {
    registerCardsLogic(app.store);
    const ux = mountHandUx(app);
    // setup lays out about 940 x 400 from its anchor, which sits near the top left of that
    app.registerKit({ id: 'cards.deck', label: 'Deck of cards', create: (a, at) => a.dispatch('cards.setup', { x: at.x - 470, y: at.y - 120 }) });

    // drop classification, shown on the target while hovering: Stack / Fan / Add to …
    const LABEL: Record<DropMode, (t: CanvasNode, app: App) => string> = {
      stack: () => 'Stack',
      fan: () => 'Fan',
      add: (t, app) => {
        const box = isDeck(t) ? t : app.node(app.doc.parentOf(t.id) ?? '');
        return !box ? 'Add' : isHomeDeck(box) ? 'Add to deck' : isStacked(box) ? 'Add to pile' : isHand(box) ? 'Add to hand' : 'Add to group';
      },
    };
    /** The hand a drop lands in, if it's the hand the (single) dragged card came out of. */
    const homeHand = (t: CanvasNode, dropped: CanvasNode[], app: App) => {
      if (dropped.length !== 1) return;
      const host = isDeck(t) ? t : app.node(app.doc.parentOf(t.id) ?? '');
      return host && ux.drag.get(dropped[0].id)?.hand === host.id ? host : undefined;
    };
    const canDrop = (t: CanvasNode, dropped: CanvasNode[], app: App, overlap: number) => {
      if (!dropped.some(isCardish)) return false;
      const mode = dropMode(app.doc, t, overlap);
      if (!mode) return false;
      // back into its own hand: up = shown, down in the row = private
      const h = mode === 'add' && homeHand(t, dropped, app);
      if (h) {
        const c = dropped[0];
        const n = cardsIn(app.doc, h.id).length;
        const lifted = liftedDrop(h, n + 1, slotIndex(h, n, { x: c.x + CARD_W / 2, y: c.y }), c.y);
        return lifted ? (card(c).faceUp ? 'Shown' : 'Show to table') : card(c).faceUp ? 'Hide' : 'Private';
      }
      return LABEL[mode](t, app);
    };
    const onDrop = (target: CanvasNode, dropped: string[], app: App, at: { x: number; y: number }, mode?: string) => {
      const before = dropped.map((id) => app.node(id)).filter((n): n is CanvasNode => !!n);
      const h = homeHand(target, before, app);
      app.dispatch('cards.drop', { target: target.id, ids: dropped, at, as: mode === 'Stack' ? 'stack' : mode === 'Fan' ? 'fan' : undefined });
      if (!h) return;
      const c = before[0];
      const list = cardsIn(app.doc, h.id);
      const i = list.findIndex((x) => x.id === c.id);
      if (i < 0) return;
      const lifted = liftedDrop(app.node(h.id)!, list.length, i, c.y);
      if (lifted !== card(c).faceUp) app.dispatch('cards.show', { ids: [c.id], shown: lifted, by: app.viewer });
    };
    const flipOne = (node: CanvasNode, app: App) => {
      if (isHand(node)) return app.notify(HAND_FLIP_HINT);
      const r = app.dispatch('cards.flip', { ids: [node.id], by: app.viewer });
      if (!r.changes.length && handOf(app.doc, node)) app.notify(HAND_FLIP_HINT);
    };
    /** How a card looks to this viewer: face or back, raised (shown to the table) in whose color. */
    const look = (node: CanvasNode, { doc, viewer }: { doc: typeof app.doc; viewer: string }) => {
      const c = card(node);
      const h = handOf(doc, node);
      const asOthers = ux.asOthers();
      const up = h ? !hiddenFrom(doc, node, viewer, asOthers) : c.faceUp || (!asOthers && !!ux.drag.get(node.id)?.saw);
      return { up, raised: !!h && c.faceUp, color: h ? showColor(h) : '' };
    };

    app.registerType({
      id: 'card',
      match: isCard,
      // In a hand, face up = shown to the table: drawn raised with a glow in the owner's color, for
      // everyone. Private cards stay in the row: the owner sees their faces (per See my cards), others backs.
      render(node, el, ctx) {
        const l = look(node, ctx);
        el.innerHTML = cardHtml({ ...card(node), faceUp: l.up });
        if (l.raised) {
          el.firstElementChild?.classList.add('pc-raised');
          el.style.setProperty('--pc-owner', l.color);
        } else el.style.removeProperty('--pc-owner');
      },
      renderKey(node, ctx) {
        const l = look(node, ctx);
        return `${card(node).face}:${l.up}:${l.raised}:${l.color}`;
      },
      onDoubleClick: flipOne,
      // a card shown in a group or hand: dragging pulls it out (dropping it back reorders). Out of my
      // own hand I keep seeing what I saw; the table sees its real facing (a private card = a back).
      onDragStart(node, _down, app) {
        if (!app.doc.parentOf(node.id)) return;
        const h = handOf(app.doc, node);
        if (h && h.owner === app.viewer) ux.drag.set(node.id, { hand: h.id, saw: card(node).faceUp || ownerSees(h, node) });
        return app.dispatch('cards.pullOut', { id: node.id }).select?.[0];
      },
      onDragEnd(nodes) {
        if (!nodes.some((n) => ux.drag.delete(n.id))) return;
        queueMicrotask(() => app.view.render());
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
          const hand = isHand(node);
          const shown = hand ? cards.filter((c) => card(c).faceUp).length : 0;
          el.innerHTML = groupHtml(cards.length, { hand, home: isHomeDeck(node), label: kindName(node), color: f.color, mine: node.owner === viewer, shown, blind: isBlind(node), lane: hand ? RAISE : 0 });
          return;
        }
        const top = cards.at(-1);
        el.innerHTML = deckHtml(top && card(top), cards.length, isHomeDeck(node));
      },
      renderKey(node, { doc, viewer }) {
        const cards = cardsIn(doc, node.id);
        const top = cards.at(-1);
        const f = node[FIELD] as { color?: string };
        const shown = isHand(node) ? cards.filter((c) => card(c).faceUp).length : 0;
        return `${cards.length}:${shown}:${isBlind(node)}:${isHomeDeck(node)}:${layoutOf(node)}:${node.label}:${f.color}:${node.owner === viewer}:${top ? card(top).face + card(top).faceUp : ''}`;
      },
      onDoubleClick: flipOne,
      // Click on the tab (no drag): a small menu of deck actions anchored to it.
      onClick(node, down, app) {
        const tab = (down.target as Element | null)?.closest?.('[data-grip]');
        if (!tab) return false;
        app.view.openMenu(containerMenu(app, node, ux), tab, titleOf(node));
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

    const flipSel = (a: App) => {
      const sel = selectedCards(a);
      const r = a.dispatch('cards.flip', { ids: ids(sel), by: a.viewer });
      if (!r.changes.length && sel.some((n) => isHand(n) || !!handOf(a.doc, n))) a.notify(HAND_FLIP_HINT);
    };
    const shuffleSel = (a: App) => a.dispatch('cards.shuffle', { ids: ids(selectedCards(a).filter(isStacked)) });
    // `flipped`: the card comes out the other way up from how it lies in the deck
    const drawSel = (flipped = false) => (a: App) => {
      const d = targetDeck(a);
      if (d) a.dispatch('cards.draw', { id: d.id, faceUp: flipped ? !deckFacing(a.doc, d.id) : undefined, select: 'deck' });
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
    // L: the container under the mouse (or holding the card under it), else the selected one
    app.registerKey({
      key: 'l',
      label: 'Deck ⇄ group',
      run: (a) => {
        const h = a.view.hovered ? a.node(a.view.hovered) : undefined;
        const fromHover = h && (isDeck(h) ? h : a.node(a.doc.parentOf(h.id) ?? ''));
        const box = fromHover && isDeck(fromHover) ? fromHover : a.selected().filter(isDeck).at(-1);
        if (!box) return;
        if (isHand(box)) return a.notify(PRIVATE_NO_STACK);
        a.dispatch('cards.toggleStack', { id: box.id });
      },
    });
    const dealN = (count: number, flipped = false) => (a: App) => {
      const d = targetDeck(a);
      if (d) a.dispatch('cards.deal', { id: d.id, count, faceUp: flipped ? !deckFacing(a.doc, d.id) : undefined });
    };
    for (let k = 1; k <= 9; k++) {
      app.registerKey({ key: `${k}`, label: `Deal ${k}`, run: dealN(k) });
      app.registerKey({ key: `alt+${k}`, label: `Deal ${k} flipped`, run: dealN(k, true) });
    }

    app.registerMenu((a, sel) => {
      // empty table
      if (!sel.length) {
        const hands = a.doc.nodes.filter(isHand).length;
        return {
          title: 'Table',
          entries: [{ label: 'Put all hands on table (face up)', disabled: hands ? false : 'No hands on the table', run: () => a.dispatch('cards.showdown', {}) }],
        };
      }
      const cards = sel.filter(isCardish);
      if (!cards.length) return;
      if (sel.length === 1 && isDeck(sel[0])) return { title: titleOf(sel[0]), entries: containerMenu(a, sel[0], ux) };
      const loose = cards.filter(isCard);
      const decks = cards.filter(isStacked);
      const inHand = (n: CanvasNode) => isCard(n) && !!handOf(a.doc, n);
      const handCards = cards.filter(inHand);
      const entries: MenuEntry[] = [];
      if (handCards.length < cards.length) entries.push(facingMenu(a, () => ids(selectedCards(a).filter((n) => !inHand(n)))));
      if (handCards.length) entries.push(...showEntries(a, handCards));
      if (cards.length > 1) {
        const make = (layout?: 'stack', faceUp?: boolean) => () => a.dispatch('cards.gather', { ids: ids(selectedCards(a)), layout, faceUp });
        entries.push({
          label: 'Turn into',
          items: [
            { label: 'Deck', run: make('stack') },
            { label: 'Group', hint: 'G', run: make() },
            { label: 'Group, face down', run: make(undefined, false) },
            {
              label: 'Hand (others see backs)',
              run: () => {
                a.store.newUndoStep();
                a.store.merged(() => {
                  const g = a.dispatch('cards.gather', { ids: ids(selectedCards(a)) }).select?.[0];
                  if (g) a.dispatch('cards.turnInto', { id: g, kind: 'hand', owner: me(a).id, label: handLabelOf(me(a).name), color: me(a).color });
                });
              },
            },
          ],
        });
      }
      if (decks.length) {
        const d = decks.at(-1)!;
        entries.push(
          { label: 'Shuffle', hint: 'S', run: () => shuffleSel(a) },
          { label: 'Draw', hint: 'D', run: () => a.dispatch('cards.draw', { id: d.id, select: 'deck' }) },
          dealMenu(a, d.id),
        );
      }
      entries.push(...gatherEntry(a, cards.at(-1)));
      // a card shown in a group or hand: that container's actions too
      const parent = sel.length === 1 ? a.node(a.doc.parentOf(sel[0].id) ?? '') : undefined;
      if (parent && isDeck(parent)) entries.push({ label: titleOf(parent), separator: true, items: () => containerMenu(a, parent, ux) });
      const title = sel.length === 1 ? 'Card' : loose.length === sel.length ? `${sel.length} cards` : `${sel.length} selected`;
      return { title, entries };
    });
  },
};

export { commands } from './commands';
