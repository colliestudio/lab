import type { CanvasNode, DocView, LayoutRule, Placement } from '../../core';
import { CARD_H, CARD_W, card, cardsIn, isHand, isSpreadOut, layoutOf, type Layout } from './deck';

// Where a container's cards go. Pure geometry; applied at read time through the core layout hook,
// so the doc only stores each card's container + order (sync-friendly, nothing to rewrite).

export const PAD = 14;
const GAP = 10;
/** How far a card shown to the table is lifted out of a hand's row (and the lane kept free for it above each row). */
export const RAISE = Math.round(CARD_H * 0.4);
const MAX_FAN = 640;

export interface Slots {
  w: number;
  h: number;
  at: { dx: number; dy: number; angle?: number }[];
}

const gridCols = (n: number) => Math.max(1, Math.ceil(Math.sqrt(n)));
const fanStep = (n: number) => (n > 1 ? Math.min(40, (MAX_FAN - CARD_W) / (n - 1)) : 40);

/**
 * Card offsets inside a container (relative to its top-left), and the container's size. `lane`: free
 * space above each row (hands: room for raised cards); `raised(i)`: card i is lifted by `lane`.
 */
export function slots(layout: Layout, n: number, minSlots = 1, o: { lane?: number; raised?: (i: number) => boolean } = {}): Slots {
  const at: Slots['at'] = [];
  const lane = o.lane ?? 0;
  const lift = (i: number) => (o.raised?.(i) ? lane : 0);
  if (layout === 'row') {
    for (let i = 0; i < n; i++) at.push({ dx: PAD + i * (CARD_W + GAP), dy: PAD + lane - lift(i) });
    const k = Math.max(n, minSlots);
    return { w: 2 * PAD + k * CARD_W + (k - 1) * GAP, h: 2 * PAD + lane + CARD_H, at };
  }
  if (layout === 'grid') {
    const cols = gridCols(Math.max(n, minSlots));
    const pitch = CARD_H + GAP + lane;
    for (let i = 0; i < n; i++) at.push({ dx: PAD + (i % cols) * (CARD_W + GAP), dy: PAD + lane + Math.floor(i / cols) * pitch - lift(i) });
    const rows = Math.max(1, Math.ceil(n / cols));
    return { w: 2 * PAD + cols * CARD_W + (cols - 1) * GAP, h: 2 * PAD + rows * (CARD_H + lane) + (rows - 1) * GAP, at };
  }
  // fan: overlapping, bottom-anchored, slight arc; rotation is display-only
  const step = fanStep(n);
  const mid = (n - 1) / 2;
  const spread = n > 1 ? Math.min(3, 24 / (n - 1)) : 0;
  const arc = Math.min(16, n * 2);
  for (let i = 0; i < n; i++) {
    const t = mid ? (i - mid) / mid : 0;
    at.push({ dx: PAD + i * step, dy: PAD + 6 + lane + Math.round(t * t * arc) - lift(i), angle: +((i - mid) * spread).toFixed(2) || undefined });
  }
  const span = Math.max((n - 1) * step + CARD_W, minSlots * CARD_W + (minSlots - 1) * GAP);
  return { w: 2 * PAD + span, h: 2 * PAD + CARD_H + 6 + arc + lane, at };
}

/** Insertion index for a point (world coords) dropped onto container `c` holding `n` cards. */
export function slotIndex(c: CanvasNode, n: number, at: { x: number; y: number }): number {
  const layout = layoutOf(c);
  const lx = at.x - c.x - PAD;
  const ly = at.y - c.y - PAD;
  let i: number;
  if (layout === 'grid') {
    const cols = gridCols(n + 1);
    const col = Math.max(0, Math.min(cols - 1, Math.floor(lx / (CARD_W + GAP))));
    const row = Math.max(0, Math.floor(ly / (CARD_H + GAP + laneOf(c))));
    i = row * cols + col;
  } else {
    const step = layout === 'row' ? CARD_W + GAP : fanStep(n + 1);
    i = Math.round((lx - CARD_W / 2) / step + 0.5);
  }
  return Math.max(0, Math.min(n, i));
}

const minSlotsOf = (c: CanvasNode) => (isHand(c) ? 3 : 1);
/** A hand keeps a lane above its row for cards shown to the table. */
export const laneOf = (c: CanvasNode) => (isHand(c) ? RAISE : 0);

/** A container's slots for its current cards (hands: shown cards raised). */
export function slotsOf(c: CanvasNode, cards: CanvasNode[]): Slots {
  const hand = isHand(c);
  return slots(layoutOf(c), cards.length, minSlotsOf(c), { lane: laneOf(c), raised: hand ? (i) => card(cards[i]).faceUp : undefined });
}

/** Size of a new empty hand (fan). */
export const emptyHandSize = () => slots('fan', 0, 3, { lane: RAISE });

/**
 * Drag-up classification: a card whose top lands at `topY` (world) as card `index` of `n` in `hand`
 * counts as raised (shown) when it is more than halfway up from its row position to the raised one.
 */
export function liftedDrop(hand: CanvasNode, n: number, index: number, topY: number): boolean {
  const s = slots(layoutOf(hand), n, minSlotsOf(hand), { lane: laneOf(hand) });
  const row = hand.y + (s.at[Math.max(0, Math.min(n - 1, index))]?.dy ?? PAD + laneOf(hand));
  return topY < row - laneOf(hand) / 2;
}

/** The core layout rule: size every spread-out container and place its cards above it, in order. */
export const cardLayouts: LayoutRule = (doc: DocView) => {
  const out = new Map<string, Placement>();
  for (const c of doc.nodes) {
    if (!isSpreadOut(c)) continue;
    const cards = cardsIn(doc, c.id);
    const s = slotsOf(c, cards);
    out.set(c.id, { width: s.w, height: s.h });
    const z = c.z ?? 0;
    cards.forEach((card, i) => {
      const a = s.at[i];
      out.set(card.id, { x: c.x + a.dx, y: c.y + a.dy, z: z + (i + 1) / 1000, width: CARD_W, height: CARD_H, angle: a.angle });
    });
  }
  return out;
};
