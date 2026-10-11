import { parseFen, botMove, uci } from '../src/plugins/chess/rules';
import type { GameView } from '../src/plugins/chess/game';
import type { Client } from './client';

// Chess for agents over the bridge: the game as text, a move, the turn loop, and the built-in bot.
// Shared by the CLI (`canvas chess …`, `canvas bot chess`) and the MCP server (chess_* tools).

export const COLORS: Record<string, 'w' | 'b'> = { w: 'w', white: 'w', b: 'b', black: 'b' };

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

/** Play a move (UCI or SAN) as this client's actor. Returns the game after it. */
export async function playMove(c: Client, move: string, board?: string): Promise<GameView> {
  const id = board ?? (await c.view<GameView>('chess.state')).board;
  const r = await c.cmd('chess.move', { id, move });
  if (!r.ok) throw new Error(r.error ?? 'move failed');
  return c.view<GameView>('chess.state', { board: id });
}

/** Block until it's this actor's move (or the game ended). Polls in `slice`-second long-polls. */
export async function waitForTurn(c: Client, board?: string, totalS = 290, slice = 50): Promise<GameView | undefined> {
  const end = Date.now() + totalS * 1000;
  while (Date.now() < end) {
    const left = Math.max(1, Math.min(slice, Math.round((end - Date.now()) / 1000)));
    const v = await c.wait<GameView>('chess.turn', { board }, left);
    if (!('waiting' in v)) return v;
  }
  return;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The built-in opponent: sit at `color`, then wait for the turn → pick a move (rules.botMove) → play
 * it, until the game ends. `keep`: stay seated and play the next game too. Exactly what an LLM agent
 * does through MCP, with a search instead of a model.
 */
export async function runBot(c: Client, opts: { color: 'w' | 'b'; depth: number; board?: string; delayMs: number; keep: boolean; say: (s: string) => void }) {
  const first = await c.view<GameView>('chess.state', { board: opts.board });
  const id = first.board;
  const name = opts.color === 'w' ? 'white' : 'black';
  const sit = async () => {
    const r = await c.cmd('chess.sit', { id, color: opts.color });
    if (!r.ok) throw new Error(r.error);
  };
  await sit();
  // stand up when done or stopped, so the seat doesn't stay taken by a bot that's gone
  const leave = () => c.cmd('chess.sit', { id, color: opts.color, leave: true }).catch(() => undefined);
  const stop = () => void leave().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  opts.say(`seated as ${name} on board ${id} (depth ${opts.depth}); waiting for my move…`);
  for (;;) {
    const v = await waitForTurn(c, id);
    if (!v) continue;
    if (v.result) {
      opts.say(`game over: ${v.result} (${v.end}) · ${v.moves}`);
      if (!opts.keep) return void (await leave());
      // wait for someone to start a new game (the result goes away), then sit again
      while ((await c.view<GameView>('chess.state', { board: id })).result) await sleep(2000);
      await sit().catch((e) => opts.say(`can't sit: ${(e as Error).message}`));
      opts.say('new game');
      continue;
    }
    if (!v.rules) {
      await sleep(2000);
      continue;
    }
    if (v.you && v.you !== name) {
      opts.say(`someone moved me to ${v.you}; stopping`);
      return;
    }
    await sleep(opts.delayMs);
    const m = botMove(parseFen(v.fen), opts.depth);
    if (!m) continue;
    const r = await c.cmd('chess.move', { id, move: uci(m) });
    if (r.ok) opts.say(`played ${uci(m)}`);
    else {
      opts.say(`move refused: ${r.error}`);
      await sleep(2000);
    }
  }
}
