import './cards.css';
import './standard';
import { loadPlayer, type App, type CanvasNode, type Command, type DocView, type MenuEntry, type Plugin, type Store } from '../../core';
import { DROP_ADD, SORT_MODES, commands, dropMode, incomingCount, kindOf, outCount, sortPrefOf, type DropMode, type Kind, type SortMode } from './commands';
import { CARD_W, FIELD, PACK, allowsShowing, areaOf, capacityOf, card, pileAt, hasFixedFrame, cardsIn, concealedFrom, deckFacing, deckIdOf, handOf, hiddenFrom, hidesCount, homeFor, isBlind, isCard, isCardish, isDeck, isHand, isHomeDeck, isShown, isSpot, isSpreadOut, isStacked, layoutOf, packOf, roomIn, shownIn, type Layout } from './deck';
import { mountHandUx, VIEW_AS_KEY, type HandUx } from './handUx';
import { repairImport, shapeExport } from './io';
import { cardLayouts, laneOf, liftedDrop, rowTop, slots, thresholdY } from './layout';
import { getPack } from './packs';
import { cardHtml, deckHtml, groupHtml, handHtml } from './render';

const LAYOUT_NAMES: Record<Exclude<Layout, 'stack'>, string> = { fan: 'Fan', row: 'Row', grid: 'Grid', column: 'Column', 'column-up': 'Column (upward)' };

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

/** Someone a hand can belong to: connected players (me first), and owners of hands who left (`away`). */
export interface Seat {
  id: string;
  name: string;
  color: string;
  away?: boolean;
}
const ownerNameOf = (h: CanvasNode) => h.label?.replace(/’s hand$|'s hand$/, '') || 'Someone';
export function seats(app: App): Seat[] {
  const out: Seat[] = [];
  const add = (p: Seat) => !out.some((x) => x.id === p.id) && out.push(p);
  const m = me(app);
  add({ id: m.id, name: m.name, color: m.color });
  for (const p of app.presence?.peers() ?? []) add({ id: p.id, name: p.name, color: p.color });
  for (const h of app.doc.nodes) if (isHand(h)) add({ id: h.owner!, name: ownerNameOf(h), color: (h[FIELD] as { color?: string }).color ?? '#888', away: true });
  return out;
}
/** The owner of `box` is not here (left the room; in solo play: anyone but me). */
export const ownerAway = (app: App, box: CanvasNode) => !!box.owner && box.owner !== app.viewer && !app.presence?.peers().some((p) => p.id === box.owner);
/** May I give this away? Its owner, anyone for an unowned group, anyone when the owner left. */
export const canGive = (app: App, box: CanvasNode) => !box.owner || box.owner === app.viewer || ownerAway(app, box);

/** One row per seat (color dot, "(you)", "(left)" greyed), `current` checked. */
function seatEntries(app: App, current: string | undefined, pick: (p: Seat) => void): MenuEntry[] {
  return seats(app).map((p) => ({
    label: `${p.name}${p.id === app.viewer ? ' (you)' : ''}${p.away ? ' (left)' : ''}`,
    color: p.color,
    muted: p.away,
    checked: current === undefined ? undefined : p.id === current,
    run: () => pick(p),
  }));
}

/** Give to ▸ players… / No one (public group). */
function giveMenu(app: App, box: CanvasNode): MenuEntry {
  const give = (to: Seat | null) => () =>
    app.dispatch('cards.give', { id: box.id, to: to?.id ?? null, label: to && handLabelOf(to.name), color: to?.color, by: app.viewer, ownerAway: ownerAway(app, box) });
  return {
    label: 'Give to',
    disabled: canGive(app, box) ? false : `Only ${ownerNameOf(box)} can give it away`,
    items: () => [...seatEntries(app, box.owner ?? '', (p) => give(p)()), { label: 'No one (public group)', separator: true, checked: !box.owner, run: give(null) }],
  };
}

/** New hand ▸ players (default: me). */
export function newHandFor(app: App, p: Seat, at?: { x: number; y: number }) {
  const vp = app.viewport;
  const root = app.view.root;
  // preferred spot: bottom middle of the view (or `at`); the command slides it into free space
  const [x, y] = at ? [at.x + 210, at.y + 230] : vp.toWorld(root.clientWidth / 2, root.clientHeight - 40);
  const res = app.dispatch('cards.newHand', { owner: p.id, label: handLabelOf(p.name), color: p.color, x: x - 210, y: y - 230 });
  const h = res.select?.[0] && app.node(res.select[0]);
  if (h) {
    const sx = h.x * vp.zoom + vp.x;
    const sy = h.y * vp.zoom + vp.y;
    const offscreen = sx < 0 || sy < 0 || sx + h.width * vp.zoom > root.clientWidth || sy + h.height * vp.zoom > root.clientHeight;
    if (offscreen) vp.set(root.clientWidth / 2 - (h.x + h.width / 2) * vp.zoom, root.clientHeight - (h.y + h.height) * vp.zoom - 40, vp.zoom);
  }
}
export const newHandEntries = (app: App, at?: { x: number; y: number }): MenuEntry[] => seatEntries(app, undefined, (p) => newHandFor(app, p, at));

/** What a container is called: "Deck", "Group", "Alice's hand" (menu titles, tabs). */
export function kindName(box: CanvasNode): string {
  const k = kindOf(box);
  if (k === 'hand') return box.label ?? 'Hand';
  if (isSpot(box) && box.label) return box.label; // a game's named spot ("Discard", "Flag 3 · A")
  return k === 'deck' ? 'Deck' : 'Group';
}
/** What a pile's tab says: a table spot its label ("Discard"), a home deck its pack's deck name ("Troops"). */
const deckName = (box: CanvasNode) => (isSpot(box) && box.label) || (isHomeDeck(box) && getPack(packOf(box))?.deckName) || 'Deck';

/**
 * A table spot's outline: where the next card goes (dotted past `slots`, e.g. a 4th card for
 * Mud), none when full. Relative to its frame. (Overlapping layouts would make all outlines a tangle.)
 */
function slotOutlines(doc: DocView, box: CanvasNode, count: number): { dx: number; dy: number; faint?: boolean }[] | undefined {
  const f = capacityOf(doc, box);
  if (!isSpot(box)) return;
  if (!f.slots) return []; // a spot without outlined slots: just its quiet frame
  const cap = Math.max(f.slots, f.max ?? 0);
  if (count >= cap) return [];
  const s = slots(layoutOf(box), count + 1, cap);
  // an upward column in a taller area (see cardLayouts) starts at the bottom
  const lift = layoutOf(box) === 'column-up' ? Math.max(0, box.height - s.h) : 0;
  const at = s.at[count];
  return [{ ...at, dy: at.dy + lift, faint: count >= f.slots }];
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

/**
 * A game's own deal for a deck (e.g. Battle Line's troops: Deal Battle Line deals to the players'
 * hands): replaces Deal ▸ in the deck's menus, and the 1–9 keys on it say what to do instead.
 */
export type DealOverride = (deck: CanvasNode, app: App) => { entry: MenuEntry; keyHint: string } | undefined;
const dealOverrides: DealOverride[] = [];
export const registerDealOverride = (o: DealOverride) => void dealOverrides.push(o);
const dealOverride = (app: App, id: string) => {
  const d = app.node(id);
  for (const o of dealOverrides) {
    const r = d && o(d, app);
    if (r) return r;
  }
};

/**
 * Drop routing: a game sends a card dropped on one of its spots to where it belongs (Battle Line:
 * Fog on a formation → that flag's environment spot). `to` = the container it goes into, `label` =
 * what the target shows while hovering, `after` runs after the drop (warnings). Single cards only.
 */
export interface DropRoute {
  to: string;
  label?: string;
  after?: () => void;
}
export type DropRouter = (target: CanvasNode, dropped: CanvasNode[], app: App) => DropRoute | undefined;
const dropRouters: DropRouter[] = [];
export const registerDropRouter = (r: DropRouter) => void dropRouters.push(r);
export function routeFor(target: CanvasNode, dropped: CanvasNode[], app: App): DropRoute | undefined {
  if (dropped.length !== 1 || !isCard(dropped[0])) return;
  for (const r of dropRouters) {
    const out = r(target, dropped, app);
    if (out) return out;
  }
}

/** A short note a game adds to a container's tab (e.g. a count). Global, like packs. */
export type TabNote = (box: CanvasNode, doc: DocView) => string | undefined;
const tabNotes: TabNote[] = [];
export const registerTabNote = (t: TabNote) => void tabNotes.push(t);
const tabNote = (box: CanvasNode, doc: DocView) => tabNotes.map((t) => t(box, doc)).filter(Boolean).map((s) => ` · ${s}`).join('');

/** Deal ▸ 1, 2, 3, 5, 7, N… from deck `id` (or a game's own deal). */
function dealMenu(app: App, id: string): MenuEntry {
  const own = dealOverride(app, id);
  if (own) return own.entry;
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
  const locked = kind === 'hand' && !canGive(app, box) ? `Only ${ownerNameOf(box)} can make it public` : false;
  const to = (k: Kind) => () => app.dispatch('cards.turnInto', { id, kind: k, owner: me(app).id, label: handLabelOf(me(app).name), color: me(app).color });
  const hand: MenuEntry = isHomeDeck(box)
    ? { label: 'Hand', disabled: 'The home deck stays public (gather all fills it)' }
    : kind === 'hand'
      ? { label: 'Hand', checked: true, disabled: true }
      : { label: 'Hand for', items: () => seatEntries(app, undefined, (p) => app.dispatch('cards.turnInto', { id, kind: 'hand', owner: p.id, label: handLabelOf(p.name), color: p.color })) };
  return {
    label: 'Turn into',
    items: [
      { label: kind === 'hand' ? 'Deck (makes it public)' : 'Deck', hint: kind === 'group' ? 'L' : undefined, checked: kind === 'deck', disabled: kind === 'deck' || locked, run: to('deck') },
      { label: kind === 'hand' ? 'Group (makes it public)' : 'Group', hint: kind === 'deck' ? 'L' : undefined, checked: kind === 'group', disabled: kind === 'group' || locked, run: to('group') },
      hand,
    ],
  };
}

/** Layout ▸ Fan / Row / Grid for groups; a hand is a fan or a row (its frame is fixed). */
function layoutMenu(app: App, box: CanvasNode): MenuEntry {
  const cur = isHand(box) && layoutOf(box) === 'grid' ? 'row' : layoutOf(box);
  const options = isHand(box) ? (['fan', 'row'] as const) : (['fan', 'row', 'grid'] as const);
  return {
    label: 'Layout',
    items: options.map((l) => ({ label: LAYOUT_NAMES[l], checked: cur === l, run: () => app.dispatch('cards.setLayout', { id: box.id, layout: l }) })),
  };
}

const HAND_FLIP_HINT = 'Flipping never shows a hand card to the table: right-click ▸ Show to table';
const TURN_ON_SHOWING = 'Turn on Visibility ▸ Allow showing cards to table in the hand’s menu';
const showColor = (h: CanvasNode) => (h[FIELD] as { color?: string }).color ?? '#2f4b7c';
const ownerOnly = (h: CanvasNode) => `Only ${h.label?.replace(/’s hand$|'s hand$/, '') || 'its owner'} can show these cards`;

/** "Show to table" / "Hide from table" wording, with the count when more than one. */
export function showLabel(shown: boolean, n: number): string {
  const k = n > 1 ? ` ${n}` : '';
  return shown ? `Show${k} to table` : `Hide${k} from table`;
}

/** Show to table / Hide from table for cards in hands (multi-select: counts), plus "Flip for me" in a blind hand. */
function showEntries(app: App, cards: CanvasNode[]): MenuEntry[] {
  const mine = cards.filter((c) => handOf(app.doc, c)?.owner === app.viewer);
  if (!mine.length) return [{ label: 'Show to table', disabled: ownerOnly(handOf(app.doc, cards[0])!) }];
  const out: MenuEntry[] = [];
  const can = mine.filter((c) => allowsShowing(handOf(app.doc, c)!));
  if (!can.length) out.push({ label: 'Show to table', disabled: TURN_ON_SHOWING });
  else {
    const priv = can.filter((c) => !isShown(app.doc, c));
    const shown = can.filter((c) => isShown(app.doc, c));
    if (priv.length) out.push({ label: showLabel(true, priv.length), run: () => app.dispatch('cards.show', { ids: ids(priv), shown: true, by: app.viewer }) });
    if (shown.length) out.push({ label: showLabel(false, shown.length), run: () => app.dispatch('cards.show', { ids: ids(shown), shown: false, by: app.viewer }) });
  }
  const blindPrivate = mine.filter((c) => !isShown(app.doc, c) && isBlind(handOf(app.doc, c)!));
  if (blindPrivate.length) out.push({ label: 'Flip for me (others still see the back)', hint: 'F', run: () => app.dispatch('cards.flip', { ids: ids(blindPrivate), by: app.viewer }) });
  return out;
}

/** A hand's own entries: show / hide all, then its options. Only the owner gets them. */
function handMenu(app: App, box: CanvasNode, ux: HandUx): MenuEntry[] {
  if (box.owner !== app.viewer) return canGive(app, box) ? [giveMenu(app, box)] : [];
  const cards = cardsIn(app.doc, box.id);
  const shown = cards.filter((c) => shownIn(box, c)).length;
  const out: MenuEntry[] = [];
  if (allowsShowing(box))
    out.push(
      { label: 'Show all to table', disabled: shown < cards.length ? false : 'Nothing private', run: () => app.dispatch('cards.show', { ids: [box.id], shown: true, by: app.viewer }) },
      { label: 'Hide all from table', disabled: shown ? false : 'Nothing shown', run: () => app.dispatch('cards.show', { ids: [box.id], shown: false, by: app.viewer }) },
    );
  const toggle = (cmd: string, on: boolean) => () => app.dispatch(cmd, { id: box.id, on });
  const fixed = (box[FIELD] as { fixed?: boolean }).fixed === true;
  out.push(
    {
      label: 'Visibility',
      separator: true,
      items: () => [
        { label: 'See my cards', checked: !isBlind(box), run: toggle('cards.seeMine', isBlind(box)) },
        { label: 'Allow showing cards to table', checked: allowsShowing(box), run: toggle('cards.allowShowing', !allowsShowing(box)) },
        hidesCount(box)
          ? { label: 'Fixed frame size', checked: true, disabled: 'Needed while the count is hidden' }
          : { label: 'Fixed frame size', checked: fixed, run: toggle('cards.fixedFrame', !fixed) },
        { label: 'Hide card count', checked: hidesCount(box), run: toggle('cards.hideCount', !hidesCount(box)) },
      ],
    },
    { label: 'View as others', hint: `hold ${VIEW_AS_KEY}`, checked: ux.sticky(), run: () => ux.toggle() },
    giveMenu(app, box),
  );
  return out;
}

const SORT_NAMES: Record<SortMode, string> = { suit: 'By suit, then rank', rank: 'By rank, then suit', rankOnly: 'By rank only', reverse: 'Reverse current order' };
/** Sort ▸ modes (the remembered one checked) + Ace high; "Sort again" repeats the remembered mode. */
function sortMenu(app: App, box: CanvasNode): MenuEntry {
  const pref = sortPrefOf(box);
  const run = (a: { mode?: SortMode; aceHigh?: boolean }) => () => app.dispatch('cards.sort', { id: box.id, ...a });
  return {
    label: 'Sort',
    items: () => [
      { label: `Sort again (${SORT_NAMES[pref.mode].toLowerCase()})`, run: run({}) },
      ...SORT_MODES.map((m, i): MenuEntry => ({ label: SORT_NAMES[m], checked: pref.mode === m, separator: i === 0, run: run({ mode: m }) })),
      { label: 'Ace high', separator: true, checked: pref.aceHigh, run: run({ aceHigh: !pref.aceHigh }) },
    ],
  };
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
  } else out.push(sortMenu(app, box));
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
    // a whole pack, face up in pack order, laid out as a grid (the grid is the home deck)
    app.registerKit({ id: 'cards.deck', label: 'Deck of cards', create: (a, at) => a.dispatch('cards.addPack', { pack: PACK, ...at }) });

    // drop classification, shown on the target while hovering: Stack / Fan / Add to …
    const LABEL: Record<DropMode, (t: CanvasNode, app: App) => string> = {
      stack: () => 'Stack',
      fan: () => 'Fan',
      add: (t, app) => {
        const box = isDeck(t) ? t : app.node(app.doc.parentOf(t.id) ?? '');
        return !box ? 'Add' : isSpot(box) && box.label ? `Add to ${box.label}` : isHomeDeck(box) ? 'Add to deck' : isStacked(box) ? 'Add to pile' : isHand(box) ? 'Add to hand' : 'Add to group';
      },
    };
    /** A drag of one card from my own hand back into it (a rearrange, or a drag up / down to show / hide). */
    const ownMove = (t: CanvasNode, dropped: CanvasNode[], app: App) =>
      dropped.length === 1 && isHand(t) && t.owner === app.viewer && app.doc.parentOf(dropped[0].id) === t.id ? t : undefined;
    const canDrop = (t: CanvasNode, dropped: CanvasNode[], app: App, overlap: number) => {
      // a table spot (a formation, a mat's zone) is never dropped into anything: it stays a spot
      if (!dropped.some(isCardish) || dropped.some(isSpot)) return false;
      const route = overlap >= DROP_ADD ? routeFor(t, dropped, app) : undefined;
      if (route) {
        const box = app.node(route.to);
        if (!box || incomingCount(app.doc, box, dropped) > roomIn(app.doc, box)) return false;
        if (route.label) return route.label;
      }
      const mode = dropMode(app.doc, t, overlap);
      if (!mode) return false;
      // a container with a `max` (a table spot) refuses more than it has room for
      const box = mode === 'add' ? (isDeck(t) ? t : app.node(app.doc.parentOf(t.id) ?? '')) : undefined;
      if (box && incomingCount(app.doc, box, dropped) > roomIn(app.doc, box)) return false;
      const h = mode === 'add' && ownMove(t, dropped, app);
      if (h) {
        if (!allowsShowing(h)) return 'Rearrange';
        const was = shownIn(h, app.node(dropped[0].id)!);
        return liftedDrop(h, dropped[0].y) ? (was ? 'Shown to table' : 'Show to table') : was ? 'Hide from table' : 'Rearrange';
      }
      return LABEL[mode](t, app);
    };
    const onDrop = (target: CanvasNode, dropped: string[], app: App, at: { x: number; y: number }, mode?: string) => {
      const nodes = dropped.map((id) => app.node(id)).filter((n): n is CanvasNode => !!n);
      const route = routeFor(target, nodes, app);
      if (route && route.to !== target.id && route.to !== app.doc.parentOf(target.id)) {
        app.dispatch('cards.drop', { target: route.to, ids: dropped });
        route.after?.();
        return;
      }
      const h = ownMove(target, nodes, app);
      const box = h && (app.view.dragBox(nodes[0].id) ?? nodes[0]);
      const shown = h && box && allowsShowing(h) ? liftedDrop(h, box.y) : undefined;
      app.dispatch('cards.drop', { target: target.id, ids: dropped, at, as: mode === 'Stack' ? 'stack' : mode === 'Fan' ? 'fan' : undefined, shown });
      route?.after?.();
    };
    const flipOne = (node: CanvasNode, app: App) => {
      if (isHand(node)) return app.notify(HAND_FLIP_HINT);
      const r = app.dispatch('cards.flip', { ids: [node.id], by: app.viewer });
      if (!r.changes.length && handOf(app.doc, node)) app.notify(HAND_FLIP_HINT);
    };
    /** How a card looks to this viewer: face or back; shown to the table (in whose color); in a hand. */
    const look = (node: CanvasNode, { doc, viewer }: { doc: typeof app.doc; viewer: string }) => {
      const h = handOf(doc, node);
      const up = h ? !hiddenFrom(doc, node, viewer, ux.asOthers()) : card(node).faceUp;
      return { up, shown: !!h && shownIn(h, node), color: h ? showColor(h) : '', inHand: !!h };
    };
    /** Briefly outline a card that just landed on the table, so you notice it's not in a hand. */
    const flashLanded = (id: string) =>
      requestAnimationFrame(() => {
        const b = app.view.boxOf(id);
        if (!b) return;
        b.classList.add('pc-landed');
        setTimeout(() => b.classList.remove('pc-landed'), 1200);
      });
    const nearHand = (n: CanvasNode) =>
      app.doc.nodes.some((h) => isHand(h) && n.x < h.x + h.width + 60 && n.x + n.width > h.x - 60 && n.y < h.y + h.height + 60 && n.y + n.height > h.y - 60);
    // who's here decides which hands are "away" (greyed, reassignable): re-render when that changes
    let peersKey = '';
    let hooked = false;
    const hookPresence = () => {
      if (hooked || !app.presence) return;
      hooked = true;
      app.presence.onChange(() => {
        const k = app.presence!.peers().map((p) => p.id).sort().join();
        if (k === peersKey) return;
        peersKey = k;
        app.view.render();
      });
    };
    const homeBox = (node: CanvasNode) => app.view.boxOf(app.doc.parentOf(node.id) ?? '');
    /** Drag the hand's right edge: its width (one undo step); the cards compress or spread to fit. */
    const resizeFrom = (id: string, e: PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const h0 = app.node(id);
      if (!h0) return;
      const x0 = e.clientX;
      const zoom = app.viewport.zoom;
      app.store.newUndoStep();
      const move = (ev: PointerEvent) => app.dispatch('cards.resizeHand', { id, width: h0.width + (ev.clientX - x0) / zoom }, { merge: true });
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };

    app.registerType({
      id: 'card',
      match: isCard,
      // In a hand: shown cards (strip above the row) glow in the owner's color, for everyone; private
      // cards: the owner sees their faces (per See my cards), others backs (or nothing: Hide card count).
      render(node, el, ctx) {
        const l = look(node, ctx);
        el.innerHTML = cardHtml({ ...card(node), faceUp: l.up });
        if (l.shown) {
          el.firstElementChild?.classList.add('pc-raised');
          el.style.setProperty('--pc-owner', l.color);
        } else el.style.removeProperty('--pc-owner');
        el.toggleAttribute('data-inhand', l.inHand);
      },
      renderKey(node, ctx) {
        const l = look(node, ctx);
        return `${card(node).face}:${l.up}:${l.shown}:${l.color}:${l.inHand}`;
      },
      concealed: (node, { doc, viewer }) => concealedFrom(doc, node, viewer, ux.asOthers()),
      onDoubleClick: flipOne,
      // a card in a hand moves only on its owner's screen until it's dropped: nobody sees it travel
      dragsLocally: (node, app) => !!handOf(app.doc, node),
      onLocalDrag(node, phase) {
        homeBox(node)?.classList.toggle('pc-drag-home', phase === 'start');
      },
      onLocalDrop(node, at, app) {
        app.dispatch('cards.pullOut', { id: node.id, x: at.x, y: at.y });
        flashLanded(node.id);
      },
      // over a card in a hand, the drop goes to the hand (the frame lights up "Add to hand")
      dropProxy: (node, app) => handOf(app.doc, node)?.id,
      // a card shown in a group: dragging pulls it out (dropping it back reorders)
      onDragStart(node, _down, app) {
        if (!app.doc.parentOf(node.id)) return;
        return app.dispatch('cards.pullOut', { id: node.id }).select?.[0];
      },
      onDragEnd(nodes, _app, target, via) {
        if (via !== 'drag' || target) return;
        for (const n of nodes) if (!app.doc.parentOf(n.id) && nearHand(n)) flashLanded(n.id);
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
          if (!isHand(node)) {
            const cap = capacityOf(doc, node);
            const over = cap.max !== undefined && cards.length > cap.max;
            el.innerHTML = groupHtml(cards.length, { hand: false, home: isHomeDeck(node), label: kindName(node) + tabNote(node, doc), color: f.color, slots: slotOutlines(doc, node, cards.length), over });
            return;
          }
          hookPresence();
          const mine = node.owner === viewer;
          const asOthers = !mine || ux.asOthers();
          el.innerHTML = handHtml({
            label: kindName(node),
            color: f.color,
            mine,
            away: ownerAway(app, node),
            resizable: mine && hasFixedFrame(node) && !areaOf(node),
            count: asOthers && hidesCount(node) ? undefined : cards.length,
            shown: cards.filter((c) => shownIn(node, c)).length,
            pile: asOthers && hidesCount(node),
            blind: isBlind(node),
            lane: laneOf(node),
            threshold: thresholdY(node) - node.y,
            rowTop: rowTop(node),
          });
          if (mine) el.querySelector('.pc-resize')?.addEventListener('pointerdown', (e) => resizeFrom(node.id, e as PointerEvent));
          return;
        }
        const top = cards.at(-1);
        const pile = deckHtml(top && card(top), cards.length, isHomeDeck(node), deckName(node));
        if (!areaOf(node)) {
          el.innerHTML = pile;
          return;
        }
        // a pile in a fixed area (a mat's zone): the area's frame, the pile in its middle
        const p = pileAt(node);
        const f = node[FIELD] as { color?: string };
        el.innerHTML =
          `<div class="pc-group pc-spot pc-area"${f.color ? ` style="--pc-group:${f.color}"` : ''}>` +
          `<div class="pc-area-pile" style="left:${p.x - node.x}px;top:${p.y - node.y}px">${pile}</div></div>`;
      },
      renderKey(node, { doc, viewer }) {
        const cards = cardsIn(doc, node.id);
        const top = cards.at(-1);
        const f = node[FIELD] as { color?: string };
        if (isHand(node)) {
          const shown = cards.filter((c) => shownIn(node, c)).length;
          return `hand:${ownerAway(app, node)}:${cards.length}:${shown}:${isBlind(node)}:${allowsShowing(node)}:${hidesCount(node)}:${hasFixedFrame(node)}:${ux.asOthers()}:${node.label}:${f.color}:${node.owner === viewer}:${layoutOf(node)}`;
        }
        const cap = capacityOf(doc, node);
        return `${cards.length}:${isHomeDeck(node)}:${layoutOf(node)}:${node.label}:${f.color}:${node.owner === viewer}:${top ? card(top).face + card(top).faceUp : ''}:${node.width}x${node.height}:${cap.slots}:${cap.max}:${tabNote(node, doc)}`;
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
        return app.dispatch('cards.draw', { id: node.id, ...pileAt(node) }).select?.[0];
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
      const own = d && dealOverride(a, d.id);
      if (own) return a.notify(own.keyHint);
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
          entries: [
            { label: 'New hand for', items: () => newHandEntries(a, a.view.menuPoint ?? undefined) },
            { label: 'Put all hands on table (face up)', disabled: hands ? false : 'No hands on the table', run: () => a.dispatch('cards.showdown', {}) },
          ],
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
              label: 'Hand for',
              items: () =>
                seatEntries(a, undefined, (p) => {
                  a.store.newUndoStep();
                  a.store.merged(() => {
                    const g = a.dispatch('cards.gather', { ids: ids(selectedCards(a)) }).select?.[0];
                    if (g) a.dispatch('cards.turnInto', { id: g, kind: 'hand', owner: p.id, label: handLabelOf(p.name), color: p.color });
                  });
                }),
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
