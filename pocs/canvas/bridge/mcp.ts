import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { client } from './client';
import { COLORS, gameText, playMove, waitForTurn } from './chess';
import type { GameView } from '../src/plugins/chess/game';

// MCP server: the same operations as the CLI, as tools, so a Claude agent can read the board and
// add/move/link nodes live while people watch (it is seated as a player: cursor, log name, undo).
//   claude mcp add canvas -e CANVAS_AS=Claude -- pnpm --dir <repo> -s canvas-mcp
// Talks to the bridge at $CANVAS_BRIDGE (default http://localhost:5222).

const c = client({ as: process.env.CANVAS_AS ?? 'Claude' });
const server = new McpServer({ name: 'canvas', version: '0.1.0' });

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] });
const tool = <T,>(fn: (a: T) => Promise<unknown>) => async (a: T) => {
  try {
    return ok(await fn(a));
  } catch (e) {
    return fail(e);
  }
};
const cmd = async (name: string, args: unknown) => {
  const r = await c.cmd(name, args);
  if (!r.ok) throw new Error(r.error ?? 'failed');
  return r;
};
const ref = z.string().describe('node id, or its title (a unique prefix/substring is enough)');

server.registerTool(
  'canvas_list',
  {
    description: 'List nodes on the canvas (id, type, text, position, column, outgoing links). Filters are optional.',
    inputSchema: { type: z.string().optional().describe('text | group | link | file | …'), text: z.string().optional(), column: z.string().optional().describe('column (group) label'), ext: z.string().optional().describe('plugin namespace, e.g. x-sync, x-cards') },
  },
  tool((a: Record<string, string | undefined>) => c.query(a)),
);

server.registerTool(
  'canvas_add_node',
  {
    description: 'Add a note (or a link/column). Without x/y it goes in `column`, below `near`, or right of everything. Returns the new id.',
    inputSchema: {
      text: z.string().describe('markdown; first line is the title'),
      type: z.enum(['text', 'group', 'link']).optional(),
      url: z.string().optional(),
      column: ref.optional(),
      near: ref.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      color: z.string().optional().describe('1 red, 2 orange, 3 yellow, 4 green, 5 cyan, 6 purple, or #hex'),
    },
  },
  tool(async (a: { text: string; type?: string; url?: string; column?: string; near?: string; x?: number; y?: number; color?: string }) => {
    const r = await cmd('board.add', {
      ...a,
      label: a.type === 'group' ? a.text : undefined,
      column: a.column && (await c.resolve(a.column)),
      near: a.near && (await c.resolve(a.near)),
    });
    return { id: r.select?.[0] };
  }),
);

server.registerTool(
  'canvas_update_node',
  {
    description: 'Edit or move a node: new text/label/color, absolute x/y, relative dx/dy, or into a column.',
    inputSchema: { node: ref, text: z.string().optional(), label: z.string().optional(), color: z.string().nullable().optional(), x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional(), column: ref.optional() },
  },
  tool(async ({ node, column, ...a }: { node: string; column?: string } & Record<string, unknown>) => {
    const id = await c.resolve(node);
    await cmd('board.update', { id, ...a, column: column && (await c.resolve(column)) });
    return { id };
  }),
);

server.registerTool(
  'canvas_connect',
  { description: 'Draw an arrow from one node to another (optional label). Re-linking updates the label.', inputSchema: { from: ref, to: ref, label: z.string().optional() } },
  tool(async (a: { from: string; to: string; label?: string }) => {
    const [from, to] = await Promise.all([c.resolve(a.from), c.resolve(a.to)]);
    await cmd('board.connect', { from, to, label: a.label });
    return { from, to };
  }),
);

server.registerTool(
  'canvas_remove',
  { description: 'Remove nodes (their links go too).', inputSchema: { nodes: z.array(ref) } },
  tool(async (a: { nodes: string[] }) => cmd('board.remove', { ids: await Promise.all(a.nodes.map((n) => c.resolve(n))) })),
);

server.registerTool(
  'canvas_undo',
  { description: 'Undo your own last step (other players’ steps are theirs to undo).', inputSchema: { redo: z.boolean().optional() } },
  tool(async (a: { redo?: boolean }) => {
    const r = await c.undo(!!a.redo);
    if (!r.ok) throw new Error(r.error);
    return 'done';
  }),
);

server.registerTool(
  'canvas_log',
  { description: 'Recent events on the canvas: who did what (people, agents, the file, tools).', inputSchema: { limit: z.number().optional() } },
  tool(async (a: { limit?: number }) => (await c.log(a.limit ?? 20)).map((e) => `${e.time.slice(11, 19)} ${e.actor ?? '—'} ${e.text}`).join('\n')),
);

// ---------------------------------------------------------------- chess: play a game as a seat
// The game-level view (not raw nodes): state as text, a move by notation, and a blocking wait for
// your turn. Moves go through the chess plugin's commands, so a person watching sees your cursor go
// to the piece and the log say "<you> played Black Nf6"; illegal or out-of-turn moves are refused.

const boardArg = z.string().optional().describe('board id; only needed when the table has several chessboards');

server.registerTool(
  'chess_state',
  {
    description:
      'The chess game on the table: picture (uppercase = white, white at the bottom), whose move, seats, your color, move history, legal moves (SAN) and FEN.',
    inputSchema: { board: boardArg },
  },
  tool(async (a: { board?: string }) => gameText(await c.view<GameView>('chess.state', { board: a.board }))),
);

server.registerTool(
  'chess_sit',
  { description: 'Take a seat at a color (white or black): from then on only you move that color. `leave` stands up.', inputSchema: { color: z.enum(['white', 'black']), leave: z.boolean().optional(), board: boardArg } },
  tool(async (a: { color: string; leave?: boolean; board?: string }) => {
    const id = a.board ?? (await c.view<GameView>('chess.state')).board;
    await cmd('chess.sit', { id, color: COLORS[a.color], leave: a.leave });
    return gameText(await c.view<GameView>('chess.state', { board: id }));
  }),
);

server.registerTool(
  'chess_new_game',
  { description: 'Start a new game by the rules: the board’s pieces go back to the start (or a new set appears if there is no board). Seats are kept.', inputSchema: { board: boardArg } },
  tool(async (a: { board?: string }) => {
    const id = a.board ?? (await c.view<GameView>('chess.state').then((v) => v.board, () => undefined));
    await cmd('chess.newgame', id ? { id } : { x: 0, y: 0 });
    return gameText(await c.view<GameView>('chess.state', { board: id }));
  }),
);

server.registerTool(
  'chess_move',
  {
    description: 'Play your move: SAN (Nf3, exd5, O-O, e8=Q) or UCI (e2e4, e7e8q). Refused with the reason (and the legal moves) if illegal or not your turn. Returns the game after it.',
    inputSchema: { move: z.string(), board: boardArg },
  },
  tool(async (a: { move: string; board?: string }) => gameText(await playMove(c, a.move, a.board))),
);

server.registerTool(
  'chess_wait_for_turn',
  {
    description: 'Block until it is your move (or the game ended), then return the game. Use after chess_move to wait for the opponent. Returns "still waiting" after timeout_s (default 240); call again.',
    inputSchema: { board: boardArg, timeout_s: z.number().optional() },
  },
  tool(async (a: { board?: string; timeout_s?: number }) => {
    const v = await waitForTurn(c, a.board, a.timeout_s ?? 240);
    return v ? gameText(v) : 'still waiting for the opponent; call chess_wait_for_turn again';
  }),
);

server.registerTool(
  'chess_resign',
  { description: 'Resign the game for your color.', inputSchema: { board: boardArg } },
  tool(async (a: { board?: string }) => {
    const id = a.board ?? (await c.view<GameView>('chess.state')).board;
    await cmd('chess.resign', { id });
    return gameText(await c.view<GameView>('chess.state', { board: id }));
  }),
);

await server.connect(new StdioServerTransport());
