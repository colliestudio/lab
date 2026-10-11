import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Client } from './client';

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
 * Register canvas_list/add_node/update_node/connect/remove/undo/log. `clientFor(board)` gives the
 * board's client acting as this agent; with `multiBoard`, each tool takes an optional `board`
 * (id, file path or file name; may be left out when only one board is open).
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
}
