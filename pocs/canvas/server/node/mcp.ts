import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { catalog, type Catalog } from '../../bridge/catalog';
import { sessionTools } from '../mcp/tools';
import type { McpService, McpSession } from '../mcp/session';
import type { Log } from '../core/transport';

// /mcp on the node server: MCP over streamable HTTP, one SDK Server + transport per session
// (server/mcp/session.ts holds what a session has joined). The request has passed the guard (Host,
// Origin, content type) before it gets here; the SDK's own DNS-rebinding check is left off for that reason.

const MAX_BODY = 4 * 1024 * 1024;

class TooBig extends Error {}

const rpcError = (res: ServerResponse, status: number, code: number, message: string) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
};

async function readBody(req: IncomingMessage): Promise<string> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    n += chunk.length;
    if (n > MAX_BODY) throw new TooBig();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function mcpHandler(service: McpService, log: Log = () => {}, cat: Catalog = catalog()) {
  const live = new Map<string, StreamableHTTPServerTransport>();

  function connect(id: string, session: McpSession) {
    const tools = sessionTools(cat, session);
    const server = new Server({ name: 'canvas', version: '0.3.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as { type: 'object' } })) }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const tool = tools.find((t) => t.name === req.params.name);
      if (!tool) return { isError: true, content: [{ type: 'text' as const, text: `unknown tool ${req.params.name}; canvas_help lists what can be done` }] };
      try {
        return { content: [{ type: 'text' as const, text: await tool.call((req.params.arguments ?? {}) as Record<string, any>, { signal: extra.signal }) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
    live.set(id, transport);
    server.onclose = () => {
      live.delete(id);
      session.close();
    };
    session.onClose = () => void server.close().catch(() => {});
    return server.connect(transport).then(() => transport);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const method = req.method ?? 'GET';
      if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') return rpcError(res, 405, -32000, 'Method not allowed');
      let body: unknown;
      if (method === 'POST') {
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          if (e instanceof TooBig) return rpcError(res, 413, -32600, 'request too large');
          return rpcError(res, 400, -32700, 'Parse error');
        }
      }
      const given = req.headers['mcp-session-id'];
      const sid = Array.isArray(given) ? given[0] : given;
      let transport: StreamableHTTPServerTransport | undefined;
      let session: McpSession | undefined;
      if (sid) {
        session = service.get(sid);
        transport = live.get(sid);
        if (!session || !transport) return rpcError(res, 404, -32001, 'Session not found: connect again (joins of the old session are gone)');
      } else if (method === 'POST' && (Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body))) {
        const id = randomUUID();
        try {
          session = service.create(id);
        } catch (e) {
          return rpcError(res, 503, -32000, (e as Error).message);
        }
        transport = await connect(id, session);
        log(`mcp: session ${id.slice(0, 8)} started`);
      } else {
        return rpcError(res, 400, -32000, 'Bad Request: no session (start with an initialize request)');
      }
      // in flight until the response (or a GET stream) ends: such a session is not idle
      const s = session;
      s.open++;
      s.touch();
      res.on('close', () => {
        s.open--;
        s.touch();
      });
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log(`mcp: ${(e as Error).message}`);
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error');
      else res.end();
    }
  }

  return { handle };
}
