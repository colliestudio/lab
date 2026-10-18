import type { DocView, ParentOf, Placement } from '../../core';
import { CARD_GAP, CARD_H, CARD_W, COL_HEAD, FOOT, HEADER, PAD, ROW_H, ROW_W, board, boardWidth, cardsTop, colX, columnsOf, isBoard, isTask, shownIn, task } from './model';

/** A task lives in its board (deleted with it, hidden unless the layout places it). */
export const parentRule: ParentOf = (n, get) => {
  if (!isTask(n)) return;
  const b = task(n).board;
  return isBoard(get(b)) ? b : undefined;
};

const ROW_GAP = 4;

/** Columns side by side, cards stacked; Done's recent tasks as one-line rows; the board grows to fit (derived, never stored). */
export function layoutRule(doc: DocView): Map<string, Placement> {
  const out = new Map<string, Placement>();
  for (const b of doc.nodes) {
    if (!isBoard(b)) continue;
    const bf = board(b);
    const cols = columnsOf(doc, b);
    let tallest = 0;
    cols.forEach((status, i) => {
      const compact = status === bf.doneColumn;
      const h = compact ? ROW_H : CARD_H;
      const gap = compact ? ROW_GAP : CARD_GAP;
      const { shown } = shownIn(doc, b, status);
      shown.forEach((c, j) => {
        out.set(c.id, {
          x: colX(b, cols, i) + 8,
          y: cardsTop(b) + j * (h + gap),
          z: (b.z ?? 0) + (i * 1000 + j + 1) / 1e6,
          width: compact ? ROW_W : CARD_W,
          height: h,
        });
      });
      tallest = Math.max(tallest, shown.length * (h + gap));
    });
    out.set(b.id, { width: boardWidth(b, cols), height: HEADER + COL_HEAD + Math.max(tallest, CARD_H) + FOOT + PAD });
  }
  return out;
}
