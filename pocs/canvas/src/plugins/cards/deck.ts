import type { CanvasNode, DocView } from '../../core';

export const PACK = 'standard-52';
export const FIELD = 'x-cards';
export const CARD_W = 120;
export const CARD_H = 168;

export const SUITS = {
  S: { sym: '♠', name: 'spades', red: false },
  H: { sym: '♥', name: 'hearts', red: true },
  D: { sym: '♦', name: 'diamonds', red: true },
  C: { sym: '♣', name: 'clubs', red: false },
} as const;
export type Suit = keyof typeof SUITS;
/** T = ten in face codes ("TS"), shown as "10". */
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'] as const;
export type Rank = (typeof RANKS)[number];

/**
 * A card node's `x-cards` field. Every card is its own node, also when it sits in a deck:
 * then `stack` = the deck node's id and `order` sorts it within the deck (higher = nearer the top).
 */
export interface CardField {
  pack: string;
  face: string; // e.g. "AS", "TH"
  faceUp: boolean;
  stack?: string;
  order?: number;
  /** The home deck this card belongs to: "gather all" on it pulls the card back from anywhere. Always a home deck. */
  home?: string;
  /**
   * Only meaningful for a private (face-down) card in a blind hand: `false` = the owner sees its back
   * too ("face down for me"); absent/true = the owner sees its face. Kept when the card moves.
   */
  mine?: boolean;
}
/** How a container shows its cards: a face-down-able pile, or every card visible. */
export type Layout = 'stack' | 'fan' | 'row' | 'grid';
export const LAYOUTS: Layout[] = ['fan', 'row', 'grid', 'stack'];

/**
 * A container node's `x-cards` field; its cards are the card nodes pointing at it (`stack`), each
 * keeping its own facing. Kinds:
 * - home deck (`home: true`, one per pack, made by New table): a stack; stays as an empty slot;
 * - group (made by stacking/gathering): any layout; a public group dissolves when down to one card;
 * - a group with a node `owner` (player id) is private, a "hand": never a stack, persists even
 *   when empty, and other players see its cards face down (UI only for now; real secrecy is stage 3).
 *   Any group can be made mine / public; the Hand button makes a new empty one.
 * `deck: true` marks every container (name kept from when stacks were the only kind).
 */
export interface DeckField {
  pack: string;
  deck: true;
  home?: true;
  layout?: Layout;
  color?: string;
  /** A hand with "See my cards" unchecked: each private card's `mine` says whether the owner sees it. */
  blind?: true;
  /** A hand with "Allow showing cards to table": a strip above the row for shown (face-up) cards. */
  showing?: true;
  /** A hand with "Hide card count": others see a generic pile, never its private cards. */
  hideCount?: true;
  /** "Fixed frame size": the frame keeps `width` whatever the count (on anyway while the count is hidden). */
  fixed?: true;
  /** A fixed frame's width (cards compress to fit); default HAND_W. */
  width?: number;
}

export function parseFace(face: string): { rank: Rank; suit: Suit } {
  return { rank: face.slice(0, -1) as Rank, suit: face.slice(-1) as Suit };
}
export const isFace = (face: unknown): face is string =>
  typeof face === 'string' && (RANKS as readonly string[]).includes(face.slice(0, -1)) && face.slice(-1) in SUITS;
export const rankLabel = (r: Rank) => (r === 'T' ? '10' : r);
export function label(face: string) {
  const { rank, suit } = parseFace(face);
  return `${rankLabel(rank)}${SUITS[suit].sym}`;
}

export function standardDeck(): string[] {
  return (Object.keys(SUITS) as Suit[]).flatMap((s) => RANKS.map((r) => r + s));
}

const field = (n: CanvasNode) => n[FIELD] as Record<string, unknown> | undefined;
export const isCard = (n: CanvasNode | undefined): boolean => !!n && typeof field(n)?.face === 'string';
export const isDeck = (n: CanvasNode | undefined): boolean => !!n && field(n)?.deck === true;
export const isHomeDeck = (n: CanvasNode | undefined): boolean => isDeck(n) && field(n!)?.home === true;
export const isCardish = (n: CanvasNode | undefined) => isCard(n) || isDeck(n);
/** A private group: has an owner (a player id). */
export const isHand = (n: CanvasNode | undefined): boolean => isDeck(n) && !isHomeDeck(n) && typeof n!.owner === 'string' && !!n!.owner;
export const layoutOf = (n: CanvasNode): Layout => {
  const l = field(n)?.layout;
  return l === 'fan' || l === 'row' || l === 'grid' ? l : 'stack';
};
/** A container drawn as one pile (cards hidden, top card shown): home deck or a group set to stack. */
export const isStacked = (n: CanvasNode | undefined): boolean => isDeck(n) && layoutOf(n!) === 'stack';
/** A container that lays its cards out visibly (group or hand). */
export const isSpreadOut = (n: CanvasNode | undefined): boolean => isDeck(n) && layoutOf(n!) !== 'stack';
/** The hand a card sits in, if it's in an owned hand. */
export function handOf(doc: DocView, c: CanvasNode): CanvasNode | undefined {
  const p = doc.parentOf(c.id);
  const h = p ? doc.get(p) : undefined;
  return h && isHand(h) && h.owner ? h : undefined;
}
const deckField = (h: CanvasNode) => h[FIELD] as DeckField | undefined;
/** Hand with "See my cards" unchecked. */
export const isBlind = (h: CanvasNode): boolean => deckField(h)?.blind === true;
/** Hand with "Allow showing cards to table" on. */
export const allowsShowing = (h: CanvasNode): boolean => deckField(h)?.showing === true;
/** Hand with "Hide card count" on. */
export const hidesCount = (h: CanvasNode): boolean => deckField(h)?.hideCount === true;
/** Fixed frame size: set by the owner, or implied while the count is hidden (a growing frame would show it). */
export const hasFixedFrame = (h: CanvasNode): boolean => deckField(h)?.fixed === true || hidesCount(h);
/**
 * A card in a hand shown to the table (in the strip above the row): face up in a hand that allows
 * showing. Any other card in a hand is private.
 */
export const shownIn = (h: CanvasNode, c: CanvasNode): boolean => allowsShowing(h) && card(c).faceUp;
export const isShown = (doc: DocView, c: CanvasNode): boolean => {
  const h = handOf(doc, c);
  return !!h && shownIn(h, c);
};
/** Does the owner see this private hand card's face? Always, unless the hand is blind and the card is "face down for me". */
export const ownerSees = (h: CanvasNode, c: CanvasNode): boolean => !isBlind(h) || card(c).mine !== false;
/**
 * In a hand, a shown card shows to everyone. A private card shows its face only to the owner (unless
 * blind and marked face down for them, or the owner is viewing as others).
 */
export function hiddenFrom(doc: DocView, c: CanvasNode, viewer: string, asOthers = false): boolean {
  const h = handOf(doc, c);
  if (!h || shownIn(h, c)) return false;
  return h.owner !== viewer || asOthers || !ownerSees(h, c);
}
/** A private card in a hand that hides its count: others get no trace of it (not even a back). */
export function concealedFrom(doc: DocView, c: CanvasNode, viewer: string, asOthers = false): boolean {
  const h = handOf(doc, c);
  return !!h && hidesCount(h) && !shownIn(h, c) && (h.owner !== viewer || asOthers);
}
export const card = (n: CanvasNode) => n[FIELD] as CardField;
export const packOf = (n: CanvasNode) => (field(n)?.pack as string | undefined) ?? PACK;

/** The deck a card sits in (only if that deck exists). */
export function deckIdOf(n: CanvasNode, get: (id: string) => CanvasNode | undefined): string | undefined {
  if (!isCard(n)) return;
  const s = card(n).stack;
  return s && isDeck(get(s)) ? s : undefined;
}

const cache = new WeakMap<DocView, Map<string, CanvasNode[]>>();
/** Cards in a deck, bottom first (by order, then id for a stable tie-break). */
export function cardsIn(doc: DocView, deckId: string): CanvasNode[] {
  let m = cache.get(doc);
  if (!m) cache.set(doc, (m = new Map()));
  let list = m.get(deckId);
  if (!list) {
    list = doc
      .children(deckId)
      .filter(isCard)
      .sort((a, b) => (card(a).order ?? 0) - (card(b).order ?? 0) || (a.id < b.id ? -1 : 1));
    m.set(deckId, list);
  }
  return list;
}

const homeCache = new WeakMap<DocView, Map<string, CanvasNode[]>>();
/** Cards whose home is `deckId`, wherever they are, in z order. */
export function cardsHomedAt(doc: DocView, deckId: string): CanvasNode[] {
  let m = homeCache.get(doc);
  if (!m) {
    m = new Map();
    for (const n of doc.nodes) {
      const h = isCard(n) ? card(n).home : undefined;
      if (!h) continue;
      let l = m.get(h);
      if (!l) m.set(h, (l = []));
      l.push(n);
    }
    homeCache.set(doc, m);
  }
  return m.get(deckId) ?? [];
}

/** Home deck id if that home deck still exists. */
export function liveHome(doc: DocView, c: CanvasNode): string | undefined {
  const h = card(c).home;
  return h && isHomeDeck(doc.get(h)) ? h : undefined;
}

/** The home deck a node leads to: itself if a home deck, a card's home, a pile's top card's home. */
export function homeFor(doc: DocView, n: CanvasNode | undefined): string | undefined {
  if (!n) return;
  if (isHomeDeck(n)) return n.id;
  if (isCard(n)) return liveHome(doc, n);
  if (isDeck(n)) {
    for (const c of cardsIn(doc, n.id).slice().reverse()) {
      const h = liveHome(doc, c);
      if (h) return h;
    }
  }
}

/** Facing of a deck = its top card's; an empty deck counts as face down. */
export function deckFacing(doc: DocView, deckId: string): boolean {
  const top = cardsIn(doc, deckId).at(-1);
  return top ? card(top).faceUp : false;
}

export function cardNode(id: string, x: number, y: number, c: Omit<CardField, 'pack'>, z?: number, pack = PACK): CanvasNode {
  const f: CardField = { pack, face: c.face, faceUp: c.faceUp };
  if (c.stack !== undefined) f.stack = c.stack;
  if (c.order !== undefined) f.order = c.order;
  if (c.home !== undefined) f.home = c.home;
  if (c.mine !== undefined) f.mine = c.mine;
  return { id, type: 'text', x, y, width: CARD_W, height: CARD_H, text: label(c.face), z, [FIELD]: f };
}

/** A stack group (default) or, with `home`, a pack's home deck. */
export function deckNode(id: string, x: number, y: number, z?: number, pack = PACK, home = false): CanvasNode {
  const f: DeckField = { pack, deck: true };
  if (home) f.home = true;
  return { id, type: 'text', x, y, width: CARD_W, height: CARD_H, text: home ? 'Deck' : 'Pile', z, [FIELD]: f };
}

/** A group with a layout, or (with `owner`) a player's hand. */
export function groupNode(
  id: string,
  x: number,
  y: number,
  z: number,
  o: { layout?: Layout; pack?: string; owner?: string; label?: string; color?: string } = {},
): CanvasNode {
  const f: DeckField = { pack: o.pack ?? PACK, deck: true, layout: o.layout ?? 'fan' };
  if (o.color) f.color = o.color;
  const n: CanvasNode = { id, type: 'text', x, y, width: CARD_W, height: CARD_H, z, text: o.label ?? (o.owner ? 'Hand' : 'Group'), [FIELD]: f };
  if (o.owner) n.owner = o.owner;
  if (o.label) n.label = o.label;
  return n;
}
