import type { CanvasNode, DocFilter } from '../../core';
import { BOARD, FIELD, SQ, isColor, isKind, isSquare, pieceText, type BoardField, type PieceField } from './model';

// JSON Canvas import repair and export shaping for chess nodes.

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Make imported chess data safe: drop invalid `x-chess`, fix sizes, drop bad squares, unhook pieces
 * from missing boards, and when two pieces claim one square the later one moves to the capture side
 * (keeps its board, loses the square).
 */
export const repairImport: DocFilter = (doc) => {
  const out: CanvasNode[] = [];
  for (const n of doc.nodes) {
    const f = n[FIELD];
    if (f === undefined) {
      out.push(n);
      continue;
    }
    if (obj(f) && f.kind === 'board') {
      const b: BoardField = { kind: 'board' };
      if (f.flipped === true) b.flipped = true;
      if (f.unlocked === true) b.unlocked = true;
      if (isSquare(f.from)) b.from = f.from;
      if (isSquare(f.to)) b.to = f.to;
      if (f.rules === true) b.rules = true;
      if (isColor(f.turn)) b.turn = f.turn;
      if (typeof f.castling === 'string' && /^K?Q?k?q?$/.test(f.castling)) b.castling = f.castling;
      if (isSquare(f.ep)) b.ep = f.ep;
      if (Number.isInteger(f.half) && (f.half as number) >= 0) b.half = f.half as number;
      if (Number.isInteger(f.full) && (f.full as number) >= 1) b.full = f.full as number;
      if (Array.isArray(f.moves) && f.moves.every((m) => typeof m === 'string')) b.moves = f.moves as string[];
      if (typeof f.result === 'string') b.result = f.result;
      if (typeof f.end === 'string') b.end = f.end;
      for (const k of ['white', 'black'] as const) {
        const seat = f[k];
        if (obj(seat) && typeof seat.id === 'string' && typeof seat.name === 'string') b[k] = { id: seat.id, name: seat.name };
      }
      out.push({ ...n, width: BOARD, height: BOARD, text: n.text ?? 'Chessboard', [FIELD]: b });
      continue;
    }
    if (obj(f) && isKind(f.piece) && isColor(f.color)) {
      const p: PieceField = { piece: f.piece, color: f.color };
      if (typeof f.board === 'string') p.board = f.board;
      if (p.board && isSquare(f.square)) p.square = f.square;
      if (typeof f.home === 'string') p.home = f.home;
      out.push({ ...n, width: SQ, height: SQ, [FIELD]: p });
      continue;
    }
    const { [FIELD]: _drop, ...rest } = n;
    console.warn(`chess: ignoring invalid ${FIELD} on node ${n.id}`);
    out.push(rest as CanvasNode);
  }
  const boards = new Set(out.filter((n) => (n[FIELD] as BoardField | undefined)?.kind === 'board').map((n) => n.id));
  const claimed = new Set<string>();
  for (const n of out) {
    const p = n[FIELD] as PieceField | undefined;
    if (!p || !('piece' in p)) continue;
    if (p.home && !boards.has(p.home)) delete p.home;
    if (p.board && !boards.has(p.board)) {
      delete p.board;
      delete p.square;
    }
    if (p.board && p.square) {
      const key = `${p.board}:${p.square}`;
      if (claimed.has(key)) delete p.square;
      else claimed.add(key);
    }
    n.text = pieceText(p); // derived; `n` is our own copy
  }
  return { ...doc, nodes: out };
};

/** Export: readable text for Obsidian and other JSON Canvas apps ("♔ e1", "Chessboard"). */
export const shapeExport: DocFilter = (doc) => ({
  ...doc,
  nodes: doc.nodes.map((n) => {
    const f = n[FIELD] as (PieceField & BoardField) | undefined;
    if (!f) return n;
    if (f.kind === 'board') return { ...n, text: f.flipped ? 'Chessboard (seen from black)' : 'Chessboard' };
    if (isKind(f.piece) && isColor(f.color)) return { ...n, text: pieceText(f) };
    return n;
  }),
});
