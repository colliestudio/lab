import type { GameView } from './game';

/** The game as an agent reads it: header, picture (white at the bottom), history, legal moves, FEN. */
export function gameText(v: GameView): string {
  const seat = (c: 'white' | 'black') => `${c} ${v.seats[c] ?? '(open)'}`;
  const status = v.result
    ? `game over: ${v.result} (${v.end})`
    : !v.rules
      ? 'free play (no rules: start a game to play by the rules)'
      : `move ${v.moveNumber}, ${v.turn} to move${v.check ? ', CHECK' : ''}`;
  const you = v.you ? `you play ${v.you}${v.yourTurn ? ': your move' : ''}` : v.yourTurn ? `you are not seated; ${v.turn}'s seat is open, you may move` : 'you are not seated';
  return [
    `board ${v.board} · ${status}`,
    `seats: ${seat('white')}, ${seat('black')} · ${you}`,
    '',
    v.ascii,
    '',
    `moves: ${v.moves || '(none yet)'}`,
    ...(v.legal.length ? [`legal: ${v.legal.join(' ')}`] : []),
    `fen: ${v.fen}`,
  ].join('\n');
}

export const COLORS: Record<string, 'w' | 'b'> = { w: 'w', white: 'w', b: 'b', black: 'b' };
