import { isIds, isNum, pick, set, toFront, type CanvasNode, type Change, type Command, type CommandResult, type DocView, type Events } from '../../core';
import { dealEvent, dealHandsEvent, drawEvent, facingEvents, giveEvent, moveEvents, putOnTableEvent, recallEvent, showEvents, showdownEvent, shuffleEvents } from './events';
import { PACK, CARD_H, CARD_W, FIELD, RANKS, areaOf, enterOf, pileAt, allowsShowing, card, hidesCount, isBlind, shownIn, cardNode, cardsHomedAt, cardsIn, deckNode, groupNode, isCard, isCardish, isDeck, isHand, isHomeDeck, isSpreadOut, isStacked, isSpot, layoutOf, packOf, parseFace, roomIn, standardDeck, type DeckField, type Layout } from './deck';
import { HAND_MAX_W, HAND_MIN_W, PAD, RAISE, emptyHandSize, handSizeFor, handSlotIndex, laneOf, slotIndex, slots } from './layout';
import { getPack, packOrder } from './packs';

/**
 * How a drop would land (shown while hovering, then passed to `drop`). Onto a container, or a card
 * shown in one: added to it from 30% overlap. Onto a loose card: ≥ 75% overlap (dropped squarely,
 * pointer near its center) = a stack (subdeck); 30–75% (offset) = a fan group; less = nothing.
 * Overlap = intersection over the smaller box.
 */
export const DROP_ADD = 0.3;
export const DROP_FAN = 0.3;
export const DROP_STACK = 0.75;
export type DropMode = 'stack' | 'fan' | 'add';
export function dropMode(doc: DocView, target: CanvasNode, overlap: number): DropMode | null {
  const parent = isCard(target) ? doc.parentOf(target.id) : undefined;
  if (isDeck(target) || parent) return overlap >= DROP_ADD ? 'add' : null;
  if (!isCard(target)) return null;
  if (overlap >= DROP_STACK) return 'stack';
  return overlap >= DROP_FAN ? 'fan' : null;
}

// Pure commands: (read-only doc, args, ctx) -> per-field changes. No DOM. Bad args = no-op.
// Cards live as separate nodes; "in a deck" = `x-cards.stack` points at the deck. Moving a card
// between decks/table only rewrites that card's own fields, so concurrent draws can't duplicate it.

const F = (k: string) => `${FIELD}.${k}`;
/** A result with events (logged only if something changed). */
const logged = (r: CommandResult | Change[], events: Events): CommandResult => {
  const res = Array.isArray(r) ? { changes: r } : r;
  return res.changes.length ? { ...res, events } : res;
};
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const okColor = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined);

export function shuffled<T>(xs: readonly T[], random: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Take a card out of its deck onto the table at (x, y). */
const release = (c: CanvasNode, x: number, y: number, z: number): Change[] => [
  set(c.id, F('stack'), undefined),
  set(c.id, F('order'), undefined),
  set(c.id, 'x', x),
  set(c.id, 'y', y),
  set(c.id, 'z', z),
];

/** Put a card into a deck at `order`. Its x/y follow the deck so exports stay sensible. */
const stackInto = (c: CanvasNode, deck: CanvasNode, order: number): Change[] => [
  set(c.id, F('stack'), deck.id),
  set(c.id, F('order'), order),
  set(c.id, 'x', deck.x),
  set(c.id, 'y', deck.y),
];

/** Containers that stay when emptied: a home deck (an empty slot), a hand, a table spot. Groups go. */
const persists = (c: CanvasNode) => isHomeDeck(c) || isHand(c) || isSpot(c);

/** A container that just lost its last card: a group disappears, a home deck or hand stays. */
const emptied = (deck: CanvasNode): Change[] => (persists(deck) ? [] : [{ op: 'del', id: deck.id }]);

/**
 * After cards leave a container: empty → `emptied`; a group down to one card dissolves into that
 * loose card, left where it was shown. `left` = the cards still in it.
 */
const shrunk = (deck: CanvasNode, left: CanvasNode[]): Change[] => {
  if (!left.length) return emptied(deck);
  if (left.length === 1 && !persists(deck)) {
    const [c] = left;
    const pos = isStacked(deck) ? deck : c; // in a spread-out group the card's shown position
    return [...release(c, pos.x, pos.y, Math.floor(deck.z ?? 0)), { op: 'del', id: deck.id }];
  }
  return [];
};

/** Orders that put `n` new cards at `index` among `cards` (sorted), without touching the others. */
function ordersAt(cards: CanvasNode[], index: number, n: number): number[] {
  const o = (i: number) => card(cards[i]).order ?? 0;
  const lo = index > 0 ? o(index - 1) : cards.length ? o(0) - 1 : 0;
  const hi = index < cards.length ? o(index) : lo + n + 1;
  return Array.from({ length: n }, (_, k) => lo + ((hi - lo) * (k + 1)) / (n + 1));
}

/** Put `moving` (cards, or containers whose cards come along) into `box` at `index` (default: on top). */
function insertInto(doc: DocView, box: CanvasNode, moving: CanvasNode[], index?: number): Change[] {
  const already = new Set(moving.flatMap((n) => (isDeck(n) ? cardsIn(doc, n.id) : [n])).map((c) => c.id));
  const inBox = cardsIn(doc, box.id).filter((c) => !already.has(c.id));
  const incoming = moving.flatMap((n) => (isDeck(n) ? cardsIn(doc, n.id) : [n])).filter((c) => doc.parentOf(c.id) !== box.id || already.has(c.id));
  const at = index === undefined ? inBox.length : Math.max(0, Math.min(inBox.length, index));
  const orders = ordersAt(inBox, at, incoming.length);
  const changes = incoming.flatMap((c, i) => stackInto(c, box, orders[i]));
  // a hand without a shown strip holds private cards only (so turning the strip on never reveals one)
  if (isHand(box) && !allowsShowing(box)) for (const c of incoming) changes.push(...conform(c, false));
  // a container with a facing on entry (a mat zone, a Battle Line formation) turns what comes in
  const enter = enterOf(box);
  if (enter && !isHand(box)) for (const c of incoming) changes.push(...conform(c, enter === 'up'));
  // containers merged away, and groups the cards were pulled out of
  const touched = new Set<string>();
  for (const n of moving) {
    if (isDeck(n) && n.id !== box.id) {
      changes.push(...emptied(n));
      touched.add(n.id);
    }
  }
  for (const c of incoming) {
    const from = doc.parentOf(c.id);
    if (!from || from === box.id || touched.has(from)) continue;
    touched.add(from);
    const src = doc.get(from)!;
    changes.push(...shrunk(src, cardsIn(doc, from).filter((x) => !already.has(x.id))));
  }
  return changes;
}

/** Card entering a stack takes its facing. Its home never changes here. */
const conform = (c: CanvasNode, faceUp: boolean): Change[] => (card(c).faceUp !== faceUp ? [set(c.id, F('faceUp'), faceUp)] : []);

const topOrder = (doc: DocView, deckId: string) => {
  const cs = cardsIn(doc, deckId);
  return cs.length ? (card(cs[cs.length - 1]).order ?? 0) : 0;
};

/** In a hand: a card shown to the table can't be flipped; private cards only via `by` in a blind hand. */
const handOfCard = (doc: DocView, c: CanvasNode) => {
  const p = doc.parentOf(c.id);
  const h = p ? doc.get(p) : undefined;
  return h && isHand(h) ? h : undefined;
};

/**
 * Flip cards; flipping a deck turns the whole pile over (order reverses). Never reveals a hand card:
 * cards in a hand are skipped (showing is `show`), except that the hand's owner (`by`) flips a private
 * card of a blind hand between "face up for me" and "face down for me" (nobody else sees it either way).
 */
export const flip: Command<{ ids: string[]; by?: string }> = (doc, a) =>
  logged(flipChanges(doc, a), (after) => facingEvents(doc, after, a.ids));
const flipChanges = (doc: DocView, a: { ids: string[]; by?: string }): Change[] =>
  pick(doc, a?.ids).flatMap((n) => {
    if (isHand(n)) return [];
    if (isCard(n)) {
      const h = handOfCard(doc, n);
      if (!h) return [set(n.id, F('faceUp'), !card(n).faceUp)];
      if (!a.by || h.owner !== a.by || !isBlind(h) || card(n).faceUp) return [];
      return [set(n.id, F('mine'), card(n).mine === false ? undefined : false)];
    }
    // turning a pile over reverses it; a spread-out group just flips each card in place
    if (isStacked(n))
      return cardsIn(doc, n.id).flatMap((c) => [set(c.id, F('faceUp'), !card(c).faceUp), set(c.id, F('order'), -(card(c).order ?? 0))]);
    if (isDeck(n)) return cardsIn(doc, n.id).map((c) => set(c.id, F('faceUp'), !card(c).faceUp));
    return [];
  });

/**
 * Show hand cards to the table (`shown: true`: face up, drawn raised) or hide them again. `ids`: cards
 * in hands and/or whole hands. `by`: only hands this player owns. Cards outside hands are untouched.
 */
export const show: Command<{ ids: string[]; shown: boolean; by?: string }> = (doc, a) => {
  if (!isBool(a?.shown)) return [];
  const seen = new Set<string>();
  const ok = (h: CanvasNode | undefined): h is CanvasNode => !!h && isHand(h) && allowsShowing(h) && (!a.by || h.owner === a.by);
  const changes = pick(doc, a.ids).flatMap((n) => {
    const cards = isHand(n) ? (ok(n) ? cardsIn(doc, n.id) : []) : isCard(n) && ok(handOfCard(doc, n)) ? [n] : [];
    return cards.filter((c) => !seen.has(c.id) && !!seen.add(c.id)).flatMap((c) => conform(c, a.shown));
  });
  return logged(changes, (after) => showEvents(doc, after));
};

/**
 * "Allow showing cards to table" on a hand. Either way every card ends private (turning it on never
 * reveals a card; turning it off hides the shown ones back into the row), in one step. The frame grows
 * / shrinks the strip upward so the row stays where it is.
 */
export const allowShowing: Command<{ id: string; on: boolean }> = (doc, a) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isHand(box) || !isBool(a.on) || allowsShowing(box) === a.on) return [];
  return [
    set(box.id, F('showing'), a.on ? true : undefined),
    set(box.id, 'y', box.y + (a.on ? -RAISE : RAISE)),
    ...cardsIn(doc, box.id).flatMap((c) => conform(c, false)),
  ];
};

/** "Hide card count": others see a generic pile instead of the private cards. */
export const hideCount: Command<{ id: string; on: boolean }> = (doc, a) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isHand(box) || !isBool(a.on) || hidesCount(box) === a.on) return [];
  return [set(box.id, F('hideCount'), a.on ? true : undefined)];
};

/** "Fixed frame size": the frame keeps its width whatever the count (cards squeeze to fit). Stays on while the count is hidden. */
export const fixedFrame: Command<{ id: string; on: boolean }> = (doc, a) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isHand(box) || !isBool(a.on) || ((box[FIELD] as DeckField).fixed === true) === a.on) return [];
  return [set(box.id, F('fixed'), a.on ? true : undefined)];
};

/** Resize a hand's frame (its cards compress or spread to fit). */
export const resizeHand: Command<{ id: string; width: number }> = (doc, a) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isHand(box) || !isNum(a.width)) return [];
  return [set(box.id, F('width'), Math.max(HAND_MIN_W, Math.min(HAND_MAX_W, Math.round(a.width))))];
};

/** "See my cards" on a hand: on (default) = the owner sees every private card; off = a blind hand. */
export const seeMine: Command<{ id: string; on: boolean }> = (doc, a) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isHand(box) || !isBool(a.on) || isBlind(box) === !a.on) return [];
  return [set(box.id, F('blind'), a.on ? undefined : true)];
};

/** Turn cards (and every card in the given decks) face up or face down, whatever they are now. */
export const face: Command<{ ids: string[]; faceUp: boolean }> = (doc, a) => {
  if (!isBool(a?.faceUp)) return [];
  const changes = pick(doc, a.ids).flatMap((n) => {
    if (isCard(n) && doc.isVisible(n.id)) return conform(n, a.faceUp);
    if (isDeck(n)) return cardsIn(doc, n.id).flatMap((c) => conform(c, a.faceUp));
    return [];
  });
  return logged(changes, (after) => facingEvents(doc, after, a.ids));
};

/** Move to an absolute position (x, y) or by (dx, dy). Decks move as one node. */
export const move: Command<{ ids: string[]; x?: number; y?: number; dx?: number; dy?: number }> = (doc, a) =>
  pick(doc, a?.ids)
    .filter((n) => !doc.parentOf(n.id))
    .flatMap((n) => [
      set(n.id, 'x', Math.round(isNum(a.x) ? a.x : n.x + (isNum(a.dx) ? a.dx : 0))),
      set(n.id, 'y', Math.round(isNum(a.y) ? a.y : n.y + (isNum(a.dy) ? a.dy : 0))),
    ]);

export const shuffle: Command<{ ids: string[] }> = (doc, a, ctx) => {
  const decks = pick(doc, a?.ids).filter((d) => isDeck(d) && cardsIn(doc, d.id).length > 1);
  return logged(
    decks.flatMap((d) => shuffled(cardsIn(doc, d.id), ctx.random).map((c, i) => set(c.id, F('order'), i + 1))),
    shuffleEvents(decks),
  );
};

/**
 * Take the top card off a deck. Lands at (x, y) or in the first free slot right of the deck.
 * `faceUp` overrides the card's orientation. `select`: what to select afterwards (default: the card;
 * "deck" keeps the deck selected so repeated draws deal). Drawing the last card removes the deck.
 */
export const draw: Command<{ id: string; faceUp?: boolean; x?: number; y?: number; select?: 'card' | 'deck' }> = (doc, a) => {
  const deck = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!deck || !isDeck(deck)) return [];
  const cards = cardsIn(doc, deck.id);
  const top = cards[cards.length - 1];
  if (!top) return [];
  const pile = pileAt(deck);
  const y = isNum(a.y) ? a.y : pile.y;
  let x = isNum(a.x) ? a.x : undefined;
  if (x === undefined) {
    x = pile.x + CARD_W + 24;
    while (doc.visible.some((n) => n.x === x && n.y === y)) x += 32;
  }
  const changes = release(top, Math.round(x), Math.round(y), doc.topZ + 1);
  if (isBool(a.faceUp)) changes.push(set(top.id, F('faceUp'), a.faceUp));
  const rest = cards.slice(0, -1);
  changes.push(...shrunk(deck, rest));
  const deckLeft = rest.length > 1 || (rest.length === 1 && persists(deck));
  return { changes, select: a.select === 'deck' && deckLeft ? [deck.id] : [top.id], events: (after) => [drawEvent(deck, top, after)] };
};

/**
 * Deal the top `count` cards (1-52) into a small fanned row next to the deck, in the first free spot
 * to its right. `faceUp` overrides orientation (default: as they lie in the deck). Keeps the deck selected.
 */
export const deal: Command<{ id: string; count: number; faceUp?: boolean }> = (doc, a) => {
  let deck = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!deck || !isDeck(deck) || !isNum(a.count) || a.count < 1) return [];
  const cards = cardsIn(doc, deck.id);
  const n = Math.min(Math.floor(a.count), 52, cards.length);
  if (!n) return [];
  const p = pileAt(deck);
  deck = { ...deck, x: p.x, y: p.y };
  const step = 30;
  const span = (n - 1) * step + CARD_W;
  const at = deck;
  const others = doc.visible.filter((v) => v.id !== at.id);
  const hits = (x: number) => others.some((v) => v.x < x + span && v.x + v.width > x && v.y < at.y + CARD_H && v.y + v.height > at.y);
  let x0 = deck.x + CARD_W + 24;
  for (let i = 0; i < 40 && hits(x0); i++) x0 += 40;
  const faceUp = isBool(a.faceUp) ? a.faceUp : undefined;
  const mid = (n - 1) / 2;
  const dealt = cards.slice(-n).reverse(); // top card first, leftmost
  const changes = dealt.flatMap((c, i) => [
    ...release(c, x0 + i * step, deck.y + Math.round(((i - mid) / Math.max(mid, 1)) ** 2 * Math.min(24, n * 3)), doc.topZ + 1 + i),
    ...(faceUp !== undefined ? conform(c, faceUp) : []),
  ]);
  const rest = cards.slice(0, cards.length - n);
  changes.push(...shrunk(deck, rest));
  const deckLeft = rest.length > 1 || (rest.length === 1 && persists(deck));
  const from = deck;
  return { changes, select: deckLeft ? [deck.id] : dealt.map((c) => c.id), events: (after) => [dealEvent(from, dealt, after)] };
};

export interface DealSeat {
  id: string;
  label?: string;
  color?: string;
}
/**
 * Deal to players' hands: round-robin from the top of deck `id`, `count` each (or `'even'`: as many
 * each as the deck allows evenly), into each player's hand (the first hand they own; a new private
 * hand where there is none, in a row below the deck). Dealt cards are private (face down). What's
 * left stays in the deck. One undo step, one log event.
 */
export const dealHands: Command<{ id: string; count: number | 'even'; players: DealSeat[] }> = (doc, a, ctx) => {
  const deck = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!deck || !isDeck(deck) || isHand(deck) || !Array.isArray(a.players)) return [];
  const seen = new Set<string>();
  const players = a.players.filter((p): p is DealSeat => !!p && typeof p.id === 'string' && !!p.id && !seen.has(p.id) && !!seen.add(p.id));
  const pile = cardsIn(doc, deck.id).slice();
  if (!players.length || !pile.length) return [];
  const per = a.count === 'even' ? Math.floor(pile.length / players.length) : isNum(a.count) && a.count >= 1 ? Math.min(52, Math.floor(a.count)) : 0;
  if (per < 1) return [];
  const changes: Change[] = [];
  // each player's hand: theirs, or a new one in a row below the deck
  const p0 = pileAt(deck);
  const size = handSizeFor(per);
  const placed: { x: number; y: number; width: number; height: number }[] = [];
  let z = Math.floor(doc.topZ);
  const hands = players.map((p) => {
    const own = doc.nodes.find((n) => isHand(n) && n.owner === p.id);
    if (own) return { box: own, order: topOrder(doc, own.id), cards: [] as CanvasNode[] };
    const want = { x: p0.x + CARD_W / 2 - size.w / 2 + placed.length * (size.w + 40), y: p0.y + CARD_H + 80 };
    const at = freeSpot(doc, want.x, want.y, size.w, size.h, placed);
    placed.push({ x: at.x, y: at.y, width: size.w, height: size.h });
    const label = typeof p.label === 'string' ? p.label.slice(0, 40) : 'Hand';
    const box = groupNode(ctx.newId(), at.x, at.y, ++z, { layout: 'fan', owner: p.id, label, color: okColor(p.color) });
    changes.push({ op: 'add', node: box });
    return { box, order: 0, cards: [] as CanvasNode[] };
  });
  for (let r = 0; r < per && pile.length; r++)
    for (const h of hands) {
      const c = pile.pop();
      if (!c) break;
      h.cards.push(c);
      changes.push(...stackInto(c, h.box, ++h.order), ...conform(c, false));
    }
  changes.push(...shrunk(deck, pile));
  const counts = hands.map((h) => h.cards.length);
  const deckLeft = persists(deck) || pile.length > 1;
  return {
    changes,
    select: deckLeft ? [deck.id] : [],
    events: [dealHandsEvent(deck, hands.map((h) => h.box), counts)],
  };
};

/**
 * G / stacking: put cards and containers together. If one of them is a container (deck, group, hand)
 * the rest go into it, on top; otherwise they become a new group (`layout`, default fan) where the
 * first one lies. Cards keep their own facing unless `faceUp` is given. Cards whose container is
 * also listed come along with it.
 */
export const gather: Command<{ ids: string[]; faceUp?: boolean; layout?: Layout }> = (doc, a, ctx) => {
  if (!isIds(a?.ids)) return [];
  const seen = new Set<string>();
  let nodes = a.ids
    .map((id) => doc.get(id))
    .filter((n): n is CanvasNode => !!n && isCardish(n) && doc.isVisible(n.id) && !seen.has(n.id) && !!seen.add(n.id));
  nodes = nodes.filter((n) => !(isCard(n) && seen.has(doc.parentOf(n.id) ?? '')));
  const total = nodes.reduce((k, n) => k + (isDeck(n) ? cardsIn(doc, n.id).length : 1), 0);
  if (nodes.length < 2 || total < 2) return [];

  const changes: Change[] = [];
  let box = nodes.find(isDeck);
  if (box) changes.push(...toFront(doc, [box]));
  else {
    const first = nodes[0];
    const layout: Layout = a.layout && ['stack', 'fan', 'row', 'grid'].includes(a.layout) ? a.layout : 'fan';
    box =
      layout === 'stack'
        ? deckNode(ctx.newId(), first.x, first.y, Math.floor(doc.topZ) + 1, packOf(first))
        : (() => {
            // place the group so its first card stays exactly where it lies
            const at0 = slots(layout, total).at[0];
            return groupNode(ctx.newId(), first.x - at0.dx, first.y - at0.dy, Math.floor(doc.topZ) + 1, { layout, pack: packOf(first) });
          })();
    changes.push({ op: 'add', node: box });
  }
  const boxId = box.id;
  changes.push(...insertInto(doc, box, nodes.filter((n) => n.id !== boxId)));
  if (isBool(a.faceUp)) {
    const all = [...cardsIn(doc, boxId), ...nodes.flatMap((n) => (n.id === boxId ? [] : isDeck(n) ? cardsIn(doc, n.id) : [n]))];
    for (const c of all) changes.push(...conform(c, a.faceUp));
  }
  return { changes, select: [boxId] };
};

/** Take a card out of the group or hand it's shown in, onto the table where it is (or at x, y). */
export const pullOut: Command<{ id: string; x?: number; y?: number }> = (doc, a) => {
  const c = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  const from = c && doc.parentOf(c.id);
  if (!c || !isCard(c) || !from) return [];
  const box = doc.get(from)!;
  const changes = release(c, Math.round(isNum(a.x) ? a.x : c.x), Math.round(isNum(a.y) ? a.y : c.y), Math.floor(doc.topZ) + 1);
  changes.push(...shrunk(box, cardsIn(doc, from).filter((x) => x.id !== c.id)));
  return { changes, select: [c.id], events: (after) => moveEvents(doc, after, [c.id]) };
};

/** How far apart cards put down together on the table lie (they overlap, every corner readable). */
export const PUT_DOWN_STEP = 44;

/**
 * Put cards down on the table together (a play from a hand dropped beside every container): in the
 * given order, overlapping left to right from (x, y), out of whatever they were in. `faceUp`: cards
 * that come out of a hand land this way up (playing a card implies face up); the rest keep theirs.
 */
export const putDown: Command<{ ids: string[]; x: number; y: number; faceUp?: boolean }> = (doc, a) => {
  if (!isIds(a?.ids) || !isNum(a.x) || !isNum(a.y)) return [];
  const seen = new Set<string>();
  const cards = a.ids.map((id) => doc.get(id)).filter((c): c is CanvasNode => !!c && isCard(c) && doc.isVisible(c.id) && !seen.has(c.id) && !!seen.add(c.id));
  if (!cards.length) return [];
  const z = Math.floor(doc.topZ);
  const changes: Change[] = [];
  const from = new Map<string, CanvasNode>();
  cards.forEach((c, i) => {
    const h = handOfCard(doc, c);
    changes.push(...release(c, Math.round(a.x + i * PUT_DOWN_STEP), Math.round(a.y), z + 1 + i));
    if (h && isBool(a.faceUp)) changes.push(...conform(c, a.faceUp));
    const p = doc.parentOf(c.id);
    if (p) from.set(p, doc.get(p)!);
  });
  for (const box of from.values()) changes.push(...shrunk(box, cardsIn(doc, box.id).filter((x) => !seen.has(x.id))));
  const ids = cards.map((c) => c.id);
  return logged({ changes, select: ids }, (after) => moveEvents(doc, after, ids));
};

/**
 * Move cards within the group or hand they're in: `by` steps left (-1) / right (+1), or `to` its start
 * / end. Selected cards move as a block, keeping their order; in a hand they stay in their part (the
 * shown strip or the private row). Only the order changes (never facing). Cards in other containers are ignored.
 */
export const reorder: Command<{ ids: string[]; by?: number; to?: 'start' | 'end' }> = (doc, a) => {
  if (!isIds(a?.ids) || (!isNum(a.by) && a.to !== 'start' && a.to !== 'end')) return [];
  const first = a.ids.map((id) => doc.get(id)).find((n) => !!n && isCard(n) && !!doc.parentOf(n.id));
  const boxId = first && doc.parentOf(first.id);
  const box = boxId ? doc.get(boxId) : undefined;
  if (!first || !box || !isSpreadOut(box)) return [];
  const all = cardsIn(doc, box.id);
  const inPart = (c: CanvasNode) => !isHand(box) || shownIn(box, c) === shownIn(box, first);
  const part = all.filter(inPart);
  const picked = new Set(a.ids.filter((id) => part.some((c) => c.id === id)));
  let next = part.slice();
  if (a.to) {
    const sel = next.filter((c) => picked.has(c.id));
    const rest = next.filter((c) => !picked.has(c.id));
    next = a.to === 'start' ? [...sel, ...rest] : [...rest, ...sel];
  } else {
    const steps = Math.min(Math.abs(Math.trunc(a.by!)), part.length);
    for (let k = 0; k < steps; k++) {
      if (a.by! < 0) {
        for (let i = 1; i < next.length; i++) if (picked.has(next[i].id) && !picked.has(next[i - 1].id)) [next[i - 1], next[i]] = [next[i], next[i - 1]];
      } else {
        for (let i = next.length - 2; i >= 0; i--) if (picked.has(next[i].id) && !picked.has(next[i + 1].id)) [next[i], next[i + 1]] = [next[i + 1], next[i]];
      }
    }
  }
  // the part's cards take the part's slots in the whole list, in their new order
  let k = 0;
  const full = all.map((c) => (inPart(c) ? next[k++] : c));
  return full.flatMap((c, i) => (card(c).order === i + 1 ? [] : [set(c.id, F('order'), i + 1)]));
};

/** Changes that switch `box` to `layout`, keeping the top-left of its cards where it is. No checks. */
function relayout(box: CanvasNode, layout: Layout): Change[] {
  if (layoutOf(box) === layout) return [];
  const changes = [set(box.id, F('layout'), layout === 'stack' ? undefined : layout)];
  if (areaOf(box)) return changes; // a fixed area stays put: the pile is drawn in its middle
  if (layout === 'stack' && isSpreadOut(box)) changes.push(set(box.id, 'x', box.x + PAD), set(box.id, 'y', box.y + PAD + 6));
  if (layout !== 'stack' && isStacked(box)) changes.push(set(box.id, 'x', box.x - PAD), set(box.id, 'y', box.y - PAD - 6));
  return changes;
}

/** Switch any container (home deck too) between stack / fan / row / grid. A hand never stacks. */
export const setLayout: Command<{ id: string; layout: Layout }> = (doc, a) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isDeck(box) || !['stack', 'fan', 'row', 'grid'].includes(a.layout)) return [];
  if (isHand(box) && a.layout === 'stack') return [];
  return relayout(box, a.layout);
};

/** The three kinds of collection, all one container type: a deck (stacked), a group (spread, public), a hand (spread, owned). */
export type Kind = 'deck' | 'group' | 'hand';
export const kindOf = (box: CanvasNode): Kind => (isStacked(box) ? 'deck' : isHand(box) ? 'hand' : 'group');

const HAND_OPTIONS = ['color', 'blind', 'showing', 'hideCount', 'fixed', 'width'] as const;
/** A hand becomes public: owner, label and the hand's options go. */
const unown = (box: CanvasNode, text: string): Change[] =>
  box.owner
    ? [
        set(box.id, 'owner', undefined),
        set(box.id, 'label', undefined),
        set(box.id, 'text', text),
        ...HAND_OPTIONS.filter((k) => (box[FIELD] as Record<string, unknown>)[k] !== undefined).map((k) => set(box.id, F(k), undefined)),
      ]
    : [];

/**
 * Turn a container into a deck, group or hand. Hand → deck or group makes it public first. Into a
 * hand: owned by `owner` (labelled `label`, colored `color`), spread as a fan if it was a deck. The
 * home deck can be a deck or a group, never a hand.
 */
export const turnInto: Command<{ id: string; kind: Kind; owner?: string; label?: string; color?: string }> = (doc, a, ctx) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isDeck(box) || kindOf(box) === a.kind) return [];
  // a hand keeps a lane for raised cards above its row: going public drops it, cards stay put
  const shifted = laneOf(box) ? { ...box, y: box.y + laneOf(box) } : box;
  if (a.kind === 'deck') return [...unown(box, 'Pile'), ...relayout(shifted, 'stack')];
  if (a.kind === 'group') return [...unown(box, 'Group'), ...(shifted !== box ? [set(box.id, 'y', shifted.y)] : []), ...relayout(shifted, 'fan')];
  if (a.kind === 'hand') return own(doc, { id: box.id, owner: a.owner ?? '', label: a.label, color: a.color }, ctx);
  return [];
};

const ROW_GAP = 12;
const rowWidth = (n: number) => n * (CARD_W + ROW_GAP) - ROW_GAP;

/** Where a container's cards start when laid out in a row: where its first card shows (home deck: beside it). */
function rowStart(box: CanvasNode) {
  if (isHomeDeck(box)) return { x: box.x + box.width + 24, y: isSpreadOut(box) ? box.y + PAD : box.y };
  return isSpreadOut(box) ? { x: box.x + PAD, y: box.y + PAD } : { x: box.x, y: box.y };
}

/** Lay `cards` out in a row from (x, y), each keeping its facing unless `faceUp` is given. */
const layRow = (cards: CanvasNode[], x: number, y: number, z: number, faceUp?: boolean): Change[] =>
  cards.flatMap((c, i) => [...release(c, Math.round(x + i * (CARD_W + ROW_GAP)), Math.round(y), z + 1 + i), ...(faceUp === undefined ? [] : conform(c, faceUp))]);

/**
 * Put cards on table: the container's cards in a row where it was (bottom card left), each keeping
 * its facing, and the container goes. The home deck stays as an empty slot; its row starts beside it.
 */
export const putOnTable: Command<{ id: string }> = (doc, a) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isDeck(box)) return [];
  const cards = cardsIn(doc, box.id);
  const p = rowStart(box);
  const changes = layRow(cards, p.x, p.y, Math.floor(doc.topZ));
  if (!isHomeDeck(box) && !isSpot(box)) changes.push({ op: 'del', id: box.id });
  return logged({ changes, select: cards.map((c) => c.id) }, (after) => [putOnTableEvent(doc, after, box, cards)]);
};

/**
 * Showdown: every hand is put on the table as a face-up row where it was (left to right, a row slides
 * right past rows already laid so they don't overlap), and the hands go.
 */
export const showdown: Command<Record<string, never>> = (doc) => {
  const hands = doc.nodes.filter(isHand).sort((p, q) => p.x - q.x || p.y - q.y);
  if (!hands.length) return [];
  const laid: { x: number; y: number; w: number }[] = [];
  const hits = (x: number, y: number, w: number) => laid.some((r) => r.x < x + w + 20 && r.x + r.w + 20 > x && r.y < y + CARD_H && r.y + CARD_H > y);
  let z = Math.floor(doc.topZ);
  const changes: Change[] = [];
  const select: string[] = [];
  const cardsBy = new Map<string, CanvasNode[]>();
  for (const h of hands) {
    const cards = cardsIn(doc, h.id);
    cardsBy.set(h.id, cards);
    const p = rowStart(h);
    const w = rowWidth(cards.length);
    while (cards.length && hits(p.x, p.y, w)) p.x += CARD_W + ROW_GAP;
    if (cards.length) laid.push({ x: p.x, y: p.y, w });
    changes.push(...layRow(cards, p.x, p.y, z, true));
    if (!isSpot(h)) changes.push({ op: 'del', id: h.id }); // a seat on a mat (a private zone) stays
    z += cards.length;
    select.push(...cards.map((c) => c.id));
  }
  return logged({ changes, select }, (after) => [showdownEvent(after, hands, cardsBy)]);
};

/** Put every card of a group on the table where it's shown, and remove the group. Not the home deck. */
export const ungroup: Command<{ id: string }> = (doc, a) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isDeck(box) || isHomeDeck(box)) return [];
  const z = Math.floor(doc.topZ);
  const cards = cardsIn(doc, box.id);
  const changes = cards.flatMap((c, i) => (isStacked(box) ? release(c, box.x + i * 30, box.y, z + 1 + i) : release(c, c.x, c.y, z + 1 + i)));
  changes.push({ op: 'del', id: box.id });
  return { changes, select: cards.map((c) => c.id) };
};

export type SortMode = 'suit' | 'rank' | 'rankOnly' | 'tienlen' | 'reverse';
export const SORT_MODES: SortMode[] = ['suit', 'rank', 'rankOnly', 'tienlen', 'reverse'];
/** A container's remembered sort (plain "Sort" repeats it). Default: by suit, then rank; ace high. */
export interface SortPref {
  mode: SortMode;
  aceHigh: boolean;
}
export const sortPrefOf = (box: CanvasNode): SortPref => {
  const p = (box[FIELD] as { sort?: Partial<SortPref> }).sort;
  return { mode: p?.mode && SORT_MODES.includes(p.mode) ? p.mode : 'suit', aceHigh: p?.aceHigh !== false };
};

/** Sort keys of a card face: suit and rank as numbers. A pack can bring its own (registry by pack id). */
export type SortKeys = (face: string, o: { aceHigh: boolean }) => { suit: number; rank: number };
const SUIT_ORDER = ['S', 'H', 'C', 'D']; // alternating colors
export const sortKeys: Record<string, SortKeys> = {
  'standard-52': (face, o) => {
    const { rank, suit } = parseFace(face);
    const r = (RANKS as readonly string[]).indexOf(rank); // A = 0 … K = 12
    return { suit: SUIT_ORDER.indexOf(suit), rank: o.aceHigh && rank === 'A' ? 13 : r };
  },
};
/** Sort keys for a pack: its own (Pack.sortKeys), else this table, else a registered pack's card order, else standard-52's. */
const byPackOrder = (pack: string): SortKeys => (face) => ({ suit: 0, rank: packOrder(pack, face) ?? 9999 });
const keysFor = (pack: string): SortKeys => getPack(pack)?.sortKeys ?? sortKeys[pack] ?? (getPack(pack) ? byPackOrder(pack) : sortKeys['standard-52']);

/** Tiến Lên order: 3 lowest … K, A, 2 highest; suits ♠ < ♣ < ♦ < ♥. */
const TL_RANKS = ['3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A', '2'];
const TL_SUITS = ['S', 'C', 'D', 'H'];
export const tienLenKeys: SortKeys = (face) => {
  const { rank, suit } = parseFace(face);
  return { rank: TL_RANKS.indexOf(rank), suit: TL_SUITS.indexOf(suit) };
};

/** `cards` (in their current order) sorted by `mode`. Stable: equal keys keep their order. */
export function sortedCards(cards: CanvasNode[], pref: SortPref): CanvasNode[] {
  if (pref.mode === 'reverse') return cards.slice().reverse();
  // Tiến Lên is a standard-52 order; other packs sort by rank, then suit
  const keys = (c: CanvasNode) => (pref.mode === 'tienlen' && packOf(c) === PACK ? tienLenKeys : keysFor(packOf(c)));
  const k = new Map(cards.map((c) => [c.id, keys(c)(card(c).face, pref)]));
  const cmp = (x: CanvasNode, y: CanvasNode) => {
    const a = k.get(x.id)!;
    const b = k.get(y.id)!;
    if (pref.mode === 'suit') return a.suit - b.suit || a.rank - b.rank;
    if (pref.mode === 'rank' || pref.mode === 'tienlen') return a.rank - b.rank || a.suit - b.suit;
    return a.rank - b.rank; // rankOnly
  };
  return cards.slice().sort(cmp); // Array.prototype.sort is stable
}

/**
 * Sort a group or hand. `mode` / `aceHigh` given: use them and remember them on the container; else
 * repeat the remembered sort. Only the order changes (never facing: nothing shows or hides).
 */
export const sort: Command<{ id: string; mode?: SortMode; aceHigh?: boolean }> = (doc, a) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isDeck(box)) return [];
  const prev = sortPrefOf(box);
  const pref: SortPref = { mode: a.mode && SORT_MODES.includes(a.mode) ? a.mode : prev.mode, aceHigh: isBool(a.aceHigh) ? a.aceHigh : prev.aceHigh };
  const changes: Change[] = [];
  if (pref.mode !== prev.mode || pref.aceHigh !== prev.aceHigh || !(box[FIELD] as { sort?: unknown }).sort) changes.push(set(box.id, F('sort'), { ...pref }));
  const sorted = sortedCards(cardsIn(doc, box.id), pref);
  changes.push(...sorted.flatMap((c, i) => (card(c).order === i + 1 ? [] : [set(c.id, F('order'), i + 1)])));
  return changes;
};

/** First spot near (x, y) where a w×h box overlaps nothing on the table: along the row, then rows above. */
export function freeSpot(doc: DocView, x: number, y: number, w: number, h: number, extra: { x: number; y: number; width: number; height: number }[] = []): { x: number; y: number } {
  const boxes = [...doc.visible.filter((n) => !doc.parentOf(n.id)), ...extra];
  const free = (px: number, py: number) =>
    !boxes.some((n) => n.x < px + w + 10 && n.x + n.width + 10 > px && n.y - 30 < py + h + 10 && n.y + n.height + 10 > py - 30);
  for (let row = 0; row < 8; row++) {
    for (let k = 0; k < 17; k++) {
      const dx = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.round(w / 2);
      const px = Math.round(x + dx);
      const py = Math.round(y - row * (h + 40));
      if (free(px, py)) return { x: px, y: py };
    }
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Hand button: a new empty private fan group owned by `owner` (any number per player), in free space
 * near (x, y). `label` (e.g. "Alice's hand") and `color` show whose it is.
 */
export const newHand: Command<{ owner: string; label?: string; color?: string; x?: number; y?: number }> = (doc, a, ctx) => {
  if (typeof a?.owner !== 'string' || !a.owner) return [];
  const label = typeof a.label === 'string' ? a.label.slice(0, 40) : 'Hand';
  const s = emptyHandSize();
  const at = freeSpot(doc, isNum(a.x) ? a.x : 0, isNum(a.y) ? a.y : 0, s.w, s.h);
  const node = groupNode(ctx.newId(), at.x, at.y, Math.floor(doc.topZ) + 1, { layout: 'fan', owner: a.owner, label, color: okColor(a.color) });
  return { changes: [{ op: 'add', node }], select: [node.id], events: [{ type: 'cards.newHand', text: `added ${label}`, targets: [node.id], cue: 'pulse' }] };
};

/**
 * Make a group private (`owner` = a player id; others see its cards face down) or public
 * (`owner` = null). A private group is never a stack, so a stacked group is spread out as a fan.
 */
export const own: Command<{ id: string; owner: string | null; label?: string; color?: string }> = (doc, a) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isDeck(box) || isHomeDeck(box)) return [];
  if (a.owner === null) {
    if (!box.owner) return [];
    return [...unown(box, 'Group'), ...(laneOf(box) ? [set(box.id, 'y', box.y + laneOf(box))] : [])];
  }
  if (typeof a.owner !== 'string' || !a.owner) return [];
  const changes = [set(box.id, 'owner', a.owner)];
  if (typeof a.label === 'string') changes.push(set(box.id, 'label', a.label.slice(0, 40)), set(box.id, 'text', a.label.slice(0, 40)));
  if (okColor(a.color)) changes.push(set(box.id, F('color'), okColor(a.color)));
  if (isStacked(box)) changes.push(...relayout(box, 'fan'));
  return changes;
};

/**
 * Give a hand (or a group) to player `to` (label and color follow them), or to no one (`to: null`: a
 * public group). Allowed for the current owner (`by`), for anyone on an unowned group, and for anyone
 * when the owner has left (`ownerAway`). Giving your hand away hides its private cards from you.
 */
export const give: Command<{ id: string; to: string | null; label?: string; color?: string; by?: string; ownerAway?: boolean }> = (doc, a, ctx) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isDeck(box) || isHomeDeck(box)) return [];
  if (box.owner && a.by !== undefined && box.owner !== a.by && a.ownerAway !== true) return [];
  if (a.to === null) return logged(own(doc, { id: box.id, owner: null }, ctx), [giveEvent(box, null)]);
  if (typeof a.to !== 'string' || !a.to) return [];
  return logged(own(doc, { id: box.id, owner: a.to, label: a.label, color: a.color }, ctx), [giveEvent(box, a.to, a.label)]);
};

/** L: a deck becomes a fan group, a group becomes a deck (home deck too). A hand stays spread. */
export const toggleStack: Command<{ id: string }> = (doc, a, ctx) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isDeck(box)) return [];
  return setLayout(doc, { id: box.id, layout: isStacked(box) ? 'fan' : 'stack' }, ctx);
};

/** Old stage-2 hands carried `hand: true`; a hand is now just a group with an owner. Idempotent. */
export const migrateHands: Command<Record<string, never>> = (doc) =>
  doc.nodes.filter((n) => isDeck(n) && (n[FIELD] as { hand?: unknown }).hand !== undefined).map((n) => set(n.id, F('hand'), undefined));

/** Relabel a player's hands after they rename themselves. */
export const handLabel: Command<{ owner: string; label: string; color?: string }> = (doc, a) => {
  if (typeof a?.owner !== 'string' || typeof a.label !== 'string') return [];
  return doc.nodes
    .filter((n) => isHand(n) && n.owner === a.owner)
    .flatMap((n) => [
      ...(n.label !== a.label ? [set(n.id, 'label', a.label.slice(0, 40)), set(n.id, 'text', a.label.slice(0, 40))] : []),
      ...(a.color && (n[FIELD] as { color?: string }).color !== a.color ? [set(n.id, F('color'), a.color)] : []),
    ]);
};

/**
 * Gather all: every card whose home is this deck, wherever it is (table, other decks), goes back on
 * top in table order, each keeping its own facing. Cards already inside are untouched. Piles left empty or with one card are cleaned up (see `shrunk`).
 */
export const recall: Command<{ id: string }> = (doc, a) => {
  const deck = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!deck || !isHomeDeck(deck)) return [];
  const homed = cardsHomedAt(doc, deck.id);
  const out = homed.filter((c) => doc.parentOf(c.id) !== deck.id);
  const changes: Change[] = [];
  let order = topOrder(doc, deck.id);
  const drained = new Map<string, number>();
  for (const c of out) {
    const from = doc.parentOf(c.id);
    if (from) drained.set(from, (drained.get(from) ?? 0) + 1);
    changes.push(...stackInto(c, deck, ++order));
  }
  for (const from of drained.keys()) {
    const other = doc.get(from)!;
    if (isDeck(other)) changes.push(...shrunk(other, cardsIn(doc, from).filter((c) => !out.includes(c))));
  }
  changes.push(...toFront(doc, [deck]));
  return { changes, select: [deck.id], events: out.length ? [recallEvent(doc, deck, out)] : [] };
};

/** How many of a deck's own cards are elsewhere. */
export const outCount = (doc: DocView, deckId: string) => cardsHomedAt(doc, deckId).filter((c) => doc.parentOf(c.id) !== deckId).length;

/**
 * Repair/migration (runs after every load, idempotent). Per pack: pick one home deck — a stack
 * already flagged home, else the stack most cards name as home, else the fullest stack, else a new
 * one left of the leftmost card — flag it, unflag every other stack (they become piles), point every
 * card of the pack at it, delete empty piles and dissolve one-card piles. Facing is left alone.
 */
export const repairHomes: Command<Record<string, never>> = (doc, _a, ctx) => {
  const changes: Change[] = [];
  const packs = new Map<string, { stacks: CanvasNode[]; cards: CanvasNode[] }>();
  const of = (p: string) => packs.get(p) ?? (packs.set(p, { stacks: [], cards: [] }), packs.get(p)!);
  for (const n of doc.nodes) {
    if (isDeck(n)) of(packOf(n)).stacks.push(n);
    else if (isCard(n)) of(packOf(n)).cards.push(n);
  }
  for (const [pack, { stacks, cards }] of packs) {
    if (!cards.length) {
      for (const st of stacks) if (!isHomeDeck(st) && !isHand(st) && !isSpot(st)) changes.push({ op: 'del', id: st.id });
      continue;
    }
    const claims = (st: CanvasNode) => cards.filter((c) => card(c).home === st.id).length;
    const size = (st: CanvasNode) => cardsIn(doc, st.id).length;
    const rank = (st: CanvasNode): [number, number, number] => [isHomeDeck(st) ? 1 : 0, claims(st), size(st)];
    const better = (a: CanvasNode, b: CanvasNode) => {
      const [x, y] = [rank(a), rank(b)];
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
      return a.x < b.x || (a.x === b.x && a.id < b.id);
    };
    // only a plain pile can be the home deck (not a hand, not a spread-out group)
    const candidates = stacks.filter((st) => isHomeDeck(st) || (isStacked(st) && !isHand(st) && !isSpot(st)));
    let home = candidates.reduce<CanvasNode | undefined>((best, st) => (!best || better(st, best) ? st : best), undefined);
    if (!home) {
      const left = cards.filter((c) => !doc.parentOf(c.id)).reduce((a, b) => (b.x < a.x ? b : a), cards[0]);
      home = deckNode(ctx.newId(), left.x - CARD_W - 40, left.y, doc.topZ + 1, pack, true);
      changes.push({ op: 'add', node: home });
    } else if (!isHomeDeck(home)) {
      changes.push(set(home.id, F('home'), true), set(home.id, 'text', 'Deck'));
    }
    for (const st of stacks) {
      if (st.id === home.id || isHand(st) || isSpot(st)) continue;
      if (isHomeDeck(st)) changes.push(set(st.id, F('home'), undefined), set(st.id, 'text', 'Pile'));
      if (!size(st)) changes.push({ op: 'del', id: st.id });
      else if (size(st) === 1) changes.push(...shrunk(st, cardsIn(doc, st.id))); // a pile of one is just a card
    }
    for (const c of cards) if (card(c).home !== home.id) changes.push(set(c.id, F('home'), home.id));
  }
  return changes;
};

/**
 * Something was dropped onto `target`. Onto a container, or a card shown in one: into that container
 * (a pile: on top; a group or hand: at the drop point `at`). Onto a loose card: a new group.
 */
export const drop: Command<{ target: string; ids: string[]; at?: { x: number; y: number }; as?: 'stack' | 'fan'; shown?: boolean; faceUp?: boolean }> = (doc, a, ctx) => {
  const r = dropChanges(doc, a, ctx);
  const res = Array.isArray(r) ? { changes: r } : r;
  if (res.changes.length && isBool(a.faceUp)) res.changes.push(...playedFacing(doc, a.target, a.ids, a.faceUp));
  const ids = isIds(a?.ids) ? a.ids : [];
  return logged(res, (after) => moveEvents(doc, after, ids));
};
/**
 * A play: cards that leave a hand for the table (a zone, a pile, a group, a new group) land `faceUp`,
 * unless the destination turns them itself (a zone's facing on entry) or is a hand (private there).
 * Runs after the drop's own changes, so it wins over a kept facing.
 */
function playedFacing(doc: DocView, targetId: string, ids: string[], faceUp: boolean): Change[] {
  const target = doc.get(targetId);
  if (!target) return [];
  const parent = isCard(target) ? doc.parentOf(target.id) : undefined;
  const host = isDeck(target) ? target : parent ? doc.get(parent) : undefined;
  if (host && (isHand(host) || enterOf(host))) return [];
  return pick(doc, ids).flatMap((c) => (isCard(c) && handOfCard(doc, c) && card(c).faceUp !== faceUp ? [set(c.id, F('faceUp'), faceUp)] : []));
}
const dropChanges: Command<{ target: string; ids: string[]; at?: { x: number; y: number }; as?: 'stack' | 'fan'; shown?: boolean }> = (doc, a, ctx) => {
  const target = typeof a?.target === 'string' ? doc.get(a.target) : undefined;
  if (!target || !isCardish(target) || !isIds(a.ids)) return [];
  const dropped = pick(doc, a.ids).filter((n) => isCardish(n) && n.id !== target.id && doc.isVisible(n.id));
  if (!dropped.length) return [];
  const parent = isCard(target) ? doc.parentOf(target.id) : undefined;
  const host = isDeck(target) ? target : parent ? doc.get(parent) : undefined;
  if (host && !dropped.some((n) => n.id === host.id) && incomingCount(doc, host, dropped) > roomIn(doc, host)) return [];
  if (!host || dropped.some((n) => n.id === host.id))
    return gather(doc, { ids: [target.id, ...dropped.map((n) => n.id)], layout: a.as === 'stack' ? 'stack' : 'fan' }, ctx);
  if (isStacked(host)) return { changes: [...insertInto(doc, host, dropped), ...toFront(doc, [host])], select: [host.id] };
  const movingIds = new Set(dropped.flatMap((n) => (isDeck(n) ? cardsIn(doc, n.id) : [n])).map((c) => c.id));
  const staying = cardsIn(doc, host.id).filter((c) => !movingIds.has(c.id));
  const at = a.at && isNum(a.at.x) && isNum(a.at.y) ? a.at : undefined;
  if (isHand(host)) return dropInHand(doc, host, dropped, staying, at, a.shown);
  const index = at ? slotIndex(host, staying.length, at) : parent ? staying.findIndex((c) => c.id === target.id) + 1 : undefined;
  return { changes: insertInto(doc, host, dropped, index), select: dropped.map((n) => n.id) };
};

/** Cards that would newly enter `box` if `dropped` (cards or containers) were dropped on it. */
export const incomingCount = (doc: DocView, box: CanvasNode, dropped: CanvasNode[]) =>
  dropped.flatMap((n) => (isDeck(n) ? cardsIn(doc, n.id) : [n])).filter((c) => doc.parentOf(c.id) !== box.id).length;
/**
 * Into a hand at drop point `at`: into the strip (shown) or the row (private), at the spot nearest the
 * drop. `shown` (the owner's drag up / down) sets it; else each card keeps how it was. Order in the
 * other part is untouched, so rearranging never changes what anyone sees of the other cards.
 */
function dropInHand(doc: DocView, host: CanvasNode, dropped: CanvasNode[], staying: CanvasNode[], at: { x: number; y: number } | undefined, shown?: boolean): CommandResult {
  const lead = dropped.find(isCard) ?? cardsIn(doc, dropped[0].id)[0];
  const toStrip = allowsShowing(host) && (isBool(shown) ? shown : !!lead && card(lead).faceUp);
  const part = staying.filter((c) => shownIn(host, c) === toStrip);
  let index: number | undefined;
  if (at) {
    const k = handSlotIndex(host, part.length, at.x);
    index = k < part.length ? staying.indexOf(part[k]) : part.length ? staying.indexOf(part[part.length - 1]) + 1 : staying.length;
  }
  const changes = insertInto(doc, host, dropped, index);
  if (isBool(shown) && allowsShowing(host)) for (const n of dropped) for (const c of isDeck(n) ? cardsIn(doc, n.id) : [n]) changes.push(...conform(c, shown));
  return { changes, select: dropped.map((n) => n.id) };
}

/**
 * Move cards into a container from wherever they are, also from inside other piles (no UI gesture can
 * do that: drop and gather take what's visible). On top, in the order given; the container's facing
 * on entry applies; a pile left with one card dissolves as usual. Takes only as many as fit (`max`).
 * For automation steps and agents: "the rest of the deck goes to Set aside".
 */
export const moveInto: Command<{ target: string; ids: string[] }> = (doc, a) => {
  const box = typeof a?.target === 'string' ? doc.get(a.target) : undefined;
  if (!box || !isDeck(box) || !isIds(a.ids)) return [];
  const cards = pick(doc, a.ids).filter((c) => isCard(c) && doc.parentOf(c.id) !== box.id);
  const want = new Map(a.ids.map((id, i) => [id, i]));
  cards.sort((p, q) => want.get(p.id)! - want.get(q.id)!);
  const fit = cards.slice(0, Math.max(0, roomIn(doc, box)));
  if (!fit.length) return [];
  const ids = fit.map((c) => c.id);
  return logged(insertInto(doc, box, fit), (after) => moveEvents(doc, after, ids));
};

/** Lay a deck out as an overlapping row, bottom card left. Removes the deck. */
export const spread: Command<{ id: string; step?: number }> = (doc, a) => {
  const deck = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!deck || !isDeck(deck)) return [];
  const step = isNum(a.step) ? a.step : 30;
  const cards = cardsIn(doc, deck.id);
  const stays = isHomeDeck(deck); // home deck: leave the empty slot, spread beside it
  const x0 = stays ? deck.x + CARD_W + 24 : deck.x;
  const changes = cards.flatMap((c, i) => release(c, x0 + i * step, deck.y, doc.topZ + 1 + i));
  if (!stays) changes.push({ op: 'del', id: deck.id });
  return { changes, select: cards.map((c) => c.id) };
};

/** A fresh table at (x, y): a shuffled deck, a face-up wave of spades and three cards to flip. */
export const setup: Command<{ x?: number; y?: number }> = (doc, a, ctx) => {
  const ox = isNum(a?.x) ? a.x : 0;
  const oy = isNum(a?.y) ? a.y : 0;
  let z = doc.topZ;
  const faces = standardDeck();
  const spades = faces.filter((f) => f.endsWith('S'));
  const mystery = ['AH', 'AD', 'AC'];
  const rest = shuffled(
    faces.filter((f) => !f.endsWith('S') && !mystery.includes(f)),
    ctx.random,
  );
  const changes: Change[] = [];
  const deck = deckNode(ctx.newId(), ox, oy, ++z, undefined, true);
  changes.push({ op: 'add', node: deck });
  rest.forEach((face, i) => {
    changes.push({ op: 'add', node: cardNode(ctx.newId(), ox, oy, { face, faceUp: false, stack: deck.id, order: i + 1, home: deck.id }, ++z) });
  });
  spades.forEach((face, i) => {
    const x = ox + 200 + i * 62;
    const y = oy - 30 + Math.round(Math.sin((i / (spades.length - 1)) * Math.PI) * -70);
    changes.push({ op: 'add', node: cardNode(ctx.newId(), x, y, { face, faceUp: true, home: deck.id }, ++z) });
  });
  mystery.forEach((face, i) => {
    changes.push({
      op: 'add',
      node: cardNode(ctx.newId(), ox + 340 + i * (CARD_W + 40), oy + CARD_H + 60, { face, faceUp: false, home: deck.id }, ++z),
    });
  });
  return changes;
};

/**
 * Add a whole pack (Add menu): its home deck spread out as a face-up grid in pack order (standard-52:
 * a suit per row, A..K), centered on (x, y). The grid *is* the home deck, so Gather all, L (stack it)
 * and Reset (shuffled face-down deck) work as for any home deck.
 */
export const addPack: Command<{ pack?: string; x?: number; y?: number }> = (doc, a, ctx) => {
  const pack = getPack(typeof a?.pack === 'string' ? a.pack : PACK);
  if (!pack) return [];
  const cols = pack.cols ?? Math.ceil(Math.sqrt(pack.cards.length));
  const s = slots('grid', pack.cards.length, 1, cols);
  const x = Math.round((isNum(a?.x) ? a.x : 0) - s.w / 2);
  const y = Math.round((isNum(a?.y) ? a.y : 0) - s.h / 2);
  let z = Math.floor(doc.topZ);
  const home = deckNode(ctx.newId(), x, y, ++z, pack.id, true);
  home[FIELD] = { ...(home[FIELD] as DeckField), layout: 'grid', cols };
  const changes: Change[] = [{ op: 'add', node: home }];
  pack.cards.forEach((c, i) => changes.push({ op: 'add', node: cardNode(ctx.newId(), x, y, { face: c.face, faceUp: true, stack: home.id, order: i + 1, home: home.id }, ++z, pack.id) }));
  return { changes, select: [home.id] };
};

/**
 * Reset table (core `registerReset`): every home deck gets all its cards back like a new deck, face
 * down, shuffled and stacked; public groups disappear, hands stay (empty: they are players' seats).
 * Cards keep their home; decks stay where they are.
 */
export const resetAll: Command<Record<string, never>> = (doc, _a, ctx) => {
  const changes: Change[] = [];
  for (const deck of doc.nodes.filter(isHomeDeck)) {
    if ((deck[FIELD] as DeckField).layout !== undefined) changes.push(set(deck.id, F('layout'), undefined));
    shuffled(cardsHomedAt(doc, deck.id), ctx.random).forEach((c, i) => changes.push(...stackInto(c, deck, i + 1), ...conform(c, false)));
  }
  for (const g of doc.nodes.filter((n) => isDeck(n) && !persists(n))) changes.push({ op: 'del', id: g.id });
  return changes;
};

export const commands = { moveInto, addPack, dealHands, putDown, reorder, give, flip, show, seeMine, allowShowing, hideCount, fixedFrame, resizeHand, face, move, shuffle, draw, deal, gather, recall, drop, spread, setup, repairHomes, pullOut, setLayout, ungroup, sort, newHand, own, toggleStack, handLabel, migrateHands, turnInto, putOnTable, showdown, resetAll };
