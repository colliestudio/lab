import type { CanvasNode } from '../../core';

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

/** One card: what goes in a card node's `x-cards` field, and the entries of a stack. */
export interface CardData {
  face: string; // e.g. "AS", "TH"
  faceUp: boolean;
}
export interface CardField extends CardData {
  pack: string;
}
/** A stack (deck) node's `x-cards` field. Index 0 = bottom, last = top. */
export interface StackField {
  pack: string;
  stack: CardData[];
}

export function parseFace(face: string): { rank: Rank; suit: Suit } {
  return { rank: face.slice(0, -1) as Rank, suit: face.slice(-1) as Suit };
}
export const rankLabel = (r: Rank) => (r === 'T' ? '10' : r);
export function label(face: string) {
  const { rank, suit } = parseFace(face);
  return `${rankLabel(rank)}${SUITS[suit].sym}`;
}

export function standardDeck(): string[] {
  return (Object.keys(SUITS) as Suit[]).flatMap((s) => RANKS.map((r) => r + s));
}

export const cardField = (n: CanvasNode) => n[FIELD] as CardField | StackField | undefined;
export const isCard = (n: CanvasNode): boolean => {
  const f = cardField(n);
  return !!f && typeof (f as CardField).face === 'string';
};
export const isStack = (n: CanvasNode): boolean => {
  const f = cardField(n);
  return !!f && Array.isArray((f as StackField).stack);
};
/** The cards a card or stack node holds, bottom first. */
export function cardsOf(n: CanvasNode): CardData[] {
  const f = cardField(n);
  if (!f) return [];
  if ('stack' in f) return f.stack;
  return [{ face: f.face, faceUp: f.faceUp }];
}

export function cardNode(id: string, x: number, y: number, c: CardData, pack = PACK): CanvasNode {
  return { id, type: 'text', x, y, width: CARD_W, height: CARD_H, text: label(c.face), [FIELD]: { pack, face: c.face, faceUp: c.faceUp } };
}

/** Stacks of 0 cards are removed and stacks of 1 become a card; callers handle that via `pileNode`. */
export function stackNode(id: string, x: number, y: number, cards: CardData[], pack = PACK): CanvasNode {
  return {
    id,
    type: 'text',
    x,
    y,
    width: CARD_W,
    height: CARD_H,
    text: `Deck: ${cards.length} cards`,
    [FIELD]: { pack, stack: cards },
  };
}

/** A card node for one card, a stack node for several. */
export function pileNode(id: string, x: number, y: number, cards: CardData[], pack = PACK): CanvasNode {
  return cards.length === 1 ? cardNode(id, x, y, cards[0], pack) : stackNode(id, x, y, cards, pack);
}
