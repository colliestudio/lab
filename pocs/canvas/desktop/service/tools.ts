import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { client } from '../../bridge/client';

// The app's MCP tools: the agent-bridge's tools plus a `board` argument, list/open, and a screenshot.
// They talk to the service's HTTP API at `base` (in process for /mcp, over loopback for the stdio
// shim), so both transports run the same code. `as` = the agent's seat name (cursor, log, undo).

interface Summary {
  id: string;
  name: string;
  file: string;
  nodes: number;
}

export function canvasTools(server: McpServer, base: () => string, as: () => string) {
  const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] });
  const tool =
    <T,>(fn: (a: T) => Promise<unknown>) =>
    async (a: T) => {
      try {
        const r = await fn(a);
        return r && typeof r === 'object' && 'content' in (r as object) ? (r as ReturnType<typeof ok>) : ok(r);
      } catch (e) {
        return fail(e);
      }
    };
  const http = async (path: string, body?: unknown) => {
    let res: Response;
    try {
      res = await fetch(base() + path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    } catch {
      throw new Error(`can't reach the Canvas app at ${base()} (is it running?)`);
    }
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    return j;
  };
  const boards = (): Promise<Summary[]> => http('/canvases');
  /** Board by id, path, or file name (unique substring); optional when exactly one is open. */
  const board = async (ref?: string): Promise<Summary> => {
    const all = await boards();
    if (!ref) {
      if (all.length === 1) return all[0];
      throw new Error(all.length ? `several canvases are open; pass board (one of: ${all.map((b) => `${b.id} ${b.name}`).join(', ')})` : 'no canvas is open; call open_canvas with a file path');
    }
    const hit = all.find((b) => b.id === ref || b.file === ref) ?? (() => {
      const m = all.filter((b) => b.name.toLowerCase().includes(ref.toLowerCase()) || b.file.toLowerCase().includes(ref.toLowerCase()));
      return m.length === 1 ? m[0] : undefined;
    })();
    if (!hit) throw new Error(`no open canvas matches "${ref}" (open: ${all.map((b) => `${b.id} ${b.name}`).join(', ') || 'none'})`);
    return hit;
  };
  const bc = async (ref?: string) => {
    const b = await board(ref);
    return { b, c: client({ url: `${base()}/b/${b.id}`, as: as() }) };
  };
  const cmd = async (ref: string | undefined, name: string, args: (c: ReturnType<typeof client>) => Promise<unknown>) => {
    const { c } = await bc(ref);
    const r = await c.cmd(name, await args(c));
    if (!r.ok) throw new Error(r.error ?? 'failed');
    return r;
  };
  const boardArg = z.string().optional().describe('canvas id, file path or file name (from list_canvases); optional when one canvas is open');
  const ref = z.string().describe('node id, or its title (a unique prefix/substring is enough)');

  server.registerTool('list_canvases', { description: 'Canvases open in the Canvas app (id, file, node count). Pass the id as `board` to the other tools.', inputSchema: {} }, tool(async () => boards()));

  server.registerTool(
    'open_canvas',
    {
      description: 'Open a .canvas file in the app (created if missing). show=true also opens a window for the people at the desk.',
      inputSchema: { file: z.string().describe('absolute path to a .canvas file'), show: z.boolean().optional() },
    },
    tool(async (a: { file: string; show?: boolean }) => http('/canvases', a)),
  );

  server.registerTool(
    'canvas_list',
    {
      description: 'List nodes on a canvas as JSON (id, type, text, position, column, links): exact facts and ids for edits. For layout and how it looks, use canvas_screenshot.',
      inputSchema: { board: boardArg, type: z.string().optional(), text: z.string().optional(), column: z.string().optional(), ext: z.string().optional() },
    },
    tool(async ({ board: b, ...q }: { board?: string } & Record<string, string | undefined>) => (await bc(b)).c.query(q)),
  );

  server.registerTool(
    'canvas_add_node',
    {
      description: 'Add a note (or a link/column). Without x/y it goes in `column`, below `near`, or right of everything. Returns the new id.',
      inputSchema: {
        board: boardArg,
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
    tool(async ({ board: b, ...a }: { board?: string; text: string; type?: string; url?: string; column?: string; near?: string; x?: number; y?: number; color?: string }) => {
      const r = await cmd(b, 'board.add', async (c) => ({
        ...a,
        label: a.type === 'group' ? a.text : undefined,
        column: a.column && (await c.resolve(a.column)),
        near: a.near && (await c.resolve(a.near)),
      }));
      return { id: r.select?.[0] };
    }),
  );

  server.registerTool(
    'canvas_update_node',
    {
      description: 'Edit or move a node: new text/label/color, absolute x/y, relative dx/dy, or into a column.',
      inputSchema: { board: boardArg, node: ref, text: z.string().optional(), label: z.string().optional(), color: z.string().nullable().optional(), x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional(), column: ref.optional() },
    },
    tool(async ({ board: b, node, column, ...a }: { board?: string; node: string; column?: string } & Record<string, unknown>) => {
      let id = '';
      await cmd(b, 'board.update', async (c) => ({ id: (id = await c.resolve(node)), ...a, column: column && (await c.resolve(column)) }));
      return { id };
    }),
  );

  server.registerTool(
    'canvas_connect',
    { description: 'Draw an arrow from one node to another (optional label).', inputSchema: { board: boardArg, from: ref, to: ref, label: z.string().optional() } },
    tool(async ({ board: b, ...a }: { board?: string; from: string; to: string; label?: string }) => cmd(b, 'board.connect', async (c) => ({ from: await c.resolve(a.from), to: await c.resolve(a.to), label: a.label }))),
  );

  server.registerTool(
    'canvas_remove',
    { description: 'Remove nodes (their links go too).', inputSchema: { board: boardArg, nodes: z.array(ref) } },
    tool(async ({ board: b, nodes }: { board?: string; nodes: string[] }) => cmd(b, 'board.remove', async (c) => ({ ids: await Promise.all(nodes.map((n) => c.resolve(n))) }))),
  );

  server.registerTool(
    'canvas_undo',
    { description: 'Undo (or redo) your own last step on a canvas.', inputSchema: { board: boardArg, redo: z.boolean().optional() } },
    tool(async ({ board: b, redo }: { board?: string; redo?: boolean }) => {
      const r = await (await bc(b)).c.undo(!!redo);
      if (!r.ok) throw new Error(r.error);
      return 'done';
    }),
  );

  server.registerTool(
    'canvas_log',
    { description: 'Recent events on a canvas: who did what (people, agents, the file, tools).', inputSchema: { board: boardArg, limit: z.number().optional() } },
    tool(async ({ board: b, limit }: { board?: string; limit?: number }) => (await (await bc(b)).c.log(limit ?? 20)).map((e) => `${e.time.slice(11, 19)} ${e.actor ?? '—'} ${e.text}`).join('\n')),
  );

  server.registerTool(
    'canvas_screenshot',
    {
      description:
        'See the canvas as rendered (incl. embedded pages and plugin views): a PNG from your own hidden view of the board (your camera; people’s views are not moved). Default: fit the whole board. Use for layout and visual checks; use canvas_list for exact text and ids.',
      inputSchema: {
        board: boardArg,
        nodes: z.array(ref).optional().describe('frame these nodes'),
        x: z.number().optional().describe('camera: world x at the left edge (with y, zoom)'),
        y: z.number().optional(),
        zoom: z.number().optional(),
        width: z.number().optional().describe('view size in CSS px (default 1000)'),
        height: z.number().optional().describe('default 750'),
      },
    },
    tool(async ({ board: b, nodes, ...a }: { board?: string; nodes?: string[]; x?: number; y?: number; zoom?: number; width?: number; height?: number }) => {
      const { b: bd, c } = await bc(b);
      const ids = nodes && (await Promise.all(nodes.map((n) => c.resolve(n))));
      const r = await http(`/b/${bd.id}/screenshot`, { as: as(), nodes: ids, ...a });
      return { content: [{ type: 'image' as const, data: r.png as string, mimeType: 'image/png' }, { type: 'text' as const, text: `${bd.name}: ${r.width}×${r.height}px, ${r.ms} ms` }] };
    }),
  );
}
