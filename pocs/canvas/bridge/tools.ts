import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Client } from './client';
import { COLORS, gameText, playMove, waitForTurn } from './chess';
import { chatText } from './chatText';
import type { GameView } from '../src/plugins/chess/game';

// The canvas tools for MCP, shared by the standalone bridge's stdio server (bridge/mcp.ts, one board
// over HTTP) and the desktop app's endpoint (many boards in-process: every tool takes `board`).

export const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
export const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] });
export const tool =
  <T,>(fn: (a: T) => Promise<unknown>) =>
  async (a: T) => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return fail(e);
    }
  };

const ref = z.string().describe('node id, or its title (a unique prefix/substring is enough)');

/**
 * Register canvas_list/add_node/update_node/connect/remove/undo/log, chess_* and chat_*. `clientFor(board)` gives the
 * board's client acting as this agent; with `multiBoard`, each tool takes an optional `board`
 * (id, file path or file name; may be left out when only one board is open). The chess and chat tools
 * name the file `canvas` instead, because their `board` is the chessboard on the table.
 */
export function registerCanvasTools(server: McpServer, clientFor: (board?: string) => Client | Promise<Client>, multiBoard = false) {
  const boardArg: Record<string, z.ZodOptional<z.ZodString>> = multiBoard ? { board: z.string().optional().describe('board id, .canvas path or file name (see list_canvases); optional when one board is open') } : {};
  const on = async (a: { board?: string }) => clientFor(a.board);
  const cmd = async (c: Client, name: string, args: unknown) => {
    const r = await c.cmd(name, args);
    if (!r.ok) throw new Error(r.error ?? 'failed');
    return r;
  };

  server.registerTool(
    'canvas_list',
    {
      description: 'List nodes on the canvas (id, type, text, position, column, outgoing links). Filters are optional. Facts and ids; for layout or plugin-rendered content use canvas_screenshot when available.',
      inputSchema: { ...boardArg, type: z.string().optional().describe('text | group | link | file | …'), text: z.string().optional(), column: z.string().optional().describe('column (group) label'), ext: z.string().optional().describe('plugin namespace, e.g. x-sync, x-cards') },
    },
    tool(async ({ board, ...q }: { board?: string } & Record<string, string | undefined>) => (await on({ board })).query(q)),
  );

  server.registerTool(
    'canvas_add_node',
    {
      description: 'Add a note (or a link/column). Without x/y it goes in `column`, below `near`, or right of everything. A link with embed=true shows the page live (iframe). Returns the new id.',
      inputSchema: {
        ...boardArg,
        text: z.string().describe('markdown; first line is the title'),
        type: z.enum(['text', 'group', 'link']).optional(),
        url: z.string().optional(),
        embed: z.boolean().optional().describe('link only: render the page live inside the node'),
        column: ref.optional(),
        near: ref.optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        color: z.string().optional().describe('1 red, 2 orange, 3 yellow, 4 green, 5 cyan, 6 purple, or #hex'),
      },
    },
    tool(async ({ board, ...a }: { board?: string; text: string; type?: string; url?: string; column?: string; near?: string } & Record<string, unknown>) => {
      const c = await on({ board });
      const r = await cmd(c, 'board.add', {
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
      inputSchema: { ...boardArg, node: ref, text: z.string().optional(), label: z.string().optional(), color: z.string().nullable().optional(), x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional(), column: ref.optional() },
    },
    tool(async ({ board, node, column, ...a }: { board?: string; node: string; column?: string } & Record<string, unknown>) => {
      const c = await on({ board });
      const id = await c.resolve(node);
      await cmd(c, 'board.update', { id, ...a, column: column && (await c.resolve(column)) });
      return { id };
    }),
  );

  server.registerTool(
    'canvas_connect',
    { description: 'Draw an arrow from one node to another (optional label). Re-linking updates the label.', inputSchema: { ...boardArg, from: ref, to: ref, label: z.string().optional() } },
    tool(async (a: { board?: string; from: string; to: string; label?: string }) => {
      const c = await on(a);
      const [from, to] = await Promise.all([c.resolve(a.from), c.resolve(a.to)]);
      await cmd(c, 'board.connect', { from, to, label: a.label });
      return { from, to };
    }),
  );

  server.registerTool(
    'canvas_remove',
    { description: 'Remove nodes (their links go too).', inputSchema: { ...boardArg, nodes: z.array(ref) } },
    tool(async (a: { board?: string; nodes: string[] }) => {
      const c = await on(a);
      return cmd(c, 'board.remove', { ids: await Promise.all(a.nodes.map((n) => c.resolve(n))) });
    }),
  );

  server.registerTool(
    'canvas_undo',
    { description: 'Undo your own last step (other players’ steps are theirs to undo).', inputSchema: { ...boardArg, redo: z.boolean().optional() } },
    tool(async (a: { board?: string; redo?: boolean }) => {
      const r = await (await on(a)).undo(!!a.redo);
      if (!r.ok) throw new Error(r.error);
      return 'done';
    }),
  );

  server.registerTool(
    'canvas_log',
    { description: 'Recent events on the canvas: who did what (people, agents, the file, tools).', inputSchema: { ...boardArg, limit: z.number().optional() } },
    tool(async (a: { board?: string; limit?: number }) => (await (await on(a)).log(a.limit ?? 20)).map((e) => `${e.time.slice(11, 19)} ${e.actor ?? '—'} ${e.text}`).join('\n')),
  );

  // ---------------------------------------------------------------- chess: play a game as a seat
  // The game-level view (not raw nodes): state as text, a move by notation, and a blocking wait for
  // your turn. Moves go through the chess plugin's commands, so a person watching sees your cursor go
  // to the piece and the log say "<you> played Black Nf6"; illegal or out-of-turn moves are refused.

  const canvasArg: Record<string, z.ZodOptional<z.ZodString>> = multiBoard ? { canvas: z.string().optional().describe('which open .canvas file (id, path or name; see list_canvases); optional when one is open') } : {};
  const at = async (a: { canvas?: string }) => clientFor(a.canvas);
  const chessBoard = z.string().optional().describe('chessboard id; only needed when the table has several chessboards');
  const state = async (c: Client, board?: string) => gameText(await c.view<GameView>('chess.state', { board }));
  const boardOf = async (c: Client, board?: string) => board ?? (await c.view<GameView>('chess.state')).board;

  server.registerTool(
    'chess_state',
    {
      description: 'The chess game on the table: picture (uppercase = white, white at the bottom), whose move, seats, your color, move history, legal moves (SAN) and FEN.',
      inputSchema: { ...canvasArg, board: chessBoard },
    },
    tool(async (a: { canvas?: string; board?: string }) => state(await at(a), a.board)),
  );

  server.registerTool(
    'chess_sit',
    { description: 'Take a seat at a color (white or black): from then on only you move that color. `leave` stands up.', inputSchema: { ...canvasArg, color: z.enum(['white', 'black']), leave: z.boolean().optional(), board: chessBoard } },
    tool(async (a: { canvas?: string; color: string; leave?: boolean; board?: string }) => {
      const c = await at(a);
      const id = await boardOf(c, a.board);
      await cmd(c, 'chess.sit', { id, color: COLORS[a.color], leave: a.leave });
      return state(c, id);
    }),
  );

  server.registerTool(
    'chess_new_game',
    { description: 'Start a new game by the rules: the board’s pieces go back to the start (or a new set appears if there is no board). Seats are kept.', inputSchema: { ...canvasArg, board: chessBoard } },
    tool(async (a: { canvas?: string; board?: string }) => {
      const c = await at(a);
      const id = a.board ?? (await c.view<GameView>('chess.state').then((v) => v.board, () => undefined));
      await cmd(c, 'chess.newgame', id ? { id } : { x: 0, y: 0 });
      return state(c, id);
    }),
  );

  server.registerTool(
    'chess_move',
    {
      description: 'Play your move: SAN (Nf3, exd5, O-O, e8=Q) or UCI (e2e4, e7e8q). Refused with the reason (and the legal moves) if illegal or not your turn. Returns the game after it.',
      inputSchema: { ...canvasArg, move: z.string(), board: chessBoard },
    },
    tool(async (a: { canvas?: string; move: string; board?: string }) => gameText(await playMove(await at(a), a.move, a.board))),
  );

  server.registerTool(
    'chess_wait_for_turn',
    {
      description: 'Block until it is your move (or the game ended), then return the game. Use after chess_move to wait for the opponent. Returns "still waiting" after timeout_s (default 240); call again.',
      inputSchema: { ...canvasArg, board: chessBoard, timeout_s: z.number().optional() },
    },
    tool(async (a: { canvas?: string; board?: string; timeout_s?: number }) => {
      const v = await waitForTurn(await at(a), a.board, a.timeout_s ?? 240);
      return v ? gameText(v) : 'still waiting for the opponent; call chess_wait_for_turn again';
    }),
  );

  server.registerTool(
    'chess_takeback',
    { description: 'Take back your last move and the reply to it (plain undo is off in a rules game). Returns the game.', inputSchema: { ...canvasArg, board: chessBoard } },
    tool(async (a: { canvas?: string; board?: string }) => {
      const c = await at(a);
      const id = await boardOf(c, a.board);
      await cmd(c, 'chess.takeback', { id });
      return state(c, id);
    }),
  );

  server.registerTool(
    'chess_resign',
    { description: 'Resign the game for your color.', inputSchema: { ...canvasArg, board: chessBoard } },
    tool(async (a: { canvas?: string; board?: string }) => {
      const c = await at(a);
      const id = await boardOf(c, a.board);
      await cmd(c, 'chess.resign', { id });
      return state(c, id);
    }),
  );

  // ---------------------------------------------------------------- chat: talk to the people at the table
  // Messages show in everyone's chat panel under your name (marked as an agent). Mention a player with
  // @Name; point at a node with `node` (clicking the message jumps there).

  server.registerTool(
    'chat_send',
    {
      description: 'Say something in the table chat, as a player. Mention people with @Name (or @all). `node` = a node (id or title) the message is about.',
      inputSchema: { ...canvasArg, text: z.string(), node: ref.optional() },
    },
    tool(async (a: { canvas?: string; text: string; node?: string }) => {
      const c = await at(a);
      await c.say(a.text, a.node && (await c.resolve(a.node)));
      return 'sent';
    }),
  );

  server.registerTool(
    'chat_read',
    {
      description: 'Read the table chat: the last `limit` messages (default 20), or only what is new since you last looked (`only_new`).',
      inputSchema: { ...canvasArg, limit: z.number().optional(), only_new: z.boolean().optional() },
    },
    tool(async (a: { canvas?: string; limit?: number; only_new?: boolean }) => {
      const c = await at(a);
      return (await chatText(c, await c.chatRead({ limit: a.limit, onlyNew: a.only_new }))) || (a.only_new ? '(nothing new)' : '(no messages)');
    }),
  );

  server.registerTool(
    'chat_wait',
    {
      description: 'Block until someone else says something in the table chat, then return the new messages. Returns "nothing new" after timeout_s (default 240); call again. Reply with chat_send.',
      inputSchema: { ...canvasArg, timeout_s: z.number().optional() },
    },
    tool(async (a: { canvas?: string; timeout_s?: number }) => {
      const c = await at(a);
      return (await chatText(c, await c.chatWait(a.timeout_s ?? 240))) || 'nothing new yet; call chat_wait again';
    }),
  );
}
