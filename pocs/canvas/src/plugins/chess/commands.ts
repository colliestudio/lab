// value imports from core modules, not the core index (it pulls in the DOM app; the bridge runs this in Node)
import { isNum, pick } from '../../core/commands';
import { set } from '../../core/doc';
import type { CanvasNode, Change, Command, DocView, EventSpec } from '../../core';
import {
  BOARD,
  FIELD,
  SQ,
  START,
  board,
  boardNode,
  boardUnder,
  captureSlots,
  center,
  inZone,
  isBoard,
  isColor,
  isKind,
  isPiece,
  piece,
  pieceNode,
  squareAt,
  squarePos,
  pieceName,
  pieceText,
  zone,
  type Color,
  type Kind,
  type PieceField,
} from './model';

// Pure commands: (read-only doc, args, ctx) -> per-field changes. No DOM. Bad args = no-op.
// Free play: no rules. Pieces snap to squares, a piece dropped on an occupied square sends the
// occupant beside the board on the capturer's side, all in one undo step.

const F = (k: string) => `${FIELD}.${k}`;
const boardArg = (doc: DocView, id: unknown) => {
  const b = typeof id === 'string' ? doc.get(id) : undefined;
  return b && isBoard(b) ? b : undefined;
};

export type Spot = { board?: string; square?: string; x: number; y: number };

/**
 * Log entry for one piece put on a square of a board (free play: it says what happened, it doesn't
 * judge it): "White Nf3", "White exd5 (takes black pawn)". Nothing for nudges, several pieces, or
 * a piece put back where it was.
 */
export function moveEvent(before: DocView, after: DocView, ids: string[]): EventSpec[] {
  if (ids.length !== 1) return [];
  const p0 = before.get(ids[0]);
  const p1 = after.get(ids[0]);
  if (!p0 || !p1 || !isPiece(p1)) return [];
  const was = piece(p0);
  const now = piece(p1);
  if (!now.square || !now.board || (was.board === now.board && was.square === now.square)) return [];
  const victim = before.riders(now.board).find((v) => v.id !== p1.id && isPiece(v) && piece(v).square === now.square && !piece(after.get(v.id) ?? v).square);
  const from = was.board === now.board ? was.square : undefined;
  const letter = now.piece === 'P' ? (victim && from ? from[0] : '') : now.piece;
  const san = `${letter}${victim ? 'x' : ''}${now.square}`;
  const color = now.color === 'w' ? 'White' : 'Black';
  const text = `played ${color} ${san}${victim ? ` (takes ${pieceName(piece(victim))})` : ''}`;
  return [{ type: victim ? 'chess.capture' : 'chess.move', text, targets: [p1.id], cue: 'pulse' }];
}
const boardEvent = (b: CanvasNode, text: string): EventSpec[] => [{ type: 'chess.board', text, targets: [b.id] }];

/** Changes that bring a piece from where it is to `to` (only fields that differ). */
export function moveTo(p: CanvasNode, to: Spot): Change[] {
  const f = piece(p);
  const out: Change[] = [];
  if (f.board !== to.board) out.push(set(p.id, F('board'), to.board));
  if (f.square !== to.square) out.push(set(p.id, F('square'), to.square));
  if (p.x !== to.x) out.push(set(p.id, 'x', to.x));
  if (p.y !== to.y) out.push(set(p.id, 'y', to.y));
  return out;
}

/**
 * Hands out free capture slots beside a board. A slot is taken if a piece (other than the `moving`
 * ones) has its center in it, or if it was handed out already. When all are full, pieces pile on the last.
 */
export function slots(doc: DocView, b: CanvasNode, moving: ReadonlySet<string>) {
  const taken = new Set<string>();
  const busy = doc.visible.filter((n) => isPiece(n) && !moving.has(n.id)).map(center);
  const free = (s: { x: number; y: number }) =>
    !taken.has(`${s.x},${s.y}`) && !busy.some((c) => c.x >= s.x && c.x < s.x + SQ && c.y >= s.y && c.y < s.y + SQ);
  return (color: Color, side: 'owner' | 'capturer' = 'owner') => {
    const all = captureSlots(b, color, side);
    const s = all.find(free) ?? all[all.length - 1];
    taken.add(`${s.x},${s.y}`);
    return s;
  };
}

/** A new chess set in the starting position, centered near (x, y) in the first spot clear of other objects. */
export const create: Command<{ x: number; y: number }> = (doc, a, ctx) => {
  if (!isNum(a?.x) || !isNum(a?.y)) return [];
  let bx = Math.round(a.x - BOARD / 2);
  const by = Math.round(a.y - BOARD / 2);
  const clash = (x: number) => {
    const z = zone({ x, y: by });
    return doc.visible.some((n) => n.x < z.x + z.w && n.x + n.width > z.x && n.y < z.y + z.h && n.y + n.height > z.y);
  };
  for (let i = 0; i < 30 && clash(bx); i++) bx += BOARD + 120;
  let z = doc.topZ;
  const b = boardNode(ctx.newId(), bx, by, ++z);
  const changes: Change[] = [{ op: 'add', node: b }];
  for (const [kind, color, square] of START) {
    const pos = squarePos(b, square);
    changes.push({ op: 'add', node: pieceNode(ctx.newId(), pos.x, pos.y, { piece: kind, color, board: b.id, square, home: b.id }, ++z) });
  }
  return { changes, select: [] };
};

/**
 * Reset to the starting position: the set's own pieces come back from anywhere (a piece already on
 * its start square stays), missing ones are replaced. Extras (spawned/copied beyond the 32) and
 * strangers on the board are set aside beside it (owner's side), or with `removeExtras` are deleted (strangers that
 * belong to another live board are left for that board).
 */
function arrange(doc: DocView, b: CanvasNode, ctx: { newId(): string }, z: number, removeExtras = false) {
  const mine = doc.visible.filter((n) => isPiece(n) && piece(n).home === b.id);
  const liveHome = (n: CanvasNode) => !!piece(n).home && isBoard(doc.get(piece(n).home!));
  const strangers = doc.riders(b.id).filter((n) => isPiece(n) && piece(n).home !== b.id && !(removeExtras && liveHome(n)));
  const moving = new Set([...mine, ...strangers].map((n) => n.id));
  const pool = new Set(mine.slice().sort((x, y) => (x.id < y.id ? -1 : 1)));
  const assigned = new Map<string, CanvasNode | undefined>();
  // first keep pieces already on their start square, then fill the rest
  for (const [kind, color, square] of START) {
    const p = [...pool].find((n) => piece(n).piece === kind && piece(n).color === color && piece(n).board === b.id && piece(n).square === square);
    if (p) {
      assigned.set(square, p);
      pool.delete(p);
    }
  }
  const changes: Change[] = [];
  changes.push(set(b.id, 'z', ++z), set(b.id, F('from'), undefined), set(b.id, F('to'), undefined));
  for (const [kind, color, square] of START) {
    let p = assigned.get(square);
    if (!p) {
      p = [...pool].find((n) => piece(n).piece === kind && piece(n).color === color);
      if (p) pool.delete(p);
    }
    const pos = squarePos(b, square);
    if (p) changes.push(...moveTo(p, { board: b.id, square, ...pos }), set(p.id, 'z', ++z));
    else changes.push({ op: 'add', node: pieceNode(ctx.newId(), pos.x, pos.y, { piece: kind, color, board: b.id, square, home: b.id }, ++z) });
  }
  const extras = [...pool, ...strangers];
  if (removeExtras) changes.push(...extras.map((p): Change => ({ op: 'del', id: p.id })));
  else {
    const slot = slots(doc, b, moving);
    for (const p of extras) changes.push(...moveTo(p, { board: b.id, ...slot(piece(p).color) }), set(p.id, 'z', ++z));
  }
  return { changes, z };
}

/** Set up one board (extras kept beside it). */
export const setup: Command<{ id: string }> = (doc, a, ctx) => {
  const b = boardArg(doc, a?.id);
  if (!b) return [];
  return { changes: arrange(doc, b, ctx, doc.topZ).changes, select: [], events: boardEvent(b, 'set up the chess pieces') };
};

/**
 * Reset table (core `registerReset`): every board back to its 32 pieces on their squares, extras
 * deleted, pieces that belong to no board deleted. Orientation (flipped) and lock are kept.
 */
export const resetAll: Command<Record<string, never>> = (doc, _a, ctx) => {
  const changes: Change[] = [];
  let z = doc.topZ;
  const boards = doc.visible.filter(isBoard);
  for (const b of boards) {
    const r = arrange(doc, b, ctx, z, true);
    changes.push(...r.changes);
    z = r.z;
  }
  for (const n of doc.visible) {
    if (!isPiece(n)) continue;
    const home = piece(n).home;
    if ((!home || !isBoard(doc.get(home))) && !doc.carrierOf(n.id)) changes.push({ op: 'del', id: n.id });
  }
  return changes;
};

/** Turn the board around (view from the other side). Its pieces stay on their squares; captured pieces swap sides. */
export const flip: Command<{ id: string }> = (doc, a) => {
  const b = boardArg(doc, a?.id);
  if (!b) return [];
  const flipped = !board(b).flipped;
  const changes: Change[] = [set(b.id, F('flipped'), flipped || undefined)];
  for (const p of doc.riders(b.id)) {
    if (!isPiece(p)) continue;
    const sq = piece(p).square;
    const pos = sq ? squarePos(b, sq, flipped) : { x: 2 * b.x + b.width - p.x - p.width, y: 2 * b.y + b.height - p.y - p.height };
    changes.push(set(p.id, 'x', pos.x), set(p.id, 'y', pos.y));
  }
  return changes;
};

/** Take every piece off the squares, set aside beside the board on its owner's side. */
export const clear: Command<{ id: string }> = (doc, a) => {
  const b = boardArg(doc, a?.id);
  if (!b) return [];
  const on = doc.riders(b.id).filter((p) => isPiece(p) && piece(p).square);
  const slot = slots(doc, b, new Set(on.map((p) => p.id)));
  const changes = on.flatMap((p) => moveTo(p, { board: b.id, ...slot(piece(p).color) }));
  changes.push(set(b.id, F('from'), undefined), set(b.id, F('to'), undefined));
  return { changes, events: on.length ? boardEvent(b, 'cleared the chessboard') : [] };
};

/** Lock (default) or unlock a board: unlocked, dragging its surface moves it. */
export const lock: Command<{ id: string; locked: boolean }> = (doc, a) => {
  const b = boardArg(doc, a?.id);
  if (!b || typeof a.locked !== 'boolean') return [];
  return [set(b.id, F('unlocked'), a.locked ? undefined : true)];
};

/**
 * Where pieces put down at their current position end up. On a board's grid: the square under the
 * piece's center; an occupant goes beside the board on the capturer's side (free-play capture). Off the grid but beside a
 * board: stays with that board. Elsewhere: lies free. `moved` may include nodes not yet in the doc
 * (a spawn). A single piece changing squares marks the last move.
 */
function settle(doc: DocView, moved: CanvasNode[], soft = false) {
  const moving = new Set(moved.map((n) => n.id));
  const byId = new Map(moved.map((n) => [n.id, n]));
  const state = new Map<string, Spot>();
  const occupancy = new Map<string, Map<string, string>>();
  const occ = (b: CanvasNode) => {
    let m = occupancy.get(b.id);
    if (!m) {
      m = new Map();
      for (const p of doc.riders(b.id)) if (isPiece(p) && piece(p).square && !moving.has(p.id)) m.set(piece(p).square!, p.id);
      occupancy.set(b.id, m);
    }
    return m;
  };
  const finders = new Map<string, ReturnType<typeof slots>>();
  const slot = (b: CanvasNode, c: Color) => {
    let f = finders.get(b.id);
    if (!f) finders.set(b.id, (f = slots(doc, b, moving)));
    return f(c, 'capturer');
  };
  const boardChanges: Change[] = [];
  for (const p of moved) {
    const c = center(p);
    const b = boardUnder(doc, c.x, c.y);
    const was = piece(p);
    if (!b) {
      const near = boardUnder(doc, c.x, c.y, (n) => inZone(n, c.x, c.y));
      state.set(p.id, { board: near?.id, x: p.x, y: p.y });
      continue;
    }
    const sq = squareAt(b, c.x, c.y)!;
    const o = occ(b);
    const victim = o.get(sq);
    if (soft) {
      // nudged: name the square it now stands on (if free), but don't snap or capture
      if (victim && victim !== p.id) state.set(p.id, { board: b.id, x: p.x, y: p.y });
      else {
        o.set(sq, p.id);
        state.set(p.id, { board: b.id, square: sq, x: p.x, y: p.y });
      }
      continue;
    }
    if (victim && victim !== p.id) state.set(victim, { board: b.id, ...slot(b, piece(byId.get(victim) ?? doc.get(victim)!).color) });
    o.set(sq, p.id);
    state.set(p.id, { board: b.id, square: sq, ...squarePos(b, sq) });
    if (moved.length === 1 && (was.board !== b.id || was.square !== sq)) {
      const from = was.board === b.id ? was.square : undefined;
      if (board(b).from !== from) boardChanges.push(set(b.id, F('from'), from));
      if (board(b).to !== sq) boardChanges.push(set(b.id, F('to'), sq));
    }
  }
  return { state, boardChanges };
}

/**
 * Pieces were put down where they now lie (end of a drag): snap / capture / attach / free, see
 * `settle`. `soft` (arrow-key nudges): only update which square/board they are on; no snapping,
 * no capture, no last move.
 */
export const place: Command<{ ids: string[]; soft?: boolean }> = (doc, a) => {
  const moved = pick(doc, a?.ids).filter((n) => isPiece(n) && !doc.parentOf(n.id));
  if (!moved.length) return [];
  const soft = a.soft === true;
  const { state, boardChanges } = settle(doc, moved, soft);
  const changes = [...[...state].flatMap(([id, to]) => moveTo(doc.get(id)!, to)), ...boardChanges];
  const ids = moved.map((n) => n.id);
  return { changes, events: soft || !changes.length ? [] : (after) => moveEvent(doc, after, ids) };
};

/**
 * A new piece. With (x, y): put down centered there (snaps / captures like a drop; on or beside a
 * board it joins that board's set). With `board` instead: in the first free capture slot beside that
 * board (set aside on its owner's side), part of its set. Selects the new piece unless `keepSelection`.
 */
export const spawn: Command<{ piece: Kind; color: Color; x?: number; y?: number; board?: string; keepSelection?: boolean }> = (doc, a, ctx) => {
  if (!isKind(a?.piece) || !isColor(a.color)) return [];
  const id = ctx.newId();
  const z = doc.topZ + 1;
  const sel = a.keepSelection ? undefined : [id];
  const b = boardArg(doc, a.board);
  if (b) {
    const pos = slots(doc, b, new Set())(a.color);
    return { changes: [{ op: 'add', node: pieceNode(id, pos.x, pos.y, { piece: a.piece, color: a.color, board: b.id, home: b.id }, z) }], select: sel };
  }
  if (!isNum(a.x) || !isNum(a.y)) return [];
  const node = pieceNode(id, Math.round(a.x - SQ / 2), Math.round(a.y - SQ / 2), { piece: a.piece, color: a.color }, z);
  const { state, boardChanges } = settle(doc, [node]);
  const changes: Change[] = [];
  for (const [pid, to] of state) {
    if (pid !== id) {
      changes.push(...moveTo(doc.get(pid)!, to));
      continue;
    }
    const f: PieceField = { piece: a.piece, color: a.color, board: to.board, square: to.square, home: to.board };
    changes.unshift({ op: 'add', node: pieceNode(id, to.x, to.y, f, z) });
  }
  return { changes: [...changes, ...boardChanges], select: sel };
};

/**
 * Repair (core `repairs`) after an undo/redo or a remote change: no two pieces share a square.
 * After an undo/redo (`undo`), the pieces it touched (and the pieces of a board it touched) also
 * stand on the square they say they are on (a partial undo can give a piece its square back but not
 * its position, when another player moved the board or that piece since), and when one of them lands
 * on a square another piece took in the meantime, the restored piece is set aside beside the board
 * (owner's side). After a remote change
 * (two players dropping on one square at once), every peer runs this: it depends on the doc only, the
 * piece with the smallest id keeps the square and the other is captured (capturer's side). Positions
 * of remote pieces are left alone: a piece being dragged is off its square until the drop.
 */
export const repair: Command<{ ids: string[]; undo?: boolean }> = (doc, a) => {
  const nodes = pick(doc, a?.ids);
  const touched = new Set(nodes.filter(isPiece).map((n) => n.id));
  const undo = a.undo === true;
  // a board an undo put back: its pieces' squares say where they belong
  const snap = new Set(touched);
  if (undo) for (const b of nodes.filter(isBoard)) for (const p of doc.riders(b.id)) if (isPiece(p)) snap.add(p.id);
  if (!snap.size) return [];
  const changes: Change[] = [];
  const boards = new Set<string>();
  for (const id of snap) {
    const f = piece(doc.get(id)!);
    if (f.board && f.square && isBoard(doc.get(f.board))) boards.add(f.board);
  }
  for (const bid of boards) {
    const b = doc.get(bid)!;
    const bySquare = new Map<string, CanvasNode[]>();
    for (const p of doc.riders(bid)) {
      if (!isPiece(p) || !piece(p).square) continue;
      const l = bySquare.get(piece(p).square!) ?? [];
      l.push(p);
      bySquare.set(piece(p).square!, l);
    }
    const aside = new Set<string>();
    const moving = new Set<string>();
    const out: CanvasNode[] = [];
    for (const [, l] of bySquare) {
      if (l.length < 2 || !l.some((p) => snap.has(p.id))) continue;
      const sorted = l.slice().sort((x, y) => (x.id < y.id ? -1 : 1));
      // after an undo the piece that stayed keeps the square; else (or if all were restored) the smallest id
      const keep = (undo && sorted.find((p) => !touched.has(p.id))) || sorted[0];
      for (const p of sorted) {
        if (p === keep) continue;
        aside.add(p.id);
        moving.add(p.id);
        out.push(p);
      }
    }
    const slot = slots(doc, b, moving);
    for (const p of out) changes.push(...moveTo(p, { board: bid, ...slot(piece(p).color, undo ? 'owner' : 'capturer') }));
    if (!undo) continue;
    for (const id of snap) {
      const p = doc.get(id)!;
      const f = piece(p);
      if (aside.has(id) || f.board !== bid || !f.square) continue;
      // a nudged piece stands off-center on purpose: only snap one that is off its square
      const c = center(p);
      if (squareAt(b, c.x, c.y) !== f.square) changes.push(...moveTo(p, { board: bid, square: f.square, ...squarePos(b, f.square) }));
    }
  }
  return changes;
};

/**
 * Duplicate rule (see core `duplicateRules`): a board copies as an empty board (no last move); a piece
 * copied together with its board keeps its square on the copy (⌘D of a whole set); a piece copied
 * alone keeps its board and set but no square (it lies beside where it was copied from until dropped).
 */
export function duplicatePiece(node: CanvasNode, _doc?: DocView, copyOf: (id: string) => string | undefined = () => undefined): CanvasNode | null | undefined {
  if (isBoard(node)) {
    const { from: _f, to: _t, ...f } = board(node);
    return { ...node, [FIELD]: f };
  }
  if (!isPiece(node)) return;
  const p = piece(node);
  const nb = p.board ? copyOf(p.board) : undefined;
  if (nb) {
    const f: PieceField = { ...p, board: nb, home: p.home === p.board ? nb : p.home };
    return { ...node, text: pieceText(f), [FIELD]: f };
  }
  const { square: _sq, ...f } = p;
  return { ...node, text: pieceText(f), [FIELD]: f };
}

export const commands = { create, setup, flip, clear, lock, place, spawn, resetAll, repair };
