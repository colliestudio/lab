import { isIds, isNum, pick, set, toFront, type CanvasNode, type Change, type Command, type DocView } from '../../core';
import { CARD_H, CARD_W, FIELD, card, cardNode, cardsHomedAt, cardsIn, deckFacing, deckNode, isCard, isCardish, isDeck, isHomeDeck, packOf, standardDeck } from './deck';

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

/** A stack that just lost its last card: a pile disappears, a home deck stays as an empty slot. */
const emptied = (deck: CanvasNode): Change[] => (isHomeDeck(deck) ? [] : [{ op: 'del', id: deck.id }]);

/**
 * After cards leave a stack: empty → `emptied`; a pile down to one card dissolves into that loose card
 * (a home deck stays a deck at any size). `left` = the cards still in it.
 */
const shrunk = (deck: CanvasNode, left: CanvasNode[]): Change[] => {
  if (!left.length) return emptied(deck);
  if (left.length === 1 && !isHomeDeck(deck)) return [...release(left[0], deck.x, deck.y, deck.z ?? 0), { op: 'del', id: deck.id }];
  return [];
};

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
    if (isDeck(n))
      return cardsIn(doc, n.id).flatMap((c) => [set(c.id, F('faceUp'), !card(c).faceUp), set(c.id, F('order'), -(card(c).order ?? 0))]);
    return [];
  });

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
  const deckLeft = rest.length > 1 || (rest.length === 1 && isHomeDeck(deck));
  return { changes, select: a.select === 'deck' && deckLeft ? [deck.id] : [top.id] };
};

/**
 * Deal the top `count` cards (1-52) into a small fanned row next to the deck, in the first free spot
 * to its right. `faceUp` overrides orientation (default: face up). Keeps the deck selected.
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
  const faceUp = isBool(a.faceUp) ? a.faceUp : true;
  const mid = (n - 1) / 2;
  const dealt = cards.slice(-n).reverse(); // top card first, leftmost
  const changes = dealt.flatMap((c, i) => [
    ...release(c, x0 + i * step, deck.y + Math.round(((i - mid) / Math.max(mid, 1)) ** 2 * Math.min(24, n * 3)), doc.topZ + 1 + i),
    ...(card(c).faceUp !== faceUp ? [set(c.id, F('faceUp'), faceUp)] : []),
  ]);
  const rest = cards.slice(0, cards.length - n);
  changes.push(...shrunk(deck, rest));
  const deckLeft = rest.length > 1 || (rest.length === 1 && isHomeDeck(deck));
  return { changes, select: deckLeft ? [deck.id] : dealt.map((c) => c.id) };
};

/**
 * Gather cards/decks into one deck at the position of the first id. The first node's cards end up
 * at the bottom, later ones on top. A deck as first id keeps its id; otherwise a new deck is made.
 */
export const gather: Command<{ ids: string[]; faceUp?: boolean }> = (doc, a, ctx) => {
  if (!isIds(a?.ids)) return [];
  const seen = new Set<string>();
  const nodes = a.ids
    .map((id) => doc.get(id))
    .filter((n): n is CanvasNode => !!n && isCardish(n) && !doc.parentOf(n.id) && !seen.has(n.id) && !!seen.add(n.id));
  const total = nodes.reduce((k, n) => k + (isDeck(n) ? cardsIn(doc, n.id).length : 1), 0);
  if (nodes.length < 2 || total < 2) return [];

  // Facing of the result: explicit arg, else an existing deck's (its top card), else the anchor card's.
  const anchor = nodes[0];
  const changes: Change[] = [];
  let deck: CanvasNode;
  let order: number;
  let faceUp: boolean;
  if (isDeck(anchor)) {
    deck = anchor;
    order = topOrder(doc, deck.id);
    faceUp = isBool(a.faceUp) ? a.faceUp : deckFacing(doc, deck.id);
    changes.push(...toFront(doc, [deck]));
  } else {
    deck = deckNode(ctx.newId(), anchor.x, anchor.y, doc.topZ + 1, packOf(anchor));
    order = 0;
    faceUp = isBool(a.faceUp) ? a.faceUp : !!card(anchor).faceUp;
    changes.push({ op: 'add', node: deck });
  }
  for (const n of nodes) {
    if (n.id === deck.id) {
      for (const c of cardsIn(doc, n.id)) changes.push(...conform(c, faceUp));
      continue;
    }
    const cards = isDeck(n) ? cardsIn(doc, n.id) : [n];
    for (const c of cards) changes.push(...stackInto(c, deck, ++order), ...conform(c, faceUp));
    // a merged-away home deck stays as an empty slot; a pile goes
    if (isDeck(n)) changes.push(...emptied(n));
  }
  return { changes, select: [deck.id] };
};

/**
 * Gather all: every card whose home is this deck, wherever it is (table, other decks), goes back on
 * top, face down, in table order. Cards already inside are turned face down too. Decks left empty
 * by this are removed unless they are a home themselves.
 */
export const recall: Command<{ id: string }> = (doc, a) => {
  const deck = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!deck || !isHomeDeck(deck)) return [];
  const homed = cardsHomedAt(doc, deck.id);
  const out = homed.filter((c) => doc.parentOf(c.id) !== deck.id);
  const changes: Change[] = [];
  for (const c of cardsIn(doc, deck.id)) if (card(c).faceUp) changes.push(set(c.id, F('faceUp'), false));
  let order = topOrder(doc, deck.id);
  const drained = new Map<string, number>();
  for (const c of out) {
    const from = doc.parentOf(c.id);
    if (from) drained.set(from, (drained.get(from) ?? 0) + 1);
    changes.push(...stackInto(c, deck, ++order));
    if (card(c).faceUp) changes.push(set(c.id, F('faceUp'), false));
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
 * card of the pack at it, delete empty piles, dissolve one-card piles, and make every stack's facing uniform.
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
      for (const st of stacks) if (!isHomeDeck(st)) changes.push({ op: 'del', id: st.id });
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
    let home = stacks.reduce<CanvasNode | undefined>((best, st) => (!best || better(st, best) ? st : best), undefined);
    if (!home) {
      const left = cards.filter((c) => !doc.parentOf(c.id)).reduce((a, b) => (b.x < a.x ? b : a), cards[0]);
      home = deckNode(ctx.newId(), left.x - CARD_W - 40, left.y, doc.topZ + 1, pack, true);
      changes.push({ op: 'add', node: home });
    } else if (!isHomeDeck(home)) {
      changes.push(set(home.id, F('home'), true), set(home.id, 'text', 'Deck'));
    }
    for (const st of stacks) {
      if (st.id === home.id) continue;
      if (isHomeDeck(st)) changes.push(set(st.id, F('home'), undefined), set(st.id, 'text', 'Pile'));
      if (!size(st)) changes.push({ op: 'del', id: st.id });
      else if (size(st) === 1) changes.push(...shrunk(st, cardsIn(doc, st.id))); // a pile of one is just a card
    }
    for (const c of cards) if (card(c).home !== home.id) changes.push(set(c.id, F('home'), home.id));
    // no stack may hold mixed facing: conform to the top card
    for (const st of stacks) {
      const up = deckFacing(doc, st.id);
      for (const c of cardsIn(doc, st.id)) changes.push(...conform(c, up));
    }
  }
  return changes;
};

/** Something was dropped onto `target`: stack it there if both sides are cards/decks. */
export const drop: Command<{ target: string; ids: string[] }> = (doc, a, ctx) => {
  const target = typeof a?.target === 'string' ? doc.get(a.target) : undefined;
  if (!target || !isCardish(target) || !isIds(a.ids)) return [];
  const dropped = pick(doc, a.ids)
    .filter((n) => isCardish(n) && n.id !== target.id)
    .map((n) => n.id);
  if (!dropped.length) return [];
  return gather(doc, { ids: [target.id, ...dropped] }, ctx);
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

export const commands = { flip, move, shuffle, draw, deal, gather, recall, drop, spread, setup, repairHomes };
