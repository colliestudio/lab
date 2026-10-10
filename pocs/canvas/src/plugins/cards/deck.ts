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
}
/** A deck node's `x-cards` field. Its cards are the card nodes pointing at it. */
export interface DeckField {
  pack: string;
  deck: true;
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
export const isCardish = (n: CanvasNode | undefined) => isCard(n) || isDeck(n);
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

export function cardNode(id: string, x: number, y: number, c: Omit<CardField, 'pack'>, z?: number, pack = PACK): CanvasNode {
  const f: CardField = { pack, face: c.face, faceUp: c.faceUp };
  if (c.stack !== undefined) f.stack = c.stack;
  if (c.order !== undefined) f.order = c.order;
  return { id, type: 'text', x, y, width: CARD_W, height: CARD_H, text: label(c.face), z, [FIELD]: f };
}

export function deckNode(id: string, x: number, y: number, z?: number, pack = PACK): CanvasNode {
  return { id, type: 'text', x, y, width: CARD_W, height: CARD_H, text: 'Deck', z, [FIELD]: { pack, deck: true } };
}
