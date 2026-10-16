import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { client } from './client';
import { COLORS, gameText, playMove, waitForTurn } from './chess';
import { chatText } from './chatText';
import type { GameView } from '../src/plugins/chess/game';
import { describe, isDrawing, pickFrame, type Shape } from '../src/plugins/excalidraw/logic';

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

// ---------------------------------------------------------------- diagrams: shapes and arrows
// Boxes, ellipses, diamonds, text and sticky notes joined by arrows (the diagram plugin). Same
// commands the toolbar and handles run, so a person sees them appear and can undo them.

const kindArg = z.enum(['rect', 'ellipse', 'diamond', 'text', 'sticky']);
const sideArg = z.enum(['top', 'right', 'bottom', 'left']);
const endArg = z.enum(['none', 'arrow']);
const colorHint = '#hex or a JSON Canvas preset 1-6';
const shapeLook = {
  stroke: z.string().nullable().optional().describe(`outline and text color, a CSS color or a JSON Canvas preset 1-6; null = default`),
  fill: z.string().nullable().optional().describe(`fill color, #hex, or "none" for see-through; null = the kind's default`),
  dashed: z.boolean().optional(),
  size: z.number().nullable().optional().describe('text size in px (default 18); null = default'),
};

server.registerTool(
  'canvas_add_shape',
  {
    description:
      'Add a diagram shape (rect, ellipse, diamond, text, sticky). Place it with x/y (top-left), cx/cy (center) or right of everything. With `from` it is a new shape connected by an arrow from that shape (the fast flowchart step; `side` = which side of `from` the arrow leaves, `at` = where the new center goes). Returns the new id.',
    inputSchema: {
      kind: kindArg.optional().describe('default rect'),
      text: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      cx: z.number().optional(),
      cy: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      from: ref.optional().describe('connect from this shape'),
      side: sideArg.optional(),
      at: z.object({ x: z.number(), y: z.number() }).optional(),
      label: z.string().optional().describe('label for the arrow (with `from`)'),
      ...shapeLook,
    },
  },
  tool(async ({ from, ...a }: { from?: string } & Record<string, unknown>) => {
    const r = from ? await cmd('diagram.addConnected', { ...a, from: await c.resolve(from) }) : await cmd('diagram.add', a);
    return { id: r.select?.[0] };
  }),
);

server.registerTool(
  'canvas_style_shape',
  {
    description: 'Change a diagram shape: text, kind, colors, dashed, text size, and its place or size (x/y absolute, dx/dy relative, width/height). null clears a color or size.',
    inputSchema: { node: ref, text: z.string().optional(), kind: kindArg.optional(), x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional(), width: z.number().optional(), height: z.number().optional(), ...shapeLook },
  },
  tool(async ({ node, ...a }: { node: string } & Record<string, unknown>) => {
    const id = await c.resolve(node);
    await cmd('diagram.update', { id, ...a });
    return { id };
  }),
);

const arrowLook = {
  label: z.string().nullable().optional().describe('text on the arrow; null/"" removes it'),
  from_side: sideArg.nullable().optional().describe('side of the first shape the arrow leaves; default: the side facing the other shape'),
  to_side: sideArg.nullable().optional(),
  start: endArg.optional().describe('arrowhead at the start (default none)'),
  end: endArg.optional().describe('arrowhead at the end (default arrow)'),
  dashed: z.boolean().optional(),
  curve: z.boolean().optional().describe('curved instead of straight'),
  color: z.string().nullable().optional().describe(colorHint),
};
const arrowArgs = (a: { label?: string | null; from_side?: string | null; to_side?: string | null; start?: string; end?: string; dashed?: boolean; curve?: boolean; color?: string | null }) => ({
  label: a.label,
  fromSide: a.from_side,
  toSide: a.to_side,
  fromEnd: a.start,
  toEnd: a.end,
  dashed: a.dashed,
  curve: a.curve,
  color: a.color,
});

server.registerTool(
  'canvas_arrow',
  { description: 'Draw a diagram arrow from one shape to another, optionally labelled and styled. Returns the arrow id (for canvas_edit_arrow / canvas_remove_arrow; canvas_list shows each node’s outgoing arrows).', inputSchema: { from: ref, to: ref, ...arrowLook } },
  tool(async (a: { from: string; to: string } & Parameters<typeof arrowArgs>[0]) => {
    const [from, to] = await Promise.all([c.resolve(a.from), c.resolve(a.to)]);
    const r = await cmd('core.connect', { from, to, ...arrowArgs(a) });
    return { id: r.select?.[0] };
  }),
);

server.registerTool(
  'canvas_edit_arrow',
  { description: 'Change an arrow: label, sides, arrowheads, dashed, curve, color.', inputSchema: { arrow: z.string().describe('arrow id'), ...arrowLook } },
  tool(async (a: { arrow: string } & Parameters<typeof arrowArgs>[0]) => {
    await cmd('core.edge', { id: a.arrow, ...arrowArgs(a) });
    return { id: a.arrow };
  }),
);

server.registerTool(
  'canvas_remove_arrow',
  { description: 'Remove arrows by id (shapes stay). To remove shapes, use canvas_remove.', inputSchema: { arrows: z.array(z.string()) } },
  tool(async (a: { arrows: string[] }) => {
    // core.delete takes node ids too: only arrows go through here
    const edges = new Set((await c.doc()).edges.map((e) => e.id));
    const bad = a.arrows.filter((id) => !edges.has(id));
    if (bad.length) throw new Error(`no arrow ${bad.join(', ')}`);
    return cmd('core.delete', { ids: a.arrows });
  }),
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
  'chess_takeback',
  { description: 'Take back your last move and the reply to it (plain undo is off in a rules game). Returns the game.', inputSchema: { board: boardArg } },
  tool(async (a: { board?: string }) => {
    const id = a.board ?? (await c.view<GameView>('chess.state')).board;
    await cmd('chess.takeback', { id });
    return gameText(await c.view<GameView>('chess.state', { board: id }));
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

// ---------------------------------------------------------------- chat: talk to the people at the table
// Messages show in everyone's chat panel under your name (marked as an agent). Mention a player with
// @Name; point at a node with `node` (clicking the message jumps there).

server.registerTool(
  'chat_send',
  {
    description: 'Say something in the table chat, as a player. Mention people with @Name (or @all). `node` = a node (id or title) the message is about.',
    inputSchema: { text: z.string(), node: ref.optional() },
  },
  tool(async (a: { text: string; node?: string }) => {
    await c.say(a.text, a.node && (await c.resolve(a.node)));
    return 'sent';
  }),
);

server.registerTool(
  'chat_read',
  {
    description: 'Read the table chat: the last `limit` messages (default 20), or only what is new since you last looked (`only_new`).',
    inputSchema: { limit: z.number().optional(), only_new: z.boolean().optional() },
  },
  tool(async (a: { limit?: number; only_new?: boolean }) => (await chatText(c, await c.chatRead({ limit: a.limit, onlyNew: a.only_new }))) || (a.only_new ? '(nothing new)' : '(no messages)')),
);

server.registerTool(
  'chat_wait',
  {
    description: 'Block until someone else says something in the table chat, then return the new messages. Returns "nothing new" after timeout_s (default 240); call again. Reply with chat_send.',
    inputSchema: { timeout_s: z.number().optional() },
  },
  tool(async (a: { timeout_s?: number }) => (await chatText(c, await c.chatWait(a.timeout_s ?? 240))) || 'nothing new yet; call chat_wait again'),
);

// ------------------------------------------------------------ Excalidraw drawings
const drawingId = async (node?: string) => {
  const ds = (await c.doc()).nodes.filter(isDrawing);
  if (node) return pickFrame(ds, node) ?? c.resolve(node);
  if (ds.length === 1) return ds[0].id;
  throw new Error(ds.length ? `${ds.length} drawings: pass drawing (${ds.map((d) => d.id).join(', ')})` : 'no drawing on the canvas: canvas_draw_new first');
};
const shape = z
  .object({
    type: z.enum(['rectangle', 'ellipse', 'diamond', 'text', 'arrow']),
    ref: z.string().optional().describe('your name for it (becomes its id when free): arrows point at refs or shape ids'),
    label: z.string().optional().describe('text inside a shape, or on an arrow'),
    text: z.string().optional().describe('for type text'),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    size: z.number().optional().describe('font size for type text (default 20)'),
    from: z.string().optional().describe('arrow start: ref or shape id'),
    to: z.string().optional().describe('arrow end: ref or shape id'),
    stroke: z.string().optional().describe('#hex'),
    fill: z.string().optional().describe('#hex'),
    dashed: z.boolean().optional(),
    ends: z.enum(['none', 'end', 'both']).optional(),
  })
  .passthrough();
const drawingRef = z.string().optional().describe('frame node id or title (default: the only Excalidraw frame on the canvas)');

server.registerTool(
  'canvas_draw_new',
  {
    description:
      'Put a new Excalidraw frame on the canvas: a titled frame people draw in with the real Excalidraw (it scrolls/zooms inside; the frame keeps its size), optionally with shapes. x/y = center (640x440), or top-left with width/height. Returns its id.',
    inputSchema: { title: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), shapes: z.array(shape).optional() },
  },
  tool(async (a: { title?: string; x?: number; y?: number; width?: number; height?: number; shapes?: unknown[] }) => ({
    id: (await cmd('excalidraw.create', { x: a.x ?? 0, y: a.y ?? 0, width: a.width, height: a.height, title: a.title, shapes: a.shapes as Shape[] | undefined })).select?.[0],
  })),
);
server.registerTool(
  'canvas_draw_shapes',
  { description: "List an Excalidraw drawing's shapes: id, type, label, position, arrows (from → to ids).", inputSchema: { drawing: drawingRef } },
  tool(async (a: { drawing?: string }) => {
    const id = await drawingId(a.drawing);
    return describe((await c.doc()).nodes.find((n) => n.id === id)!);
  }),
);
server.registerTool(
  'canvas_draw_add',
  {
    description:
      'Add shapes to an Excalidraw drawing: boxes (rectangle/ellipse/diamond with a label), text, arrows between shapes (from/to = a ref from this call or an existing shape id, optional label). x/y are the drawing’s own coordinates (see canvas_draw_shapes; boxes ~140x70); without x/y shapes go in a row right of the drawing. The frame shows new shapes (it re-fits if they fall outside its view).',
    inputSchema: { drawing: drawingRef, shapes: z.array(shape) },
  },
  tool(async (a: { drawing?: string; shapes: unknown[] }) => {
    const id = await drawingId(a.drawing);
    await cmd('excalidraw.add', { id, shapes: a.shapes });
    return describe((await c.doc()).nodes.find((n) => n.id === id)!);
  }),
);
server.registerTool(
  'canvas_draw_remove',
  { description: 'Delete shapes from an Excalidraw drawing by id (their labels go too).', inputSchema: { drawing: drawingRef, ids: z.array(z.string()) } },
  tool(async (a: { drawing?: string; ids: string[] }) => cmd('excalidraw.remove', { id: await drawingId(a.drawing), ids: a.ids })),
);

server.registerTool(
  'canvas_draw_frame',
  { description: 'Change an Excalidraw frame: title, locked (a static picture people cannot draw in until unlocked), fit (show the whole drawing again).', inputSchema: { drawing: drawingRef, title: z.string().optional(), locked: z.boolean().optional(), fit: z.boolean().optional() } },
  tool(async (a: { drawing?: string; title?: string; locked?: boolean; fit?: boolean }) =>
    cmd('excalidraw.frame', { id: await drawingId(a.drawing), title: a.title, locked: a.locked, view: a.fit ? null : undefined }),
  ),
);

await server.connect(new StdioServerTransport());
