import { FILES, type Color, type Kind } from './model';

// Chess rules, pure and DOM-free: positions, legal moves (incl. castling, en passant, promotion),
// SAN, FEN, game end, and a small search for the built-in bot. The canvas stays a table of pieces:
// a position is derived from the pieces on a board's squares plus the game fields on the board
// (turn, castling rights, en passant square, counters). Squares are 0..63, a1 = 0, h8 = 63.

export interface Man {
  k: Kind;
  c: Color;
}
export interface Position {
  sq: (Man | null)[];
  turn: Color;
  /** Subset of "KQkq". */
  castling: string;
  /** En passant target square ("e3"), if the last move was a double pawn push. */
  ep?: string;
  half: number;
  full: number;
}
export interface Move {
  from: number;
  to: number;
  k: Kind;
  c: Color;
  captured?: Kind;
  /** Square of the captured piece (differs from `to` for en passant). */
  capSq?: number;
  promo?: Kind;
  castle?: 'K' | 'Q';
  /** Double pawn push. */
  double?: boolean;
}

export const sqName = (i: number) => FILES[i & 7] + ((i >> 3) + 1);
export const sqIndex = (s: string) => FILES.indexOf(s[0]) + (Number(s[1]) - 1) * 8;
export const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const file = (i: number) => i & 7;
const rank = (i: number) => i >> 3;
const onBoard = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export function emptyPosition(): Position {
  return { sq: Array(64).fill(null), turn: 'w', castling: '', half: 0, full: 1 };
}

export function startPosition(): Position {
  return parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
}

// ------------------------------------------------------------------ FEN

export function parseFen(fen: string): Position {
  const [placement, turn = 'w', castling = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/);
  const p = emptyPosition();
  const rows = placement.split('/');
  if (rows.length !== 8) throw new Error(`bad FEN: ${fen}`);
  rows.forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else {
        const k = ch.toUpperCase() as Kind;
        p.sq[(7 - i) * 8 + f] = { k, c: ch === k ? 'w' : 'b' };
        f++;
      }
    }
  });
  p.turn = turn === 'b' ? 'b' : 'w';
  p.castling = castling === '-' ? '' : castling;
  p.ep = ep === '-' ? undefined : ep;
  p.half = Number(half) || 0;
  p.full = Number(full) || 1;
  return p;
}

export function toFen(p: Position): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const m = p.sq[r * 8 + f];
      if (!m) empty++;
      else {
        if (empty) row += empty;
        empty = 0;
        row += m.c === 'w' ? m.k : m.k.toLowerCase();
      }
    }
    rows.push(row + (empty ? empty : ''));
  }
  return `${rows.join('/')} ${p.turn} ${validCastling(p) || '-'} ${p.ep ?? '-'} ${p.half} ${p.full}`;
}

/** Board as text, white at the bottom: uppercase white, lowercase black, "." empty. */
export function ascii(p: Position): string {
  const out: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = `${r + 1} `;
    for (let f = 0; f < 8; f++) {
      const m = p.sq[r * 8 + f];
      row += ' ' + (m ? (m.c === 'w' ? m.k : m.k.toLowerCase()) : '.');
    }
    out.push(row);
  }
  out.push('   a b c d e f g h');
  return out.join('\n');
}

/** Castling rights that still make sense on the board (king and rook on their start squares). */
export function validCastling(p: Position): string {
  const at = (s: string, k: Kind, c: Color) => {
    const m = p.sq[sqIndex(s)];
    return !!m && m.k === k && m.c === c;
  };
  let out = '';
  if (p.castling.includes('K') && at('e1', 'K', 'w') && at('h1', 'R', 'w')) out += 'K';
  if (p.castling.includes('Q') && at('e1', 'K', 'w') && at('a1', 'R', 'w')) out += 'Q';
  if (p.castling.includes('k') && at('e8', 'K', 'b') && at('h8', 'R', 'b')) out += 'k';
  if (p.castling.includes('q') && at('e8', 'K', 'b') && at('a8', 'R', 'b')) out += 'q';
  return out;
}

// ------------------------------------------------------------------ attacks and moves

/** Is square `s` attacked by any piece of color `by`? */
export function attacked(p: Position, s: number, by: Color): boolean {
  const f = file(s);
  const r = rank(s);
  const is = (ff: number, rr: number, kinds: Kind[]) => {
    if (!onBoard(ff, rr)) return false;
    const m = p.sq[rr * 8 + ff];
    return !!m && m.c === by && kinds.includes(m.k);
  };
  const dir = by === 'w' ? -1 : 1; // a white pawn attacks upwards: it stands one rank below
  if (is(f - 1, r + dir, ['P']) || is(f + 1, r + dir, ['P'])) return true;
  if (KNIGHT.some(([df, dr]) => is(f + df, r + dr, ['N']))) return true;
  if (KING.some(([df, dr]) => is(f + df, r + dr, ['K']))) return true;
  const ray = (dirs: number[][], kinds: Kind[]) =>
    dirs.some(([df, dr]) => {
      for (let ff = f + df, rr = r + dr; onBoard(ff, rr); ff += df, rr += dr) {
        const m = p.sq[rr * 8 + ff];
        if (m) return m.c === by && kinds.includes(m.k);
      }
      return false;
    });
  return ray(ROOK, ['R', 'Q']) || ray(BISHOP, ['B', 'Q']);
}

export function kingSquare(p: Position, c: Color): number {
  return p.sq.findIndex((m) => !!m && m.k === 'K' && m.c === c);
}

export function inCheck(p: Position, c: Color = p.turn): boolean {
  const k = kingSquare(p, c);
  return k >= 0 && attacked(p, k, other(c));
}

function pseudo(p: Position): Move[] {
  const out: Move[] = [];
  const c = p.turn;
  const add = (from: number, to: number, extra: Partial<Move> = {}) => {
    const m = p.sq[from]!;
    const victim = p.sq[to];
    out.push({ from, to, k: m.k, c, ...(victim ? { captured: victim.k, capSq: to } : {}), ...extra });
  };
  for (let s = 0; s < 64; s++) {
    const m = p.sq[s];
    if (!m || m.c !== c) continue;
    const f = file(s);
    const r = rank(s);
    if (m.k === 'P') {
      const dir = c === 'w' ? 1 : -1;
      const last = c === 'w' ? 7 : 0;
      const push = (to: number, extra: Partial<Move> = {}) => {
        if (rank(to) === last) for (const promo of ['Q', 'R', 'B', 'N'] as Kind[]) add(s, to, { ...extra, promo });
        else add(s, to, extra);
      };
      const one = s + 8 * dir;
      if (onBoard(f, r + dir) && !p.sq[one]) {
        push(one);
        const two = s + 16 * dir;
        if (r === (c === 'w' ? 1 : 6) && !p.sq[two]) add(s, two, { double: true });
      }
      for (const df of [-1, 1]) {
        if (!onBoard(f + df, r + dir)) continue;
        const to = (r + dir) * 8 + f + df;
        const v = p.sq[to];
        if (v && v.c !== c) push(to);
        else if (!v && p.ep && sqName(to) === p.ep) {
          const capSq = r * 8 + f + df;
          const victim = p.sq[capSq];
          if (victim && victim.k === 'P' && victim.c !== c) out.push({ from: s, to, k: 'P', c, captured: 'P', capSq });
        }
      }
      continue;
    }
    const steps = (dirs: number[][], slide: boolean) => {
      for (const [df, dr] of dirs) {
        for (let ff = f + df, rr = r + dr; onBoard(ff, rr); ff += df, rr += dr) {
          const to = rr * 8 + ff;
          const v = p.sq[to];
          if (v && v.c === c) break;
          add(s, to);
          if (v || !slide) break;
        }
      }
    };
    if (m.k === 'N') steps(KNIGHT, false);
    else if (m.k === 'K') steps(KING, false);
    else if (m.k === 'R') steps(ROOK, true);
    else if (m.k === 'B') steps(BISHOP, true);
    else steps([...ROOK, ...BISHOP], true);
    if (m.k === 'K') {
      const rights = validCastling(p);
      const home = c === 'w' ? 0 : 56;
      const enemy = other(c);
      if (s === home + 4 && !attacked(p, s, enemy)) {
        const kRight = c === 'w' ? 'K' : 'k';
        const qRight = c === 'w' ? 'Q' : 'q';
        if (rights.includes(kRight) && !p.sq[home + 5] && !p.sq[home + 6] && !attacked(p, home + 5, enemy) && !attacked(p, home + 6, enemy))
          out.push({ from: s, to: home + 6, k: 'K', c, castle: 'K' });
        if (rights.includes(qRight) && !p.sq[home + 3] && !p.sq[home + 2] && !p.sq[home + 1] && !attacked(p, home + 3, enemy) && !attacked(p, home + 2, enemy))
          out.push({ from: s, to: home + 2, k: 'K', c, castle: 'Q' });
      }
    }
  }
  return out;
}

/** The position after a move (no legality check). */
export function play(p: Position, m: Move): Position {
  const sq = p.sq.slice();
  if (m.capSq !== undefined) sq[m.capSq] = null;
  sq[m.from] = null;
  sq[m.to] = { k: m.promo ?? m.k, c: m.c };
  if (m.castle) {
    const home = m.c === 'w' ? 0 : 56;
    const [rf, rt] = m.castle === 'K' ? [home + 7, home + 5] : [home, home + 3];
    sq[rt] = sq[rf];
    sq[rf] = null;
  }
  let castling = p.castling;
  const drop = (chars: string) => (castling = [...castling].filter((ch) => !chars.includes(ch)).join(''));
  if (m.k === 'K') drop(m.c === 'w' ? 'KQ' : 'kq');
  for (const s of [m.from, m.to]) {
    if (s === 0) drop('Q');
    if (s === 7) drop('K');
    if (s === 56) drop('q');
    if (s === 63) drop('k');
  }
  return {
    sq,
    turn: other(p.turn),
    castling,
    ep: m.double ? sqName((m.from + m.to) / 2) : undefined,
    half: m.k === 'P' || m.captured ? 0 : p.half + 1,
    full: p.full + (p.turn === 'b' ? 1 : 0),
  };
}

export function legalMoves(p: Position): Move[] {
  return pseudo(p).filter((m) => !inCheck(play(p, m), p.turn));
}

// ------------------------------------------------------------------ notation

export const uci = (m: Move) => sqName(m.from) + sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');

/** Standard algebraic notation, with + and #. */
export function san(p: Position, m: Move, legal = legalMoves(p)): string {
  let s: string;
  if (m.castle) s = m.castle === 'K' ? 'O-O' : 'O-O-O';
  else if (m.k === 'P') {
    s = (m.captured ? FILES[file(m.from)] + 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo : '');
  } else {
    const rivals = legal.filter((o) => o.k === m.k && o.to === m.to && o.from !== m.from);
    let dis = '';
    if (rivals.length) {
      if (!rivals.some((o) => file(o.from) === file(m.from))) dis = FILES[file(m.from)];
      else if (!rivals.some((o) => rank(o.from) === rank(m.from))) dis = String(rank(m.from) + 1);
      else dis = sqName(m.from);
    }
    s = m.k + dis + (m.captured ? 'x' : '') + sqName(m.to);
  }
  const next = play(p, m);
  if (inCheck(next)) s += legalMoves(next).length ? '+' : '#';
  return s;
}

/**
 * A move from text: UCI ("e2e4", "e7e8q") or SAN ("Nf3", "exd5", "O-O", "e8=Q+"). Undefined when it
 * isn't a legal move here.
 */
export function parseMove(p: Position, text: string, legal = legalMoves(p)): Move | undefined {
  const t = text.trim().replace(/[+#!?]+$/, '');
  const u = /^([a-h][1-8])-?([a-h][1-8])([qrbnQRBN])?$/.exec(t);
  if (u) {
    const from = sqIndex(u[1]);
    const to = sqIndex(u[2]);
    const promo = u[3]?.toUpperCase() as Kind | undefined;
    const hits = legal.filter((m) => m.from === from && m.to === to);
    if (!hits.length) return;
    return hits.find((m) => (m.promo ?? undefined) === (promo ?? (hits[0].promo ? 'Q' : undefined)));
  }
  const norm = t.replace(/0/g, 'O');
  return legal.find((m) => san(p, m, legal).replace(/[+#]$/, '') === norm) ?? legal.find((m) => san(p, m, legal).replace(/[+#]$/, '').replace('=', '') === norm.replace('=', ''));
}

// ------------------------------------------------------------------ game end

export type Outcome = { result: '1-0' | '0-1' | '1/2-1/2'; reason: 'checkmate' | 'stalemate' | 'fifty-move rule' | 'insufficient material' };

export function outcome(p: Position, legal = legalMoves(p)): Outcome | undefined {
  if (!legal.length) {
    if (inCheck(p)) return { result: p.turn === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
    return { result: '1/2-1/2', reason: 'stalemate' };
  }
  if (p.half >= 100) return { result: '1/2-1/2', reason: 'fifty-move rule' };
  const rest = p.sq.filter((m): m is Man => !!m && m.k !== 'K');
  if (!rest.length || (rest.length === 1 && (rest[0].k === 'B' || rest[0].k === 'N'))) return { result: '1/2-1/2', reason: 'insufficient material' };
  return;
}

// ------------------------------------------------------------------ bot

const VALUE: Record<Kind, number> = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

/** Material plus a nudge towards the center and pawn advances, from the side to move's view. */
function evaluate(p: Position): number {
  let score = 0;
  for (let s = 0; s < 64; s++) {
    const m = p.sq[s];
    if (!m) continue;
    const f = file(s);
    const r = rank(s);
    let v = VALUE[m.k];
    if (m.k === 'N' || m.k === 'B') v += 10 - 3 * (Math.abs(3.5 - f) + Math.abs(3.5 - r));
    if (m.k === 'P') v += 4 * (m.c === 'w' ? r - 1 : 6 - r) + (f >= 2 && f <= 5 ? 6 : 0);
    score += m.c === p.turn ? v : -v;
  }
  return score;
}

function search(p: Position, depth: number, alpha: number, beta: number): number {
  const legal = legalMoves(p);
  if (!legal.length) return inCheck(p) ? -100000 - depth : 0;
  if (depth === 0) return evaluate(p);
  // captures first: better cutoffs
  legal.sort((a, b) => (b.captured ? VALUE[b.captured] : 0) - (a.captured ? VALUE[a.captured] : 0));
  for (const m of legal) {
    const v = -search(play(p, m), depth - 1, -beta, -alpha);
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return alpha;
}

/**
 * The built-in opponent: depth 0 = a random legal move; depth n = negamax (alpha-beta) n plies deep
 * on material, ties broken at random. Small on purpose: it proves the loop, it doesn't play well.
 */
export function botMove(p: Position, depth = 2, random: () => number = Math.random): Move | undefined {
  const legal = legalMoves(p);
  if (!legal.length) return;
  if (depth <= 0) return legal[Math.floor(random() * legal.length)];
  let best = -Infinity;
  let picks: Move[] = [];
  for (const m of legal) {
    const v = -search(play(p, m), depth - 1, -Infinity, Infinity);
    if (v > best) {
      best = v;
      picks = [m];
    } else if (v === best) picks.push(m);
  }
  return picks[Math.floor(random() * picks.length)];
}
