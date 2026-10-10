import type { CanvasNode, DocView, LayoutRule, Placement } from '../../core';
import { CARD_H, CARD_W, FIELD, allowsShowing, areaOf, cardsIn, isDeck, hasFixedFrame, isHand, isSpreadOut, layoutOf, shownIn, type DeckField, type Layout } from './deck';

// Where a container's cards go. Pure geometry; applied at read time through the core layout hook,
// so the doc only stores each card's container + order (sync-friendly, nothing to rewrite).

export const PAD = 14;
const GAP = 10;
/** How much of each card shows above (column: below) the next one in a column. */
export const COLUMN_STEP = 46;
/** Height of a hand's "shown to table" strip above its row (when the hand allows showing). */
export const RAISE = Math.round(CARD_H * 0.4);
const MAX_FAN = 640;

export interface Slots {
  w: number;
  h: number;
  at: { dx: number; dy: number; angle?: number }[];
}

/** Grid columns: the container's own `cols` (e.g. 13 = a suit per row), else about square. */
const gridCols = (n: number, cols?: number) => cols ?? Math.max(1, Math.ceil(Math.sqrt(n)));
export const colsOf = (c: CanvasNode) => (c[FIELD] as DeckField).cols;
const fanStep = (n: number) => (n > 1 ? Math.min(40, (MAX_FAN - CARD_W) / (n - 1)) : 40);

/** Card offsets inside a group (relative to its top-left), and the group's size (it grows with its cards). */
export function slots(layout: Layout, n: number, minSlots = 1, cols?: number): Slots {
  const at: Slots['at'] = [];
  if (layout === 'column' || layout === 'column-up') {
    const k = Math.max(n, minSlots);
    const h = 2 * PAD + CARD_H + (k - 1) * COLUMN_STEP;
    for (let i = 0; i < n; i++) at.push({ dx: PAD, dy: layout === 'column' ? PAD + i * COLUMN_STEP : h - PAD - CARD_H - i * COLUMN_STEP });
    return { w: 2 * PAD + CARD_W, h, at };
  }
  if (layout === 'row') {
    for (let i = 0; i < n; i++) at.push({ dx: PAD + i * (CARD_W + GAP), dy: PAD });
    const k = Math.max(n, minSlots);
    return { w: 2 * PAD + k * CARD_W + (k - 1) * GAP, h: 2 * PAD + CARD_H, at };
  }
  if (layout === 'grid') {
    const k = gridCols(Math.max(n, minSlots), cols);
    for (let i = 0; i < n; i++) at.push({ dx: PAD + (i % k) * (CARD_W + GAP), dy: PAD + Math.floor(i / k) * (CARD_H + GAP) });
    const rows = Math.max(1, Math.ceil(n / k));
    return { w: 2 * PAD + k * CARD_W + (k - 1) * GAP, h: 2 * PAD + rows * CARD_H + (rows - 1) * GAP, at };
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
/** A growing frame's step for `n` cards: as groups (fan: up to 40, squeezing past MAX_FAN). */
const growStep = (h: CanvasNode, n: number) => (layoutOf(h) === 'fan' ? fanStep(n) : CARD_W + GAP);
const span = (n: number, step: number) => (n ? (n - 1) * step + CARD_W : 0);
/** x offsets of `n` cards spread centered in the frame, at most `max` apart (closer when they don't fit). */
function spreadX(n: number, width: number, max: number): number[] {
  const inner = width - 2 * PAD;
  const step = n > 1 ? Math.min(max, (inner - CARD_W) / (n - 1)) : 0;
  const x0 = PAD + Math.max(0, (inner - ((n - 1) * step + CARD_W)) / 2);
  return Array.from({ length: n }, (_, i) => Math.round(x0 + i * step));
}
/** x offsets of one part (strip or row) of `n` cards: fixed frame = centered, squeezed to fit; else from the left. */
const partX = (h: CanvasNode, n: number, width: number) =>
  hasFixedFrame(h) ? spreadX(n, width, handStep(h)) : Array.from({ length: n }, (_, i) => Math.round(PAD + i * growStep(h, n)));
/** Frame width: fixed (Fixed frame size), else it grows with the longer part (at least 3 cards wide). */
const frameWidth = (h: CanvasNode, nShown: number, nPrivate: number) =>
  hasFixedFrame(h) ? handWidth(h) : 2 * PAD + Math.max(3 * CARD_W + 2 * GAP, span(nShown, growStep(h, nShown)), span(nPrivate, growStep(h, nPrivate)));

/**
 * A hand's slots: shown cards in the strip at the top (spread on their own, so their spots say nothing
 * about the private cards), private cards in the row below (fan: slight arc). `shown[i]` per card.
 */
export function handSlots(h: CanvasNode, shown: boolean[]): Slots {
  const at: Slots['at'] = [];
  const s = shown.flatMap((v, i) => (v ? [i] : []));
  const p = shown.flatMap((v, i) => (v ? [] : [i]));
  const w = frameWidth(h, s.length, p.length);
  partX(h, s.length, w).forEach((dx, k) => (at[s[k]] = { dx, dy: PAD }));
  const fan = layoutOf(h) === 'fan';
  const mid = (p.length - 1) / 2;
  const tilt = p.length > 1 ? Math.min(3, 24 / (p.length - 1)) : 0;
  partX(h, p.length, w).forEach((dx, k) => {
    const t = mid ? (k - mid) / mid : 0;
    at[p[k]] = fan ? { dx, dy: rowTop(h) + Math.round(t * t * HAND_ARC), angle: +((k - mid) * tilt).toFixed(2) || undefined } : { dx, dy: rowTop(h) + HAND_ARC / 2 };
  });
  return { w, h: handHeight(h), at };
}

/** Insertion index among `n` cards of one part of a hand (strip or row) for a drop at world x. */
export function handSlotIndex(h: CanvasNode, n: number, x: number): number {
  const xs = partX(h, n + 1, hasFixedFrame(h) ? handWidth(h) : frameWidth(h, 0, n + 1));
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
export const emptyHandSize = () => ({ w: 2 * PAD + 3 * CARD_W + 2 * GAP, h: 2 * PAD + 6 + HAND_ARC + CARD_H });

/** Insertion index for a point (world coords) dropped onto container `c` holding `n` cards. */
export function slotIndex(c: CanvasNode, n: number, at: { x: number; y: number }): number {
  const layout = layoutOf(c);
  const lx = at.x - c.x - PAD;
  const ly = at.y - c.y - PAD;
  let i: number;
  if (layout === 'column' || layout === 'column-up') return n; // a column fills its next free slot
  if (layout === 'grid') {
    const cols = gridCols(n + 1, colsOf(c));
    const col = Math.max(0, Math.min(cols - 1, Math.floor(lx / (CARD_W + GAP))));
    const row = Math.max(0, Math.floor(ly / (CARD_H + GAP)));
    i = row * cols + col;
  } else {
    const step = layout === 'row' ? CARD_W + GAP : fanStep(n + 1);
    i = Math.round((lx - CARD_W / 2) / step + 0.5);
  }
  return Math.max(0, Math.min(n, i));
}

/** Slots a container is sized for when it holds fewer cards: its `max` or `slots`, a hand 3, else 1. */
export const minSlotsOf = (c: CanvasNode) => {
  const f = c[FIELD] as DeckField;
  return f.max ?? f.slots ?? (isHand(c) ? 3 : 1);
};

/** The core layout rule: size every spread-out container and place its cards above it, in order. */
export const cardLayouts: LayoutRule = (doc: DocView) => {
  const out = new Map<string, Placement>();
  for (const c of doc.nodes) {
    const area = areaOf(c);
    if (!isSpreadOut(c)) {
      // a pile with a fixed area (a mat's zone) is as big as the area (the pile is drawn in its middle)
      if (area && isDeck(c)) out.set(c.id, { width: area.w, height: area.h });
      continue;
    }
    const cards = cardsIn(doc, c.id);
    const hand = isHand(c);
    const shown = cards.map((x) => hand && shownIn(c, x));
    const s = hand ? handSlots(c, shown) : slots(layoutOf(c), cards.length, minSlotsOf(c), colsOf(c));
    out.set(c.id, { width: Math.max(s.w, area?.w ?? 0), height: Math.max(s.h, area?.h ?? 0) });
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
