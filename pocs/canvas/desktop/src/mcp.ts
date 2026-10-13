import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { BoardFile } from '../../bridge/board';
import type { Client } from '../../bridge/client';
import { makeActor, type Actor } from '../../bridge/host';
import { queryNodes, resolveNode } from '../../bridge/query';
import type { BridgeService } from '../../bridge/service';
import { fail, registerCanvasTools, tool } from '../../bridge/tools';
import type { AgentViews, ShotTarget } from './views';

// The app's single MCP endpoint (streamable HTTP at /mcp on the embedded bridge's port). Each MCP
// session = one agent seat: its own name (x-canvas-as header, else the client's name), color, cursor,
// undo, log entries and a hidden view window per board for screenshots. Tools take `board`.

export interface Desktop {
  service: BridgeService;
  views: AgentViews;
  /** Open (or focus) a board's window; returns the board. */
  openBoard(file: string, opts?: { window?: boolean }): Promise<BoardFile>;
  recent(): string[];
}

interface Session {
  transport: StreamableHTTPServerTransport;
  actor: Actor;
  client: string;
  started: number;
  last: number;
}

/** A session with no request for this long is closed (a client that died without saying bye). */
const SESSION_IDLE_MS = 30 * 60_000;

/** A board's client acting as `actor`, in-process (same interface the CLI uses over HTTP). */
export function localClient(b: BoardFile, actor: Actor): Client {
  const store = b.host.store;
  return {
    doc: async () => store.exportDoc(),
    query: async (q) => queryNodes(store.doc, q),
    cmd: async (name, args) => b.cmd(actor, name, args),
    undo: async (redo = false) => b.undo(actor, redo),
    log: async (limit = 20) => b.logEntries(limit),
    status: async () => b.status(),
    view: async (name, args = {}) => b.view(actor, name, args) as any,
    wait: async (name, args = {}, timeoutS = 50) => ((await b.wait(actor, name, args, timeoutS * 1000)) ?? { waiting: true }) as any,
    say: async (text, node) => b.say(actor, text, node),
    chatRead: async (o = {}) => b.readChat(actor, o),
    chatWait: async (timeoutS = 50) => (await b.waitChat(actor, timeoutS * 1000)) ?? [],
    resolve: async (ref) => resolveNode(store.doc, ref).id,
  };
}

const NAMES: Record<string, string> = { 'claude-code': 'Claude', claude: 'Claude', 'codex-mcp-client': 'Codex', codex: 'Codex', cursor: 'Cursor', 'gemini-cli': 'Gemini' };

export class McpEndpoint {
  readonly sessions = new Map<string, Session>();

  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(private d: Desktop) {
    this.sweepTimer = setInterval(() => {
      for (const s of this.sessions.values()) if (Date.now() - s.last > SESSION_IDLE_MS) void s.transport.close();
    }, 60_000);
  }

  /** Name for a new seat: unique among live sessions ("Claude", "Claude 2", …). */
  private seatName(req: IncomingMessage, body: any): string {
    const asked = (req.headers['x-canvas-as'] as string | undefined)?.trim();
    const clientName = String(body?.params?.clientInfo?.name ?? '');
    const base = (asked || NAMES[clientName.toLowerCase()] || clientName || 'Agent').slice(0, 28);
    const taken = new Set([...this.sessions.values()].map((s) => s.actor.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
    return name;
  }

  handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== '/mcp') return false;
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let body: unknown;
    if (req.method === 'POST') {
      let s = '';
      for await (const chunk of req) s += chunk;
      try {
        body = s ? JSON.parse(s) : undefined;
      } catch {
        res.writeHead(400).end('bad json\n');
        return true;
      }
    }
    const known = sid ? this.sessions.get(sid) : undefined;
    if (known) {
      known.last = Date.now();
      await known.transport.handleRequest(req, res, body);
      return true;
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      res.writeHead(sid ? 404 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sid ? 'unknown session (the app restarted?): reconnect' : 'initialize first' }, id: null }));
      return true;
    }
    const name = this.seatName(req, body);
    const actor = makeActor(name); // names are unique among live sessions: one seat each
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, actor, client: String((body as any).params?.clientInfo?.name ?? ''), started: Date.now(), last: Date.now() });
        this.d.service.log(`mcp: ${actor.name} joined (session ${id.slice(0, 8)}, client ${(body as any).params?.clientInfo?.name})`);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && this.sessions.delete(id)) {
        this.d.views.dropActor(actor.id);
        this.d.service.log(`mcp: ${actor.name} left`);
      }
    };
    const server = this.server(actor);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return true;
  };

  private server(actor: Actor): McpServer {
    const { service, views } = this.d;
    const server = new McpServer({ name: 'collie-canvas', version: '0.1.0' }, { instructions: `You are seated at the table as "${actor.name}". Boards are .canvas files open in the Collie Canvas app. list_canvases, then pass board (the chess_* and chat_* tools: canvas) to pick the file when several are open. canvas_list for facts and ids; canvas_screenshot to see layout and rendered content.` });

    server.registerTool(
      'list_canvases',
      { description: 'Boards open in the Collie Canvas app (id, file, counts, who is seated) and recently opened files.', inputSchema: {} },
      tool(async () => ({
        you: actor.name,
        open: [...service.boards.values()].map((b) => ({ ...b.status(), name: b.name })),
        recent: this.d.recent(),
      })),
    );

    server.registerTool(
      'open_canvas',
      {
        description: 'Open a .canvas file in the Collie Canvas app (creates it when missing) and return its board id. Opens a window for the people at the desk unless window=false.',
        inputSchema: { path: z.string().describe('absolute path to a .canvas file'), window: z.boolean().optional() },
      },
      tool(async (a: { path: string; window?: boolean }) => {
        if (!a.path.endsWith('.canvas')) throw new Error('path must end in .canvas');
        const b = await this.d.openBoard(a.path, { window: a.window !== false });
        return { board: b.id, file: b.file, nodes: b.host.store.nodes.size };
      }),
    );

    registerCanvasTools(server, (board) => localClient(service.find(board), actor), true);

    server.registerTool(
      'canvas_screenshot',
      {
        description:
          'See the board as rendered (PNG/JPEG), through your own hidden view of it: plugin-rendered content, live embedded pages, layout. target: "board" (everything, default), "viewport" (your camera as it was left), or a node id/title (zoom to that node or frame/column). ~1k tokens per 1000x750 image. Use canvas_list for exact text and ids.',
        inputSchema: {
          board: z.string().optional(),
          target: z.string().optional().describe('"board" | "viewport" | node id or title'),
          width: z.number().int().min(200).max(2400).optional().describe('px, default 1200'),
          height: z.number().int().min(150).max(1800).optional().describe('px, default 800'),
          padding: z.number().optional().describe('px around the target, default 40'),
          format: z.enum(['png', 'jpeg']).optional().describe('default png'),
          hidpi: z.boolean().optional().describe('device pixels (2x on Retina) instead of width x height'),
        },
      },
      async (a: { board?: string; target?: string; width?: number; height?: number; padding?: number; format?: 'png' | 'jpeg'; hidpi?: boolean }) => {
        try {
          const b = service.find(a.board);
          const t = a.target ?? 'board';
          const target: ShotTarget = t === 'board' || t === 'viewport' ? { kind: t } : { kind: 'node', id: resolveNode(b.host.store.doc, t).id };
          const shot = await views.screenshot(b, actor, target, { width: a.width, height: a.height, padding: a.padding, format: a.format, hidpi: a.hidpi });
          return {
            content: [
              { type: 'image' as const, data: shot.data.toString('base64'), mimeType: shot.mime },
              { type: 'text' as const, text: `${b.name} ${t} ${shot.width}x${shot.height} in ${shot.ms} ms${shot.frames ? `, ${shot.frames} embedded page(s)` : ''}` },
            ],
          };
        } catch (e) {
          return fail(e);
        }
      },
    );

    return server;
  }

  closeAll() {
    clearInterval(this.sweepTimer);
    for (const s of this.sessions.values()) void s.transport.close();
    this.sessions.clear();
  }
}
