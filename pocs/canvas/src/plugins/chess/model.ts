import type { CanvasNode, DocView } from '../../core';

// Chess kit data. A board node and 32 piece nodes, all standard JSON Canvas text nodes with an
// `x-chess` field. A piece on a board stores `board` (the board's id) and `square` ("e4"); a piece
// with `board` but no `square` lies in that board's capture area. Either way it rides on the board
// (moves with it). A piece without `board` lies free on the table.

export const FIELD = 'x-chess';
/** Square size, the frame around the 8x8 grid (file/rank labels) and the whole board, in world px. */
export const SQ = 64;
export const MARGIN = 28;
export const BOARD = 8 * SQ + 2 * MARGIN;
/** Gap between the board and its capture rows (the board's tab sits in the top one). */
export const CAP_GAP = 34;
/** Capture rows on each side of the board (8 pieces per row). */
export const CAP_ROWS = 2;

export const KINDS = ['K', 'Q', 'R', 'B', 'N', 'P'] as const;
export type Kind = (typeof KINDS)[number];
export type Color = 'w' | 'b';
export const FILES = 'abcdefgh';

export interface PieceField {
  piece: Kind;
  color: Color;
  board?: string;
  square?: string;
  /** The board whose set this piece belongs to (Set up gathers it back). */
  home?: string;
}
export interface BoardField {
  kind: 'board';
  /** Seen from black (rotated 180°). */
  flipped?: boolean;
  /** Boards are locked by default: dragging the surface box-selects; the tab moves the board. */
  unlocked?: boolean;
  /** Last move, highlighted on the board. */
  from?: string;
  to?: string;
  // Game fields (rules mode, see game.ts). Without `rules` the board is free play: no turns, no checks.
  /** Moves must be legal and alternate; pieces bounce back from illegal drops. */
  rules?: boolean;
  turn?: Color;
  /** Subset of "KQkq". */
  castling?: string;
  /** En passant target square. */
  ep?: string;
  /** Half-moves since a capture or pawn move (fifty-move rule); full move number. */
  half?: number;
  full?: number;
  /** The game so far, in SAN. */
  moves?: string[];
  /** FEN the moves start from, when the game did not start from the standard position (rules turned on mid-game). */
  start?: string;
  /** "1-0", "0-1", "1/2-1/2" once the game is over, and why ("checkmate", "resigned"…). */
  result?: string;
  end?: string;
  /** Who plays which color (a person, an agent, a bot). Empty seat: anyone may move that color. */
  white?: SeatField;
  black?: SeatField;
}
export interface SeatField {
  id: string;
  name: string;
}

const NAMES: Record<Kind, string> = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
const WHITE: Record<Kind, string> = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' };
const BLACK: Record<Kind, string> = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
/** Outline glyph for white, solid for black (the readable form in exports). */
export const glyph = (kind: Kind, color: Color) => (color === 'w' ? WHITE : BLACK)[kind];
/** Solid glyph (rendering fills it per color). */
export const solidGlyph = (kind: Kind) => BLACK[kind];
export const pieceName = (p: PieceField) => `${p.color === 'w' ? 'white' : 'black'} ${NAMES[p.piece]}`;
export const pieceText = (p: Pick<PieceField, 'piece' | 'color' | 'square'>) => glyph(p.piece, p.color) + (p.square ? ` ${p.square}` : '');

export const isKind = (v: unknown): v is Kind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);
export const isColor = (v: unknown): v is Color => v === 'w' || v === 'b';
export const isSquare = (v: unknown): v is string => typeof v === 'string' && /^[a-h][1-8]$/.test(v);

const field = (n: CanvasNode) => n[FIELD] as Record<string, unknown> | undefined;
export const isBoard = (n: CanvasNode | undefined): boolean => !!n && field(n)?.kind === 'board';
export const isPiece = (n: CanvasNode | undefined): boolean => !!n && isKind(field(n)?.piece) && isColor(field(n)?.color);
export const piece = (n: CanvasNode) => n[FIELD] as PieceField;
export const board = (n: CanvasNode) => n[FIELD] as BoardField;

/** The board a piece rides on (only if that board exists). */
export function boardIdOf(n: CanvasNode, get: (id: string) => CanvasNode | undefined): string | undefined {
  if (!isPiece(n)) return;
  const b = piece(n).board;
  return b && isBoard(get(b)) ? b : undefined;
}

// ------------------------------------------------------------------ geometry

/** Square under world point (x, y), if it is on the board's grid. */
export function squareAt(b: CanvasNode, x: number, y: number): string | undefined {
  const col = Math.floor((x - b.x - MARGIN) / SQ);
  const row = Math.floor((y - b.y - MARGIN) / SQ);
  if (col < 0 || col > 7 || row < 0 || row > 7) return;
  const flipped = !!board(b).flipped;
  const file = flipped ? 7 - col : col;
  const rank = flipped ? row : 7 - row;
  return FILES[file] + (rank + 1);
}

/** Top-left of a piece standing on `square`. */
export function squarePos(b: CanvasNode, square: string, flipped = !!board(b).flipped): { x: number; y: number } {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]) - 1;
  const col = flipped ? 7 - file : file;
  const row = flipped ? rank : 7 - rank;
  return { x: b.x + MARGIN + col * SQ, y: b.y + MARGIN + row * SQ };
}

/** Board plus its capture rows above and below: drop a piece here (off the grid) and it stays with the board. */
export function zone(b: { x: number; y: number }) {
  const pad = CAP_GAP + CAP_ROWS * SQ;
  return { x: b.x, y: b.y - pad, w: BOARD, h: BOARD + 2 * pad };
}
export const inZone = (b: CanvasNode, x: number, y: number) => {
  const z = zone(b);
  return x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h;
};

export const center = (n: CanvasNode) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });

/**
 * Slots beside board `b` for a piece of `color`, nearest first, 8 per row, rows going outwards.
 * `capturer`: a captured piece goes to the side of the player who took it (players keep what they
 * took: a black piece below the board, white's side, unless flipped). `owner`: pieces set aside
 * (Clear, Set up extras, spawned beside the board) go to their own player's side.
 */
export function captureSlots(b: CanvasNode, color: Color, side: 'owner' | 'capturer' = 'capturer'): { x: number; y: number }[] {
  const white = side === 'owner' ? color === 'w' : color === 'b';
  const below = white !== !!board(b).flipped;
  const out: { x: number; y: number }[] = [];
  for (let r = 0; r < CAP_ROWS; r++)
    for (let c = 0; c < 8; c++)
      out.push({
        x: b.x + MARGIN + c * SQ,
        y: below ? b.y + BOARD + CAP_GAP + r * SQ : b.y - CAP_GAP - SQ - r * SQ,
      });
  return out;
}

/** Topmost board passing `test` at world point (x, y); default: its grid holds the point. */
export function boardUnder(doc: DocView, x: number, y: number, test: (b: CanvasNode) => boolean = (b) => !!squareAt(b, x, y)) {
  for (let i = doc.visible.length - 1; i >= 0; i--) {
    const n = doc.visible[i];
    if (isBoard(n) && test(n)) return n;
  }
}

export const START: [Kind, Color, string][] = (() => {
  const back: Kind[] = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
  const out: [Kind, Color, string][] = [];
  for (let f = 0; f < 8; f++) {
    out.push([back[f], 'w', FILES[f] + '1'], ['P', 'w', FILES[f] + '2'], ['P', 'b', FILES[f] + '7'], [back[f], 'b', FILES[f] + '8']);
  }
  return out;
})();

export function boardNode(id: string, x: number, y: number, z?: number): CanvasNode {
  const f: BoardField = { kind: 'board' };
  return { id, type: 'text', x, y, width: BOARD, height: BOARD, text: 'Chessboard', z, [FIELD]: f };
}

export function pieceNode(id: string, x: number, y: number, p: PieceField, z?: number): CanvasNode {
  const f: PieceField = { piece: p.piece, color: p.color };
  if (p.board !== undefined) f.board = p.board;
  if (p.square !== undefined) f.square = p.square;
  if (p.home !== undefined) f.home = p.home;
  return { id, type: 'text', x, y, width: SQ, height: SQ, text: pieceText(f), z, [FIELD]: f };
}
