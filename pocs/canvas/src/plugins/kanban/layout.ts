import type { DocView, ParentOf, Placement } from '../../core';
import { CARD_GAP, CARD_H, CARD_W, COLUMN_LIMIT, FOOT, HEADER, COL_HEAD, PAD, board, boardWidth, cardsTop, colX, column, columnsOf, isBoard, isTask, task } from './model';

/** A task lives in its board (deleted with it, hidden unless the layout places it). */
export const parentRule: ParentOf = (n, get) => {
  if (!isTask(n)) return;
  const b = task(n).board;
  return isBoard(get(b)) ? b : undefined;
};

/** Cards shown in a column: all when expanded, else the first COLUMN_LIMIT. */
export function shownCount(total: number, expanded: boolean) {
  return expanded ? total : Math.min(total, COLUMN_LIMIT);
}

/** Columns side by side, cards stacked; the board grows to fit (derived, never stored). */
export function layoutRule(doc: DocView): Map<string, Placement> {
  const out = new Map<string, Placement>();
  for (const b of doc.nodes) {
    if (!isBoard(b)) continue;
    const bf = board(b);
    const cols = columnsOf(doc, b);
    let rows = 1;
    cols.forEach((status, i) => {
      const cards = column(doc, b.id, status);
      const n = shownCount(cards.length, !!bf.expanded?.includes(status));
      rows = Math.max(rows, n);
      cards.slice(0, n).forEach((c, j) => {
        out.set(c.id, {
          x: colX(b, i) + 8,
          y: cardsTop(b) + j * (CARD_H + CARD_GAP),
          z: (b.z ?? 0) + (i * 1000 + j + 1) / 1e6,
          width: CARD_W,
          height: CARD_H,
        });
      });
    });
    out.set(b.id, { width: boardWidth(cols.length), height: HEADER + COL_HEAD + rows * (CARD_H + CARD_GAP) + FOOT + PAD });
  }
  return out;
}
