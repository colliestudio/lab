import { isIds, isNum, pick, set, toFront, type CanvasNode, type Change, type Command, type DocView } from '../../core';
import { CARD_H, CARD_W, FIELD, RANKS, card, cardNode, cardsHomedAt, cardsIn, deckNode, groupNode, isCard, isCardish, isDeck, isHand, isHomeDeck, isSpreadOut, isStacked, layoutOf, packOf, parseFace, standardDeck, type DeckField, type Layout } from './deck';
import { PAD, slotIndex, slots } from './layout';

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
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

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

/** Containers that stay when emptied: a home deck (an empty slot) and a hand. Groups go. */
const persists = (c: CanvasNode) => isHomeDeck(c) || isHand(c);

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

/** Flip cards; flipping a deck turns the whole pile over (order reverses). */
export const flip: Command<{ ids: string[] }> = (doc, a) =>
  pick(doc, a?.ids).flatMap((n) => {
    if (isCard(n) && !doc.parentOf(n.id)) return [set(n.id, F('faceUp'), !card(n).faceUp)];
    // turning a pile over reverses it; a spread-out group just flips each card in place
    if (isStacked(n))
      return cardsIn(doc, n.id).flatMap((c) => [set(c.id, F('faceUp'), !card(c).faceUp), set(c.id, F('order'), -(card(c).order ?? 0))]);
    if (isDeck(n)) return cardsIn(doc, n.id).map((c) => set(c.id, F('faceUp'), !card(c).faceUp));
    if (isCard(n)) return [set(n.id, F('faceUp'), !card(n).faceUp)]; // a card shown in a group
    return [];
  });

/** Turn cards (and every card in the given decks) face up or face down, whatever they are now. */
export const face: Command<{ ids: string[]; faceUp: boolean }> = (doc, a) => {
  if (!isBool(a?.faceUp)) return [];
  return pick(doc, a.ids).flatMap((n) => {
    if (isCard(n) && doc.isVisible(n.id)) return conform(n, a.faceUp);
    if (isDeck(n)) return cardsIn(doc, n.id).flatMap((c) => conform(c, a.faceUp));
    return [];
  });
};

/** Move to an absolute position (x, y) or by (dx, dy). Decks move as one node. */
export const move: Command<{ ids: string[]; x?: number; y?: number; dx?: number; dy?: number }> = (doc, a) =>
  pick(doc, a?.ids)
    .filter((n) => !doc.parentOf(n.id))
    .flatMap((n) => [
      set(n.id, 'x', Math.round(isNum(a.x) ? a.x : n.x + (isNum(a.dx) ? a.dx : 0))),
      set(n.id, 'y', Math.round(isNum(a.y) ? a.y : n.y + (isNum(a.dy) ? a.dy : 0))),
    ]);

export const shuffle: Command<{ ids: string[] }> = (doc, a, ctx) =>
  pick(doc, a?.ids)
    .filter(isDeck)
    .flatMap((d) => shuffled(cardsIn(doc, d.id), ctx.random).map((c, i) => set(c.id, F('order'), i + 1)));

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
  const y = isNum(a.y) ? a.y : deck.y;
  let x = isNum(a.x) ? a.x : undefined;
  if (x === undefined) {
    x = deck.x + CARD_W + 24;
    while (doc.visible.some((n) => n.x === x && n.y === y)) x += 32;
  }
  const changes = release(top, Math.round(x), Math.round(y), doc.topZ + 1);
  if (isBool(a.faceUp)) changes.push(set(top.id, F('faceUp'), a.faceUp));
  const rest = cards.slice(0, -1);
  changes.push(...shrunk(deck, rest));
  const deckLeft = rest.length > 1 || (rest.length === 1 && persists(deck));
  return { changes, select: a.select === 'deck' && deckLeft ? [deck.id] : [top.id] };
};

/**
 * Deal the top `count` cards (1-52) into a small fanned row next to the deck, in the first free spot
 * to its right. `faceUp` overrides orientation (default: as they lie in the deck). Keeps the deck selected.
 */
export const deal: Command<{ id: string; count: number; faceUp?: boolean }> = (doc, a) => {
  const deck = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!deck || !isDeck(deck) || !isNum(a.count) || a.count < 1) return [];
  const cards = cardsIn(doc, deck.id);
  const n = Math.min(Math.floor(a.count), 52, cards.length);
  if (!n) return [];
  const step = 30;
  const span = (n - 1) * step + CARD_W;
  const others = doc.visible.filter((v) => v.id !== deck.id);
  const hits = (x: number) => others.some((v) => v.x < x + span && v.x + v.width > x && v.y < deck.y + CARD_H && v.y + v.height > deck.y);
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
  return { changes, select: deckLeft ? [deck.id] : dealt.map((c) => c.id) };
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
  return { changes, select: [c.id] };
};

/** Changes that switch `box` to `layout`, keeping the top-left of its cards where it is. No checks. */
function relayout(box: CanvasNode, layout: Layout): Change[] {
  if (layoutOf(box) === layout) return [];
  const changes = [set(box.id, F('layout'), layout === 'stack' ? undefined : layout)];
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

const unown = (box: CanvasNode, text: string): Change[] =>
  box.owner ? [set(box.id, 'owner', undefined), set(box.id, 'label', undefined), set(box.id, 'text', text), set(box.id, F('color'), undefined)] : [];

/**
 * Turn a container into a deck, group or hand. Hand → deck or group makes it public first. Into a
 * hand: owned by `owner` (labelled `label`, colored `color`), spread as a fan if it was a deck. The
 * home deck can be a deck or a group, never a hand.
 */
export const turnInto: Command<{ id: string; kind: Kind; owner?: string; label?: string; color?: string }> = (doc, a, ctx) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isDeck(box) || kindOf(box) === a.kind) return [];
  if (a.kind === 'deck') return [...unown(box, 'Pile'), ...relayout(box, 'stack')];
  if (a.kind === 'group') return [...unown(box, 'Group'), ...relayout(box, 'fan')];
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
  if (!isHomeDeck(box)) changes.push({ op: 'del', id: box.id });
  return { changes, select: cards.map((c) => c.id) };
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
  for (const h of hands) {
    const cards = cardsIn(doc, h.id);
    const p = rowStart(h);
    const w = rowWidth(cards.length);
    while (cards.length && hits(p.x, p.y, w)) p.x += CARD_W + ROW_GAP;
    if (cards.length) laid.push({ x: p.x, y: p.y, w });
    changes.push(...layRow(cards, p.x, p.y, z, true), { op: 'del', id: h.id });
    z += cards.length;
    select.push(...cards.map((c) => c.id));
  }
  return { changes, select };
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

const SUIT_ORDER = ['S', 'H', 'C', 'D']; // alternating colors
/** Sort a group or hand by suit, then rank (A..K). */
export const sort: Command<{ id: string }> = (doc, a) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isDeck(box)) return [];
  const key = (c: CanvasNode) => {
    const { rank, suit } = parseFace(card(c).face);
    return SUIT_ORDER.indexOf(suit) * 100 + (RANKS as readonly string[]).indexOf(rank);
  };
  const sorted = cardsIn(doc, box.id).slice().sort((x, y) => key(x) - key(y));
  return sorted.flatMap((c, i) => (card(c).order === i + 1 ? [] : [set(c.id, F('order'), i + 1)]));
};

const okColor = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined);

/** First spot near (x, y) where a w×h box overlaps nothing on the table: along the row, then rows above. */
export function freeSpot(doc: DocView, x: number, y: number, w: number, h: number): { x: number; y: number } {
  const boxes = doc.visible.filter((n) => !doc.parentOf(n.id));
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
  const s = slots('fan', 0, 3);
  const at = freeSpot(doc, isNum(a.x) ? a.x : 0, isNum(a.y) ? a.y : 0, s.w, s.h);
  const node = groupNode(ctx.newId(), at.x, at.y, Math.floor(doc.topZ) + 1, { layout: 'fan', owner: a.owner, label, color: okColor(a.color) });
  return { changes: [{ op: 'add', node }], select: [node.id] };
};

/**
 * Make a group private (`owner` = a player id; others see its cards face down) or public
 * (`owner` = null). A private group is never a stack, so a stacked group is spread out as a fan.
 */
export const own: Command<{ id: string; owner: string | null; label?: string; color?: string }> = (doc, a, ctx) => {
  const box = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!box || !isDeck(box) || isHomeDeck(box)) return [];
  if (a.owner === null) {
    if (!box.owner) return [];
    return [set(box.id, 'owner', undefined), set(box.id, 'label', undefined), set(box.id, 'text', 'Group'), set(box.id, F('color'), undefined)];
  }
  if (typeof a.owner !== 'string' || !a.owner) return [];
  const changes = [set(box.id, 'owner', a.owner)];
  if (typeof a.label === 'string') changes.push(set(box.id, 'label', a.label.slice(0, 40)), set(box.id, 'text', a.label.slice(0, 40)));
  if (okColor(a.color)) changes.push(set(box.id, F('color'), okColor(a.color)));
  if (isStacked(box)) changes.push(...(setLayout(doc, { id: box.id, layout: 'fan' }, ctx) as Change[]));
  return changes;
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
  return { changes, select: [deck.id] };
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
      for (const st of stacks) if (!isHomeDeck(st) && !isHand(st)) changes.push({ op: 'del', id: st.id });
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
    const candidates = stacks.filter((st) => isHomeDeck(st) || (isStacked(st) && !isHand(st)));
    let home = candidates.reduce<CanvasNode | undefined>((best, st) => (!best || better(st, best) ? st : best), undefined);
    if (!home) {
      const left = cards.filter((c) => !doc.parentOf(c.id)).reduce((a, b) => (b.x < a.x ? b : a), cards[0]);
      home = deckNode(ctx.newId(), left.x - CARD_W - 40, left.y, doc.topZ + 1, pack, true);
      changes.push({ op: 'add', node: home });
    } else if (!isHomeDeck(home)) {
      changes.push(set(home.id, F('home'), true), set(home.id, 'text', 'Deck'));
    }
    for (const st of stacks) {
      if (st.id === home.id || isHand(st)) continue;
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
export const drop: Command<{ target: string; ids: string[]; at?: { x: number; y: number }; as?: 'stack' | 'fan' }> = (doc, a, ctx) => {
  const target = typeof a?.target === 'string' ? doc.get(a.target) : undefined;
  if (!target || !isCardish(target) || !isIds(a.ids)) return [];
  const dropped = pick(doc, a.ids).filter((n) => isCardish(n) && n.id !== target.id && doc.isVisible(n.id));
  if (!dropped.length) return [];
  const parent = isCard(target) ? doc.parentOf(target.id) : undefined;
  const host = isDeck(target) ? target : parent ? doc.get(parent) : undefined;
  if (!host || dropped.some((n) => n.id === host.id))
    return gather(doc, { ids: [target.id, ...dropped.map((n) => n.id)], layout: a.as === 'stack' ? 'stack' : 'fan' }, ctx);
  if (isStacked(host)) return { changes: [...insertInto(doc, host, dropped), ...toFront(doc, [host])], select: [host.id] };
  const movingIds = new Set(dropped.flatMap((n) => (isDeck(n) ? cardsIn(doc, n.id) : [n])).map((c) => c.id));
  const staying = cardsIn(doc, host.id).filter((c) => !movingIds.has(c.id));
  const at = a.at && isNum(a.at.x) && isNum(a.at.y) ? a.at : undefined;
  const index = at ? slotIndex(host, staying.length, at) : parent ? staying.findIndex((c) => c.id === target.id) + 1 : undefined;
  return { changes: insertInto(doc, host, dropped, index), select: dropped.map((n) => n.id) };
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

export const commands = { flip, face, move, shuffle, draw, deal, gather, recall, drop, spread, setup, repairHomes, pullOut, setLayout, ungroup, sort, newHand, own, toggleStack, handLabel, migrateHands, turnInto, putOnTable, showdown, resetAll };
