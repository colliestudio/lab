import { FILES, solidGlyph, pieceName, type BoardField, type PieceField } from './model';

// Board and pieces are drawn from data: CSS grid squares, Unicode glyphs. No image assets.

/** The board: frame, 8x8 squares (last move tinted), file/rank labels, and a tab to grab it by. */
export function boardHtml(b: BoardField): string {
  const flipped = !!b.flipped;
  let squares = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = flipped ? 7 - col : col;
      const rank = flipped ? row : 7 - row;
      const sq = FILES[file] + (rank + 1);
      const light = (file + rank) % 2 === 1;
      const last = sq === b.from || sq === b.to;
      squares += `<i class="ch-sq ${light ? 'ch-light' : 'ch-dark'}${last ? ' ch-last' : ''}"></i>`;
    }
  }
  const files = Array.from({ length: 8 }, (_, c) => `<span>${FILES[flipped ? 7 - c : c]}</span>`).join('');
  const ranks = Array.from({ length: 8 }, (_, r) => `<span>${flipped ? r + 1 : 8 - r}</span>`).join('');
  const lock = b.unlocked ? '' : '<span class="ch-lock" title="Locked: drag the tab to move the board">🔒︎</span>';
  return (
    `<div class="ch-board${b.unlocked ? ' ch-unlocked' : ''}">` +
    `<div class="ch-grid">${squares}</div>` +
    `<div class="ch-files ch-top">${files}</div><div class="ch-files ch-bottom">${files}</div>` +
    `<div class="ch-ranks ch-left">${ranks}</div><div class="ch-ranks ch-right">${ranks}</div>` +
    `<div class="ch-grip" data-grip title="Click for board actions • drag here to move the board with its pieces">` +
    `<span class="ch-grip-dots">⠿</span>Chess${flipped ? ' · black' : ''}${lock}</div>` +
    `</div>`
  );
}

/** A piece: the solid glyph, filled white or black with a contrasting outline. */
export function pieceHtml(p: PieceField): string {
  return `<div class="ch-piece ch-${p.color}" title="${pieceName(p)}"><span>${solidGlyph(p.piece)}︎</span></div>`;
}
