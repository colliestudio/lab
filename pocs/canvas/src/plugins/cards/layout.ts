import type { CanvasNode, DocView, LayoutRule, Placement } from '../../core';
import { CARD_H, CARD_W, FIELD, allowsShowing, cardsIn, isHand, isSpreadOut, layoutOf, shownIn, type DeckField, type Layout } from './deck';

// Where a container's cards go. Pure geometry; applied at read time through the core layout hook,
// so the doc only stores each card's container + order (sync-friendly, nothing to rewrite).

export const PAD = 14;
const GAP = 10;
/** Height of a hand's "shown to table" strip above its row (when the hand allows showing). */
export const RAISE = Math.round(CARD_H * 0.4);
const MAX_FAN = 640;

export interface Slots {
  w: number;
  h: number;
  at: { dx: number; dy: number; angle?: number }[];
}

const gridCols = (n: number) => Math.max(1, Math.ceil(Math.sqrt(n)));
const fanStep = (n: number) => (n > 1 ? Math.min(40, (MAX_FAN - CARD_W) / (n - 1)) : 40);

/** Card offsets inside a group (relative to its top-left), and the group's size (it grows with its cards). */
export function slots(layout: Layout, n: number, minSlots = 1): Slots {
  const at: Slots['at'] = [];
  if (layout === 'row') {
    for (let i = 0; i < n; i++) at.push({ dx: PAD + i * (CARD_W + GAP), dy: PAD });
    const k = Math.max(n, minSlots);
    return { w: 2 * PAD + k * CARD_W + (k - 1) * GAP, h: 2 * PAD + CARD_H, at };
  }
  if (layout === 'grid') {
    const cols = gridCols(Math.max(n, minSlots));
    for (let i = 0; i < n; i++) at.push({ dx: PAD + (i % cols) * (CARD_W + GAP), dy: PAD + Math.floor(i / cols) * (CARD_H + GAP) });
    const rows = Math.max(1, Math.ceil(n / cols));
    return { w: 2 * PAD + cols * CARD_W + (cols - 1) * GAP, h: 2 * PAD + rows * CARD_H + (rows - 1) * GAP, at };
  }
  // fan: overlapping, bottom-anchored, slight arc; rotation is display-only
  const step = fanStep(n);
  const mid = (n - 1) / 2;
  const spread = n > 1 ? Math.min(3, 24 / (n - 1)) : 0;
  const arc = Math.min(16, n * 2);
  for (let i = 0; i < n; i++) {
    const t = mid ? (i - mid) / mid : 0;
    at.push({ dx: PAD + i * step, dy: PAD + 6 + Math.round(t * t * arc), angle: +((i - mid) * spread).toFixed(2) || undefined });
  }
  const span = Math.max((n - 1) * step + CARD_W, minSlots * CARD_W + (minSlots - 1) * GAP);
  return { w: 2 * PAD + span, h: 2 * PAD + CARD_H + 6 + arc, at };
}

// ---- hands: a fixed frame (same for everyone, whatever the count); cards compress to fit

/** Widest fan step in a hand; the default frame holds 7 cards at this step. */
export const HAND_STEP = 60;
export const HAND_W = 2 * PAD + CARD_W + 6 * HAND_STEP;
export const HAND_MIN_W = 2 * PAD + CARD_W + 2 * 24;
export const HAND_MAX_W = 2400;
const HAND_ARC = 12;

export const handWidth = (h: CanvasNode): number => {
  const w = (h[FIELD] as DeckField | undefined)?.width;
  return typeof w === 'number' && Number.isFinite(w) ? Math.max(HAND_MIN_W, Math.min(HAND_MAX_W, Math.round(w))) : HAND_W;
};
/** A hand that allows showing keeps a strip above its row for shown cards. */
export const laneOf = (c: CanvasNode) => (isHand(c) && allowsShowing(c) ? RAISE : 0);
export const handHeight = (h: CanvasNode) => 2 * PAD + laneOf(h) + 6 + HAND_ARC + CARD_H;
/** y (from the frame's top) where the private row starts. */
export const rowTop = (h: CanvasNode) => PAD + laneOf(h) + 6;

const handStep = (h: CanvasNode) => (layoutOf(h) === 'fan' ? HAND_STEP : CARD_W + GAP);
/** x offsets of `n` cards spread centered in the frame, at most `max` apart (closer when they don't fit). */
function spreadX(n: number, width: number, max: number): number[] {
  const inner = width - 2 * PAD;
  const step = n > 1 ? Math.min(max, (inner - CARD_W) / (n - 1)) : 0;
  const x0 = PAD + Math.max(0, (inner - ((n - 1) * step + CARD_W)) / 2);
  return Array.from({ length: n }, (_, i) => Math.round(x0 + i * step));
}

/**
 * A hand's slots: shown cards in the strip at the top (spread on their own, so their spots say nothing
 * about the private cards), private cards in the row below (fan: slight arc). `shown[i]` per card.
 */
export function handSlots(h: CanvasNode, shown: boolean[]): Slots {
  const w = handWidth(h);
  const at: Slots['at'] = [];
  const s = shown.flatMap((v, i) => (v ? [i] : []));
  const p = shown.flatMap((v, i) => (v ? [] : [i]));
  spreadX(s.length, w, handStep(h)).forEach((dx, k) => (at[s[k]] = { dx, dy: PAD }));
  const fan = layoutOf(h) === 'fan';
  const mid = (p.length - 1) / 2;
  const tilt = p.length > 1 ? Math.min(3, 24 / (p.length - 1)) : 0;
  spreadX(p.length, w, handStep(h)).forEach((dx, k) => {
    const t = mid ? (k - mid) / mid : 0;
    at[p[k]] = fan ? { dx, dy: rowTop(h) + Math.round(t * t * HAND_ARC), angle: +((k - mid) * tilt).toFixed(2) || undefined } : { dx, dy: rowTop(h) + HAND_ARC / 2 };
  });
  return { w, h: handHeight(h), at };
}

/** Insertion index among `n` cards of one part of a hand (strip or row) for a drop at world x. */
export function handSlotIndex(h: CanvasNode, n: number, x: number): number {
  const xs = spreadX(n + 1, handWidth(h), handStep(h));
  let best = 0;
  xs.forEach((dx, k) => {
    if (Math.abs(h.x + dx + CARD_W / 2 - x) < Math.abs(h.x + xs[best] + CARD_W / 2 - x)) best = k;
  });
  return best;
}

/** World y of the drag-up threshold: a card whose top is above it lands in the strip (shown). */
export const thresholdY = (h: CanvasNode) => h.y + PAD + Math.round((laneOf(h) + 6) / 2);

/** Drag-up classification: shown when the hand allows showing and the card's top is above the threshold. */
export const liftedDrop = (hand: CanvasNode, topY: number): boolean => laneOf(hand) > 0 && topY < thresholdY(hand);

/** Size of a new empty hand. */
export const emptyHandSize = () => ({ w: HAND_W, h: 2 * PAD + 6 + HAND_ARC + CARD_H });

/** Insertion index for a point (world coords) dropped onto container `c` holding `n` cards. */
export function slotIndex(c: CanvasNode, n: number, at: { x: number; y: number }): number {
  const layout = layoutOf(c);
  const lx = at.x - c.x - PAD;
  const ly = at.y - c.y - PAD;
  let i: number;
  if (layout === 'grid') {
    const cols = gridCols(n + 1);
    const col = Math.max(0, Math.min(cols - 1, Math.floor(lx / (CARD_W + GAP))));
    const row = Math.max(0, Math.floor(ly / (CARD_H + GAP)));
    i = row * cols + col;
  } else {
    const step = layout === 'row' ? CARD_W + GAP : fanStep(n + 1);
    i = Math.round((lx - CARD_W / 2) / step + 0.5);
  }
  return Math.max(0, Math.min(n, i));
}

const minSlotsOf = (c: CanvasNode) => (isHand(c) ? 3 : 1);

/** The core layout rule: size every spread-out container and place its cards above it, in order. */
export const cardLayouts: LayoutRule = (doc: DocView) => {
  const out = new Map<string, Placement>();
  for (const c of doc.nodes) {
    if (!isSpreadOut(c)) continue;
    const cards = cardsIn(doc, c.id);
    const hand = isHand(c);
    const shown = cards.map((x) => hand && shownIn(c, x));
    const s = hand ? handSlots(c, shown) : slots(layoutOf(c), cards.length, minSlotsOf(c));
    out.set(c.id, { width: s.w, height: s.h });
    const z = c.z ?? 0;
    // in a hand the strip lies under the row (the row's corners stay readable)
    const rank = (i: number) => (hand ? (shown[i] ? i : cards.length + i) : i);
    cards.forEach((card, i) => {
      const a = s.at[i];
      out.set(card.id, { x: c.x + a.dx, y: c.y + a.dy, z: z + (rank(i) + 1) / 1000, width: CARD_W, height: CARD_H, angle: a.angle });
    });
  }
  return out;
};
