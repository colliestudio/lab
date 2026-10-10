import { isNum, pick, set, type CanvasNode, type Change, type Command, type DocView } from '../../core';
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
  pieceText,
  zone,
  type Color,
  type Kind,
  type PieceField,
} from './model';

// Pure commands: (read-only doc, args, ctx) -> per-field changes. No DOM. Bad args = no-op.
// Free play: no rules. Pieces snap to squares, a piece dropped on an occupied square sends the
// occupant to the capture rows beside the board, all in one undo step.

const F = (k: string) => `${FIELD}.${k}`;
const boardArg = (doc: DocView, id: unknown) => {
  const b = typeof id === 'string' ? doc.get(id) : undefined;
  return b && isBoard(b) ? b : undefined;
};

type Spot = { board?: string; square?: string; x: number; y: number };

/** Changes that bring a piece from where it is to `to` (only fields that differ). */
function moveTo(p: CanvasNode, to: Spot): Change[] {
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
function slots(doc: DocView, b: CanvasNode, moving: ReadonlySet<string>) {
  const taken = new Set<string>();
  const busy = doc.visible.filter((n) => isPiece(n) && !moving.has(n.id)).map(center);
  const free = (s: { x: number; y: number }) =>
    !taken.has(`${s.x},${s.y}`) && !busy.some((c) => c.x >= s.x && c.x < s.x + SQ && c.y >= s.y && c.y < s.y + SQ);
  return (color: Color) => {
    const all = captureSlots(b, color);
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
 * strangers on the board go to its capture rows, or with `removeExtras` are deleted (strangers that
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
  return { changes: arrange(doc, b, ctx, doc.topZ).changes, select: [] };
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

/** Take every piece off the squares into the capture rows (each on its owner's side). */
export const clear: Command<{ id: string }> = (doc, a) => {
  const b = boardArg(doc, a?.id);
  if (!b) return [];
  const on = doc.riders(b.id).filter((p) => isPiece(p) && piece(p).square);
  const slot = slots(doc, b, new Set(on.map((p) => p.id)));
  const changes = on.flatMap((p) => moveTo(p, { board: b.id, ...slot(piece(p).color) }));
  changes.push(set(b.id, F('from'), undefined), set(b.id, F('to'), undefined));
  return changes;
};

/** Lock (default) or unlock a board: unlocked, dragging its surface moves it. */
export const lock: Command<{ id: string; locked: boolean }> = (doc, a) => {
  const b = boardArg(doc, a?.id);
  if (!b || typeof a.locked !== 'boolean') return [];
  return [set(b.id, F('unlocked'), a.locked ? undefined : true)];
};

/**
 * Where pieces put down at their current position end up. On a board's grid: the square under the
 * piece's center; an occupant goes to the capture rows (free-play capture). Off the grid but beside a
 * board: stays with that board. Elsewhere: lies free. `moved` may include nodes not yet in the doc
 * (a spawn). A single piece changing squares marks the last move.
 */
function settle(doc: DocView, moved: CanvasNode[]) {
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
    return f(c);
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

/** Pieces were put down where they now lie (end of a drag): snap / capture / attach / free, see `settle`. */
export const place: Command<{ ids: string[] }> = (doc, a) => {
  const moved = pick(doc, a?.ids).filter((n) => isPiece(n) && !doc.parentOf(n.id));
  if (!moved.length) return [];
  const { state, boardChanges } = settle(doc, moved);
  return [...[...state].flatMap(([id, to]) => moveTo(doc.get(id)!, to)), ...boardChanges];
};

/**
 * A new piece. With (x, y): put down centered there (snaps / captures like a drop; on or beside a
 * board it joins that board's set). With `board` instead: in the first free capture slot beside that
 * board (its owner's side), part of its set. Selects the new piece unless `keepSelection`.
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
 * Duplicate rule (see core `registerDuplicateRule`): a piece copy keeps its board and set but no
 * square (it lies beside where it was copied from until dropped); boards aren't duplicated.
 */
export function duplicatePiece(node: CanvasNode): CanvasNode | null | undefined {
  if (isBoard(node)) return null;
  if (!isPiece(node)) return;
  const { square: _sq, ...f } = piece(node);
  return { ...node, text: pieceText(f), [FIELD]: f };
}

export const commands = { create, setup, flip, clear, lock, place, spawn, resetAll };
