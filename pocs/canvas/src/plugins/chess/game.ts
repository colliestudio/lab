// value imports from core modules, not the core index (it pulls in the DOM app; the bridge runs this in Node)
import { pick } from '../../core/commands';
import { set } from '../../core/doc';
import type { CanvasNode, Change, Command, CommandResult, DocView, EventSpec, LogActor } from '../../core';
import { commands as free, moveTo, slots } from './commands';
import { FIELD, board, boardUnder, center, isBoard, isColor, isPiece, piece, pieceText, squareAt, squarePos, type BoardField, type Color, type SeatField } from './model';
import { ascii, inCheck, legalMoves, outcome, parseMove, play, san, sqIndex, sqName, toFen, validCastling, type Move, type Position } from './rules';

// Rules mode for a chessboard: the same pieces on the same table, plus turns, legal moves, seats and
// a result. A position is derived from the pieces standing on the board's squares and the game fields
// on the board node (turn, castling, en passant, counters). Players reach it two ways, both ending in
// the same changes and log line:
//  - `chess.move {id, move: "e2e4" | "Nf3"}`: agents and bots (bridge CLI/MCP), by notation;
//  - dragging a piece (`chess.place`): legal drops play the move, illegal ones bounce back.
// Seats: `chess.sit` puts the acting player (ctx.actor) on a color; a seated color moves only for
// its player. An empty seat is open to anyone (hot seat).

const F = (k: string) => `${FIELD}.${k}`;
export const colorName = (c: Color) => (c === 'w' ? 'white' : 'black');
const Cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const seatKey = (c: Color) => (c === 'w' ? 'white' : 'black') as 'white' | 'black';

/** The position on a board: pieces on its squares plus its game fields. */
export function positionOf(doc: DocView, b: CanvasNode): Position {
  const f = board(b);
  const sq: Position['sq'] = Array(64).fill(null);
  for (const p of doc.riders(b.id)) {
    if (!isPiece(p)) continue;
    const s = piece(p).square;
    if (s) sq[sqIndex(s)] = { k: piece(p).piece, c: piece(p).color };
  }
  return { sq, turn: f.turn ?? 'w', castling: f.castling ?? 'KQkq', ep: f.ep, half: f.half ?? 0, full: f.full ?? 1 };
}

/** Piece node standing on `square` of board `b`. */
const pieceOn = (doc: DocView, b: CanvasNode, square: string) => doc.riders(b.id).find((p) => isPiece(p) && piece(p).square === square);

/** Why `actor` may not move `color` on this board (undefined: it may). */
export function seatError(f: BoardField, color: Color, actor: LogActor | null | undefined): string | undefined {
  const seat = f[seatKey(color)];
  if (seat && seat.id !== actor?.id) return `${colorName(color)} is ${seat.name}'s to move`;
  const mine = (['w', 'b'] as Color[]).find((c) => f[seatKey(c)]?.id === actor?.id && actor);
  if (!seat && mine && mine !== color) return `you play ${colorName(mine)}`;
  return;
}

/** Changes for the start of a game (pieces aside): turn, rights, counters, no moves, no result. */
const freshGame = (id: string): Change[] => [
  set(id, F('turn'), 'w'),
  set(id, F('castling'), 'KQkq'),
  set(id, F('ep'), undefined),
  set(id, F('half'), 0),
  set(id, F('full'), 1),
  set(id, F('moves'), undefined),
  set(id, F('result'), undefined),
  set(id, F('end'), undefined),
];

/** The pieces' changes and board fields for a legal move `m` (already checked). */
function moveChanges(doc: DocView, b: CanvasNode, pos: Position, m: Move, legal: Move[]) {
  const id = b.id;
  const mover = pieceOn(doc, b, sqName(m.from))!;
  const changes: Change[] = [];
  const moving = new Set([mover.id]);
  if (m.capSq !== undefined) {
    const victim = pieceOn(doc, b, sqName(m.capSq))!;
    moving.add(victim.id);
    const slot = slots(doc, b, moving);
    changes.push(...moveTo(victim, { board: id, ...slot(piece(victim).color, 'capturer') }));
  }
  const to = sqName(m.to);
  changes.unshift(...moveTo(mover, { board: id, square: to, ...squarePos(b, to) }));
  if (m.promo) changes.push(set(mover.id, F('piece'), m.promo), set(mover.id, 'text', pieceText({ piece: m.promo, color: m.c, square: to })));
  if (m.castle) {
    const home = m.c === 'w' ? 0 : 56;
    const [rf, rt] = m.castle === 'K' ? [home + 7, home + 5] : [home, home + 3];
    const rook = pieceOn(doc, b, sqName(rf))!;
    changes.push(...moveTo(rook, { board: id, square: sqName(rt), ...squarePos(b, sqName(rt)) }));
  }
  const next = play(pos, m);
  const text = san(pos, m, legal);
  const end = outcome(next);
  const moves = [...(board(b).moves ?? []), text];
  changes.push(
    set(id, F('from'), sqName(m.from)),
    set(id, F('to'), to),
    set(id, F('turn'), next.turn),
    set(id, F('castling'), validCastling(next)),
    set(id, F('ep'), next.ep),
    set(id, F('half'), next.half),
    set(id, F('full'), next.full),
    set(id, F('moves'), moves),
    set(id, F('result'), end?.result),
    set(id, F('end'), end?.reason),
  );
  const who = m.c === 'w' ? 'White' : 'Black';
  const ending = end ? ` (${end.reason}, ${end.result})` : '';
  const events: EventSpec[] = [{ type: m.captured ? 'chess.capture' : 'chess.move', text: `played ${who} ${text}${ending}`, targets: [mover.id], cue: 'pulse' }];
  return { changes, events, san: text, select: [mover.id] };
}

const boardOf = (doc: DocView, id: unknown) => {
  const b = typeof id === 'string' ? doc.get(id) : undefined;
  if (!b || !isBoard(b)) throw new Error(`no chessboard ${String(id)}`);
  return b;
};

/**
 * Play a move by notation (UCI "e2e4"/"e7e8q" or SAN "Nf3"/"O-O"). Throws (→ a failed dispatch with
 * the reason) when the board isn't in rules mode, the game is over, it's not the actor's color, or
 * the move is illegal: an agent gets told why, nothing changes.
 */
export const move: Command<{ id: string; move: string }> = (doc, a, ctx) => {
  const b = boardOf(doc, a?.id);
  const f = board(b);
  if (!f.rules) throw new Error('this board is in free play: start a game first (chess.newgame)');
  if (f.result) throw new Error(`the game is over: ${f.result} (${f.end})`);
  const pos = positionOf(doc, b);
  const err = seatError(f, pos.turn, ctx.actor);
  if (err) throw new Error(`${Cap(colorName(pos.turn))} to move: ${err}`);
  const legal = legalMoves(pos);
  const m = typeof a.move === 'string' ? parseMove(pos, a.move, legal) : undefined;
  if (!m) throw new Error(`illegal move "${a?.move}" for ${colorName(pos.turn)}; legal: ${legal.map((x) => san(pos, x, legal)).join(' ')}`);
  const r = moveChanges(doc, b, pos, m, legal);
  return { changes: r.changes, events: r.events, select: r.select };
};

/**
 * A new game: with `id`, that board's pieces back to the start; without, a new set near (x, y).
 * Rules on, white to move, seats kept.
 */
export const newgame: Command<{ id?: string; x?: number; y?: number }> = (doc, a, ctx) => {
  if (a?.id !== undefined) {
    const b = boardOf(doc, a.id);
    const r = free.setup(doc, { id: b.id }, ctx) as CommandResult;
    return { changes: [...r.changes, set(b.id, F('rules'), true), ...freshGame(b.id)], select: [], events: [{ type: 'chess.board', text: 'started a chess game', targets: [b.id] }] };
  }
  const r = free.create(doc, { x: a?.x ?? 0, y: a?.y ?? 0 }, ctx) as CommandResult;
  const changes = r.changes.map((c) =>
    c.op === 'add' && isBoard(c.node) ? { ...c, node: { ...c.node, [FIELD]: { ...board(c.node), rules: true, turn: 'w', castling: 'KQkq', half: 0, full: 1 } } } : c,
  );
  const id = changes.find((c) => c.op === 'add' && isBoard(c.node));
  return { changes, select: [], events: id && id.op === 'add' ? [{ type: 'chess.board', text: 'started a chess game', targets: [id.node.id] }] : [] };
};

/** Rules on (from the position as it stands, `turn` to move; default white) or off (free play). */
export const rules: Command<{ id: string; on: boolean; turn?: Color }> = (doc, a) => {
  const b = boardOf(doc, a?.id);
  if (!a.on) return [set(b.id, F('rules'), undefined)];
  const turn = isColor(a.turn) ? a.turn : 'w';
  const pos = positionOf(doc, b);
  return [set(b.id, F('rules'), true), set(b.id, F('turn'), turn), set(b.id, F('castling'), validCastling({ ...pos, castling: 'KQkq' }))];
};

/**
 * Sit the acting player at a color (`leave`: stand up). Taken seats stay taken; `leave` + `force`
 * frees someone else's seat (an agent that went away). No permissions yet: anyone may.
 */
export const sit: Command<{ id: string; color: Color; leave?: boolean; force?: boolean }> = (doc, a, ctx) => {
  const b = boardOf(doc, a?.id);
  if (!isColor(a.color)) throw new Error('color: "w" or "b"');
  const me = ctx.actor;
  if (!me) throw new Error('nobody to seat (no player on this device)');
  const key = seatKey(a.color);
  const seat = board(b)[key];
  if (a.leave) {
    if (!seat || (seat.id !== me.id && !a.force)) return [];
    const text = seat.id === me.id ? `left the ${key} seat` : `freed the ${key} seat (${seat.name})`;
    return { changes: [set(b.id, F(key), undefined)], events: [{ type: 'chess.seat', text, targets: [b.id] }] };
  }
  if (seat?.id === me.id) return [];
  if (seat) throw new Error(`${key} is taken by ${seat.name}`);
  const changes: Change[] = [set(b.id, F(key), { id: me.id, name: me.name } satisfies SeatField)];
  // one color per player (sitting at the other color moves you)
  const otherKey = seatKey(a.color === 'w' ? 'b' : 'w');
  if (board(b)[otherKey]?.id === me.id) changes.push(set(b.id, F(otherKey), undefined));
  return { changes, events: [{ type: 'chess.seat', text: `sat down as ${key}`, targets: [b.id] }] };
};

/** Give up: the other color wins. */
export const resign: Command<{ id: string; color?: Color }> = (doc, a, ctx) => {
  const b = boardOf(doc, a?.id);
  const f = board(b);
  if (!f.rules || f.result) return [];
  const color = isColor(a.color) ? a.color : ((['w', 'b'] as Color[]).find((c) => f[seatKey(c)]?.id === ctx.actor?.id) ?? positionOf(doc, b).turn);
  const err = seatError(f, color, ctx.actor);
  if (err) throw new Error(err);
  const result = color === 'w' ? '0-1' : '1-0';
  return { changes: [set(b.id, F('result'), result), set(b.id, F('end'), `${colorName(color)} resigned`)], events: [{ type: 'chess.board', text: `resigned for ${colorName(color)} (${result})`, targets: [b.id] }] };
};

const rulesBoard = (doc: DocView, id: string | undefined) => {
  const b = id ? doc.get(id) : undefined;
  return b && isBoard(b) && board(b).rules ? b : undefined;
};

/**
 * Drops on a board in rules mode (wraps free play's `chess.place`). One piece dropped on another
 * square of its board: if that is a legal move for the player dropping it, the move is played (same
 * changes as `chess.move`); else it goes back to its square. Pieces of a rules board dragged off it,
 * or anything dropped onto one from outside, go back too (or aside, beside the board).
 */
export const place: Command<{ ids: string[]; soft?: boolean }> = (doc, a, ctx) => {
  const moved = pick(doc, a?.ids).filter((n) => isPiece(n) && !doc.parentOf(n.id));
  const ruled: CanvasNode[] = [];
  const rest: string[] = [];
  for (const p of moved) {
    const c = center(p);
    const from = rulesBoard(doc, piece(p).board);
    const onto = boardUnder(doc, c.x, c.y);
    if (from || (onto && board(onto).rules)) ruled.push(p);
    else rest.push(p.id);
  }
  if (!ruled.length) return free.place(doc, a, ctx);
  // a single piece moved on its own rules board: maybe a move
  if (ruled.length === 1 && !rest.length && !a.soft) {
    const p = ruled[0];
    const b = rulesBoard(doc, piece(p).board);
    const c = center(p);
    const to = b && squareAt(b, c.x, c.y);
    const fromSq = piece(p).square;
    if (b && to && fromSq && to !== fromSq && !board(b).result) {
      const pos = positionOf(doc, b);
      const legal = legalMoves(pos);
      const promo = piece(p).piece === 'P' && (to[1] === '8' || to[1] === '1') ? 'q' : '';
      const m = parseMove(pos, fromSq + to + promo, legal);
      if (m && m.c === piece(p).color && !seatError(board(b), pos.turn, ctx.actor)) {
        const r = moveChanges(doc, b, pos, m, legal);
        return { changes: r.changes, events: r.events };
      }
    }
  }
  // back where they belong: own square on their rules board, else aside beside the board they hit
  const changes: Change[] = [];
  const moving = new Set(ruled.map((p) => p.id));
  for (const p of ruled) {
    const b = rulesBoard(doc, piece(p).board);
    const sq = piece(p).square;
    if (b && sq) changes.push(...moveTo(p, { board: b.id, square: sq, ...squarePos(b, sq) }));
    else {
      const c = center(p);
      const target = b ?? boardUnder(doc, c.x, c.y)!;
      changes.push(...moveTo(p, { board: target.id, ...slots(doc, target, moving)(piece(p).color) }));
    }
  }
  if (!rest.length) return changes;
  const r = free.place(doc, { ids: rest, soft: a.soft }, ctx);
  const res = Array.isArray(r) ? { changes: r } : r;
  return { ...res, changes: [...changes, ...res.changes] };
};

/** Free play's set up, plus a fresh game when the board is in rules mode. */
export const setup: Command<{ id: string }> = (doc, a, ctx) => {
  const r = free.setup(doc, a, ctx);
  const res = Array.isArray(r) ? { changes: r } : r;
  const b = rulesBoard(doc, a?.id);
  return b ? { ...res, changes: [...res.changes, ...freshGame(b.id)] } : res;
};

/** Reset table: rules boards start a fresh game (runs with the other resets, one undo step). */
export const resetGames: Command<Record<string, never>> = (doc) => doc.visible.filter((n) => isBoard(n) && board(n).rules).flatMap((b) => freshGame(b.id));

export const gameCommands = { move, newgame, rules, sit, resign, place, setup };

// ------------------------------------------------------------------ the game as agents see it

export interface GameView {
  board: string;
  rules: boolean;
  fen: string;
  /** White at the bottom; uppercase white. */
  ascii: string;
  turn: 'white' | 'black';
  moveNumber: number;
  lastMove?: string;
  check: boolean;
  result?: string;
  end?: string;
  seats: { white?: string; black?: string };
  /** The asking player's color, if seated. */
  you?: 'white' | 'black';
  /** The asker may move now (rules on, game not over, the color to move is theirs or open). */
  yourTurn: boolean;
  /** Legal moves for the side to move (SAN). */
  legal: string[];
  /** "1. e4 e5 2. Nf3 …" */
  moves: string;
}

/** A board by id; else the only one; else the one `actor` sits at. */
export function findBoard(doc: DocView, ref?: string, actor?: LogActor | null): CanvasNode {
  if (ref) return boardOf(doc, ref);
  const all = doc.visible.filter(isBoard);
  if (all.length === 1) return all[0];
  const mine = all.filter((b) => [board(b).white?.id, board(b).black?.id].includes(actor?.id ?? '\0'));
  if (mine.length === 1) return mine[0];
  if (!all.length) throw new Error('no chessboard on the table (start one: chess.newgame)');
  throw new Error(`${all.length} chessboards: say which (${all.map((b) => b.id).join(', ')})`);
}

export function gameView(doc: DocView, b: CanvasNode, actor?: LogActor | null): GameView {
  const f = board(b);
  const pos = positionOf(doc, b);
  const legal = f.rules && !f.result ? legalMoves(pos) : [];
  const you = f.white?.id && f.white.id === actor?.id ? 'white' : f.black?.id && f.black.id === actor?.id ? 'black' : undefined;
  const moves = (f.moves ?? []).reduce((s, m, i) => s + (i % 2 === 0 ? `${i ? ' ' : ''}${i / 2 + 1}. ` : ' ') + m, '');
  return {
    board: b.id,
    rules: !!f.rules,
    fen: toFen(pos),
    ascii: ascii(pos),
    turn: pos.turn === 'w' ? 'white' : 'black',
    moveNumber: pos.full,
    ...(f.moves?.length ? { lastMove: f.moves[f.moves.length - 1] } : {}),
    check: inCheck(pos),
    ...(f.result ? { result: f.result, end: f.end } : {}),
    seats: { ...(f.white ? { white: f.white.name } : {}), ...(f.black ? { black: f.black.name } : {}) },
    ...(you ? { you } : {}),
    yourTurn: !!f.rules && !f.result && legal.length > 0 && !seatError(f, pos.turn, actor),
    legal: legal.map((m) => san(pos, m, legal)),
    moves,
  };
}
