import type { AgentApi, CliExtra } from '../../core/agent';
import type { GameView } from './game';
import { botMove, parseFen, uci } from './rules';
import { COLORS } from './text';

// Node-only: the built-in opponent and its command line verb. It plays through the same agent API
// an LLM uses (sit, wait for the turn, move), with a search instead of a model.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BotOptions {
  color: 'white' | 'black';
  depth: number;
  board?: string;
  delayMs: number;
  keep: boolean;
  say(line: string): void;
}

/**
 * Sit at `color`, then wait for the turn, pick a move (rules.botMove) and play it, until the game
 * ends. `keep`: stay seated and play the next game too.
 */
export async function runBot(api: AgentApi, opts: BotOptions) {
  const first = await api.view<GameView>('chess.state', { board: opts.board });
  const board = first.board;
  const name = opts.color;
  const sit = async () => void (await api.run('chess.sit', { color: opts.color, board }));
  await sit();
  // stand up when done or stopped, so the seat doesn't stay taken by a bot that's gone
  const leave = () => api.run('chess.sit', { color: opts.color, leave: true, board }).catch(() => undefined);
  const stop = () => void leave().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  opts.say(`seated as ${name} on board ${board} (depth ${opts.depth}); waiting for my move…`);
  for (;;) {
    const v = await api.wait<GameView>('chess.turn', { board }, 50);
    if (!v) {
      // not my move yet: still seated? (a seat freed from the menu while the opponent thinks, then
      // taken by someone else, never makes it my turn: stop instead of waiting at the table forever)
      const s = await api.view<GameView>('chess.state', { board });
      if (!s.result && s.you !== name) {
        opts.say(`I no longer hold the ${name} seat (freed or moved); stopping`);
        return;
      }
      continue;
    }
    if (v.result) {
      opts.say(`game over: ${v.result} (${v.end}) · ${v.moves}`);
      if (!opts.keep) return void (await leave());
      // wait for someone to start a new game (the result goes away), then sit again
      while ((await api.view<GameView>('chess.state', { board })).result) await sleep(2000);
      await sit().catch((e) => opts.say(`can't sit: ${(e as Error).message}`));
      opts.say('new game');
      continue;
    }
    if (!v.rules) {
      await sleep(2000);
      continue;
    }
    if (v.you !== name) {
      opts.say(`I no longer hold the ${name} seat (freed or moved); stopping`);
      return;
    }
    await sleep(opts.delayMs);
    const m = botMove(parseFen(v.fen), opts.depth);
    if (!m) continue;
    try {
      await api.run('chess.move', { move: uci(m), board });
      opts.say(`played ${uci(m)}`);
    } catch (e) {
      opts.say(`move refused: ${(e as Error).message}`);
      await sleep(2000);
    }
  }
}

export const chessBot: CliExtra = {
  verb: 'bot chess',
  usage: 'bot chess [--color black] [--depth 2] [--delay 600] [--keep] [--board ID]   built-in opponent: sits, waits, moves (as --as, default "Bot")',
  as: 'Bot',
  async run(api, { flags, say }) {
    const color = COLORS[flags.color ?? 'black'];
    if (!color) throw new Error('--color white|black');
    await runBot(api, { color: color === 'w' ? 'white' : 'black', depth: Number(flags.depth ?? 2), board: flags.board, delayMs: Number(flags.delay ?? 600), keep: !!flags.keep, say: (m) => say(`${new Date().toISOString().slice(11, 19)} ${m}`) });
  },
};
