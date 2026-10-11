import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Actor } from '../../bridge/host';
import { queryNodes, resolveNode } from '../../bridge/query';
import type { Board } from './board';

// The app's MCP tools: the agent-bridge tools (bridge/mcp.ts) plus a `board` argument, canvas
// discovery (list_canvases, open_canvas) and canvas_screenshot. Runs in-process against the boards
// (no HTTP hop); one McpServer per session, `actor()` = that session's seat.

export interface ShotOpts {
  camera?: { x: number; y: number; zoom: number } | 'fit' | 'keep';
  width?: number;
  height?: number;
  labels?: boolean;
}

export interface Service {
  list(): unknown[];
  open(path: string, show: boolean): Promise<unknown>;
  board(ref?: string): Board;
  eval?(b: Board, seat: { id: string; name: string }, js: string): Promise<unknown>;
  screenshot(b: Board, seat: { id: string; name: string }, opts: ShotOpts): Promise<{ png: string; width: number; height: number; camera: unknown; ms: number }>;
}

export function makeMcpServer(svc: Service, actor: () => Actor) {
  const server = new McpServer({ name: 'canvas', version: '0.2.0' });
  const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] });
  const tool =
    <T,>(fn: (a: T) => Promise<unknown> | unknown) =>
    async (a: T) => {
      try {
        const r = await fn(a);
        return r && typeof r === 'object' && 'content' in (r as object) ? (r as any) : ok(r);
      } catch (e) {
        return fail(e);
      }
    };
  const board = z.string().optional().describe('which canvas: board id, file path, or file name (from list_canvases). Optional when one canvas is open.');
  const ref = z.string().describe('node id, or its title (a unique prefix/substring is enough)');
  const res = (b: Board, r: string) => resolveNode(b.host.store.doc, r).id;
  const cmd = (b: Board, name: string, args: unknown) => {
    const r = b.host.dispatch(actor(), name, args);
    if (!r.ok) throw new Error(r.error ?? 'failed');
    return r;
  };

  server.registerTool('list_canvases', { description: 'Canvases open in the Canvas app: board id, file, node count, people and agents at the table.', inputSchema: {} }, tool(() => svc.list()));

  server.registerTool(
    'open_canvas',
    {
      description: 'Open a .canvas file (created if missing) in the app, so you and people can work on it. Returns its board id.',
      inputSchema: { path: z.string().describe('absolute path to a .canvas file'), show: z.boolean().optional().describe('also open a window for people (default true)') },
    },
    tool((a: { path: string; show?: boolean }) => svc.open(a.path, a.show ?? true)),
  );

  server.registerTool(
    'canvas_list',
    {
      description: 'List nodes on a canvas (id, type, text, position, column, outgoing links). Filters are optional. Use for facts and ids; use canvas_screenshot for layout and looks.',
      inputSchema: { board, type: z.string().optional().describe('text | group | link | file | …'), text: z.string().optional(), column: z.string().optional(), ext: z.string().optional() },
    },
    tool((a: { board?: string; type?: string; text?: string; column?: string; ext?: string }) => queryNodes(svc.board(a.board).host.store.doc, a)),
  );

  server.registerTool(
    'canvas_add_node',
    {
      description: 'Add a note (or a link/column). Without x/y it goes in `column`, below `near`, or right of everything. Returns the new id.',
      inputSchema: {
        board,
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
    tool((a: { board?: string; text: string; type?: string; column?: string; near?: string } & Record<string, unknown>) => {
      const b = svc.board(a.board);
      const { board: _b, ...rest } = a;
      const r = cmd(b, 'board.add', { ...rest, label: a.type === 'group' ? a.text : undefined, column: a.column && res(b, a.column), near: a.near && res(b, a.near) });
      return { id: r.select?.[0] };
    }),
  );

  server.registerTool(
    'canvas_update_node',
    {
      description: 'Edit or move a node: new text/label/color, absolute x/y, relative dx/dy, or into a column.',
      inputSchema: { board, node: ref, text: z.string().optional(), label: z.string().optional(), color: z.string().nullable().optional(), x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional(), column: ref.optional() },
    },
    tool(({ board: bref, node, column, ...a }: { board?: string; node: string; column?: string } & Record<string, unknown>) => {
      const b = svc.board(bref);
      const id = res(b, node);
      cmd(b, 'board.update', { id, ...a, column: column && res(b, column) });
      return { id };
    }),
  );

  server.registerTool(
    'canvas_connect',
    { description: 'Draw an arrow from one node to another (optional label).', inputSchema: { board, from: ref, to: ref, label: z.string().optional() } },
    tool((a: { board?: string; from: string; to: string; label?: string }) => {
      const b = svc.board(a.board);
      const from = res(b, a.from);
      const to = res(b, a.to);
      cmd(b, 'board.connect', { from, to, label: a.label });
      return { from, to };
    }),
  );

  server.registerTool(
    'canvas_remove',
    { description: 'Remove nodes (their links go too).', inputSchema: { board, nodes: z.array(ref) } },
    tool((a: { board?: string; nodes: string[] }) => {
      const b = svc.board(a.board);
      const r = cmd(b, 'board.remove', { ids: a.nodes.map((n) => res(b, n)) });
      return { removed: r.touched };
    }),
  );

  server.registerTool(
    'canvas_undo',
    { description: 'Undo your own last step on a canvas (other players’ steps are theirs to undo).', inputSchema: { board, redo: z.boolean().optional() } },
    tool((a: { board?: string; redo?: boolean }) => {
      if (!svc.board(a.board).host.undo(actor(), !!a.redo)) throw new Error(`nothing to ${a.redo ? 'redo' : 'undo'} for ${actor().name}`);
      return 'done';
    }),
  );

  server.registerTool(
    'canvas_log',
    { description: 'Recent events on a canvas: who did what (people, agents, the file, tools).', inputSchema: { board, limit: z.number().optional() } },
    tool((a: { board?: string; limit?: number }) =>
      svc
        .board(a.board)
        .host.store.log.toArray()
        .slice(-(a.limit ?? 20))
        .map((e) => `${new Date(e.time).toISOString().slice(11, 19)} ${e.actor?.name ?? '—'} ${e.text}`)
        .join('\n'),
    ),
  );

  server.registerTool(
    'canvas_screenshot',
    {
      description:
        'See the canvas as rendered (PNG), through your own camera (a hidden window for your seat; it keeps its position between calls). ' +
        'Use for layout, overlaps and plugin-rendered content; use canvas_list for exact text and ids. ~1k tokens at the default size.',
      inputSchema: {
        board,
        camera: z
          .union([z.literal('fit'), z.literal('keep'), z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() })])
          .optional()
          .describe('"fit" (default first time) = whole board; "keep" = where your camera was; or {x,y,zoom}: world point at the center and zoom (1 = 100%)'),
        width: z.number().int().min(200).max(2400).optional().describe('pixels, default 1000'),
        height: z.number().int().min(150).max(1800).optional().describe('pixels, default 750'),
        labels: z.boolean().optional().describe('overlay node ids on the image'),
      },
    },
    tool(async (a: { board?: string } & ShotOpts) => {
      const b = svc.board(a.board);
      const me = actor();
      const r = await svc.screenshot(b, { id: me.id, name: me.name }, { camera: a.camera, width: a.width, height: a.height, labels: a.labels });
      return {
        content: [
          { type: 'image' as const, data: r.png, mimeType: 'image/png' },
          { type: 'text' as const, text: JSON.stringify({ board: b.id, width: r.width, height: r.height, camera: r.camera, ms: r.ms }) },
        ],
      };
    }),
  );

  if (process.env.CANVAS_DEBUG) {
    server.registerTool(
      'canvas_debug_eval',
      { description: 'Debug: run JS (async function body) in your eye window for a board; returns JSON.', inputSchema: { board, js: z.string() } },
      tool(async (a: { board?: string; js: string }) => {
        const me = actor();
        return svc.eval!(svc.board(a.board), { id: me.id, name: me.name }, a.js);
      }),
    );
  }
  return server;
}
