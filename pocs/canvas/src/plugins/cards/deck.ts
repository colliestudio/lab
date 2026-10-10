import type { CanvasNode, DocView } from '../../core';
import { packLabel } from './packs';

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
}
/**
 * How a container shows its cards: a face-down-able pile, or every card visible. `column` cascades
 * the cards downward, each overlapping the one before (`column-up`: upward), like a Battle Line
 * formation or a solitaire tableau.
 */
export type Layout = 'stack' | 'fan' | 'row' | 'grid' | 'column' | 'column-up';
export const LAYOUTS: Layout[] = ['fan', 'row', 'grid', 'column', 'column-up', 'stack'];

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
  /**
   * A fixed spot on the table (a game's slot area: a formation, a discard pile): stays when emptied
   * or down to one card, and Reset keeps it.
   */
  fixed?: true;
  /** Slots outlined while empty (a spread-out container is at least this big). */
  slots?: number;
  /** Most cards it takes: drops beyond are refused (and it is sized for this many). */
  max?: number;
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

/** Readable text of a card of any registered pack ("10♥", "Red 7"); the face code if unknown. */
export const faceLabel = (pack: string, face: string) => packLabel(pack, face) ?? (isFace(face) ? label(face) : face);

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
  return l === 'fan' || l === 'row' || l === 'grid' || l === 'column' || l === 'column-up' ? l : 'stack';
};
/** A fixed slot area (see DeckField.fixed). */
export const isFixed = (n: CanvasNode | undefined): boolean => isDeck(n) && field(n!)?.fixed === true;
/** Room left in a container with a `max`, else Infinity. */
export function roomIn(doc: DocView, box: CanvasNode): number {
  const max = field(box)?.max;
  return typeof max === 'number' ? Math.max(0, max - cardsIn(doc, box.id).length) : Infinity;
}
/** A container drawn as one pile (cards hidden, top card shown): home deck or a group set to stack. */
export const isStacked = (n: CanvasNode | undefined): boolean => isDeck(n) && layoutOf(n!) === 'stack';
/** A container that lays its cards out visibly (group or hand). */
export const isSpreadOut = (n: CanvasNode | undefined): boolean => isDeck(n) && layoutOf(n!) !== 'stack';
/** A card sitting in someone else's hand: shown face down to `viewer`. */
export function hiddenFrom(doc: DocView, c: CanvasNode, viewer: string): boolean {
  const p = doc.parentOf(c.id);
  const h = p ? doc.get(p) : undefined;
  return !!h && isHand(h) && !!h.owner && h.owner !== viewer;
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
  return { id, type: 'text', x, y, width: CARD_W, height: CARD_H, text: faceLabel(pack, c.face), z, [FIELD]: f };
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
  o: { layout?: Layout; pack?: string; owner?: string; label?: string; color?: string; fixed?: boolean; slots?: number; max?: number } = {},
): CanvasNode {
  const f: DeckField = { pack: o.pack ?? PACK, deck: true };
  if (o.layout !== 'stack') f.layout = o.layout ?? 'fan';
  if (o.color) f.color = o.color;
  if (o.fixed) f.fixed = true;
  if (o.slots) f.slots = o.slots;
  if (o.max) f.max = o.max;
  const n: CanvasNode = { id, type: 'text', x, y, width: CARD_W, height: CARD_H, z, text: o.label ?? (o.owner ? 'Hand' : 'Group'), [FIELD]: f };
  if (o.owner) n.owner = o.owner;
  if (o.label) n.label = o.label;
  return n;
}
