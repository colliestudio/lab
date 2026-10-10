import type { CanvasNode, DocView, LayoutRule, Placement } from '../../core';
import { CARD_H, CARD_W, FIELD, cardsIn, isHand, isSpreadOut, layoutOf, type DeckField, type Layout } from './deck';

// Where a container's cards go. Pure geometry; applied at read time through the core layout hook,
// so the doc only stores each card's container + order (sync-friendly, nothing to rewrite).

export const PAD = 14;
const GAP = 10;
/** How much of each card shows above (column: below) the next one in a column. */
export const COLUMN_STEP = 46;
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

/** Card offsets inside a container (relative to its top-left), and the container's size. */
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
    if (!isSpreadOut(c)) continue;
    const cards = cardsIn(doc, c.id);
    const s = slots(layoutOf(c), cards.length, minSlotsOf(c), colsOf(c));
    out.set(c.id, { width: s.w, height: s.h });
    const z = c.z ?? 0;
    cards.forEach((card, i) => {
      const a = s.at[i];
      out.set(card.id, { x: c.x + a.dx, y: c.y + a.dy, z: z + (i + 1) / 1000, width: CARD_W, height: CARD_H, angle: a.angle });
    });
  }
  return out;
};
