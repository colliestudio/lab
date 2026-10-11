import { describe, expect, it } from 'vitest';
import { botMove, legalMoves, outcome, parseFen, parseMove, play, san, startPosition, toFen, uci, type Position } from './rules';

const perft = (p: Position, d: number): number => (d === 0 ? 1 : legalMoves(p).reduce((n, m) => n + perft(play(p, m), d - 1), 0));
const seq = (p: Position, moves: string[]) => moves.reduce((q, t) => play(q, parseMove(q, t)!), p);

describe('chess rules', () => {
  it('perft: start, kiwipete (castling, pins), position 3 (en passant)', () => {
    expect(perft(startPosition(), 3)).toBe(8902);
    expect(perft(parseFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'), 2)).toBe(2039);
    expect(perft(parseFen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'), 3)).toBe(2812);
    expect(perft(parseFen('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1'), 2)).toBe(264);
  });

  it('FEN round trip and counters', () => {
    const p = seq(startPosition(), ['e4', 'c5', 'Nf3']);
    expect(toFen(p)).toBe('rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
    expect(toFen(seq(startPosition(), ['e4']))).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  });

  it('parses UCI and SAN, writes SAN with disambiguation, check and mate', () => {
    const p = startPosition();
    expect(uci(parseMove(p, 'e2e4')!)).toBe('e2e4');
    expect(uci(parseMove(p, 'Nf3')!)).toBe('g1f3');
    expect(parseMove(p, 'e2e5')).toBeUndefined();
    expect(parseMove(p, 'Ke2')).toBeUndefined();
    const rooks = parseFen('4k3/8/8/8/8/8/8/R4RK1 w - - 0 1');
    expect(san(rooks, parseMove(rooks, 'a1d1')!)).toBe('Rad1');
    const fools = seq(p, ['f3', 'e5', 'g4']);
    const mate = parseMove(fools, 'Qh4')!;
    expect(san(fools, mate)).toBe('Qh4#');
    expect(outcome(play(fools, mate))).toEqual({ result: '0-1', reason: 'checkmate' });
    const castle = parseFen('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    expect(san(castle, parseMove(castle, 'O-O')!)).toBe('O-O');
    expect(uci(parseMove(castle, '0-0-0')!)).toBe('e1c1');
    const promo = parseFen('7k/P7/8/8/8/8/8/K7 w - - 0 1');
    expect(uci(parseMove(promo, 'a7a8')!)).toBe('a7a8q');
    expect(uci(parseMove(promo, 'a8=N')!)).toBe('a7a8n');
    expect(san(promo, parseMove(promo, 'a7a8q')!)).toBe('a8=Q+');
  });

  it('draws: stalemate, insufficient material', () => {
    expect(outcome(parseFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'))?.reason).toBe('stalemate');
    expect(outcome(parseFen('7k/8/6K1/8/8/8/8/8 w - - 0 1'))?.reason).toBe('insufficient material');
  });

  it('bot: legal moves; takes a free queen; finds mate in one', () => {
    const p = startPosition();
    const legal = legalMoves(p).map(uci);
    expect(legal).toContain(uci(botMove(p, 0)!));
    const hanging = parseFen('4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1');
    expect(uci(botMove(hanging, 2)!)).toBe('d1d5');
    const m1 = parseFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
    expect(uci(botMove(m1, 2)!)).toBe('a1a8');
  });
});
