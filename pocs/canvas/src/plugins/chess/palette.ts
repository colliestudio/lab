import type { App, CanvasNode } from '../../core';
import { KINDS, SQ, boardUnder, inZone, isBoard, isPiece, pieceName, type Color, type Kind } from './model';
import { pieceHtml } from './render';

// Piece palette: a small floating panel with the 12 pieces. Drag one onto a board (snaps, captures)
// or the table (lies free); click one to put it beside the board in play.

const DRAG_PX = 4;

/** The board a click-spawn goes to: a selected board, else the board of a selected piece. */
export function targetBoard(app: App, sel: CanvasNode[] = app.selected()): CanvasNode | undefined {
  const b = sel.filter(isBoard).at(-1);
  if (b) return b;
  const p = sel.filter(isPiece).at(-1);
  const id = p && app.doc.carrierOf(p.id);
  return id ? app.node(id) : undefined;
}

export function mountPalette(app: App) {
  const panel = document.createElement('div');
  panel.className = 'ch-palette';
  panel.hidden = true;
  panel.innerHTML =
    `<div class="ch-pal-head"><span>Pieces</span><button type="button" title="Close">×</button></div>` +
    `<div class="ch-pal-grid">` +
    (['w', 'b'] as Color[])
      .flatMap((color) =>
        KINDS.map(
          (kind) =>
            `<div class="ch-pal-cell" data-piece="${kind}" data-color="${color}" title="${pieceName({ piece: kind, color })}: drag onto a board or the table, or click">` +
            pieceHtml({ piece: kind, color }) +
            `</div>`,
        ),
      )
      .join('') +
    `</div><div class="ch-pal-hint">Drag onto a square or the table • click: beside the selected board</div>`;
  document.body.append(panel);
  panel.querySelector('button')!.addEventListener('click', () => close());

  let drag: { kind: Kind; color: Color; x: number; y: number; ghost?: HTMLElement } | null = null;
  panel.addEventListener('pointerdown', (e) => {
    const cell = (e.target as Element).closest<HTMLElement>('.ch-pal-cell');
    if (!cell || e.button !== 0) return;
    e.preventDefault();
    cell.setPointerCapture(e.pointerId);
    drag = { kind: cell.dataset.piece as Kind, color: cell.dataset.color as Color, x: e.clientX, y: e.clientY };
  });
  panel.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_PX) return;
      drag.ghost = document.createElement('div');
      drag.ghost.className = 'ch-pal-ghost';
      drag.ghost.innerHTML = pieceHtml({ piece: drag.kind, color: drag.color });
      document.body.append(drag.ghost);
    }
    const size = SQ * app.viewport.zoom;
    Object.assign(drag.ghost.style, { width: `${size}px`, height: `${size}px`, left: `${e.clientX - size / 2}px`, top: `${e.clientY - size / 2}px` });
  });
  const end = (e: PointerEvent, cancel = false) => {
    const d = drag;
    drag = null;
    if (!d) return;
    d.ghost?.remove();
    if (cancel) return;
    const { kind: piece, color } = d;
    if (!d.ghost) {
      // click: beside the board in play (selected, else the one in the middle of the view), else
      // free in the middle of the view; never straight onto a square (that would capture)
      const c = app.viewCenter();
      const b = targetBoard(app) ?? boardUnder(app.doc, c.x, c.y, (n) => inZone(n, c.x, c.y));
      if (b) app.dispatch('chess.spawn', { piece, color, board: b.id, keepSelection: true });
      else app.dispatch('chess.spawn', { piece, color, ...c, keepSelection: true });
      return;
    }
    const root = app.view.root;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (!under || !root.contains(under) || under.closest('.cv-menu')) return; // dropped on the toolbar, the panel…
    const r = root.getBoundingClientRect();
    const [x, y] = app.viewport.toWorld(e.clientX - r.left, e.clientY - r.top);
    app.dispatch('chess.spawn', { piece, color, x, y });
  };
  panel.addEventListener('pointerup', (e) => end(e));
  panel.addEventListener('pointercancel', (e) => end(e, true));

  const open = () => (panel.hidden = false);
  const close = () => (panel.hidden = true);
  const toggle = () => (panel.hidden = !panel.hidden);
  return { open, close, toggle, el: panel };
}
