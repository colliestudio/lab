import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { catalog } from './catalog';
import { client } from './client';
import { toContent, toolList } from './tools';

// MCP server: the same operations as the CLI, as tools, so a Claude agent can read the board and
// add/move/link nodes live while people watch (it is seated as a player: cursor, log name, undo).
//   claude mcp add canvas -e CANVAS_AS=Claude -- pnpm --dir <repo> -s canvas-mcp
// Talks to the bridge at $CANVAS_BRIDGE (default http://localhost:5222). The tools are generated
// from what plugins describe (tools.ts): four generic ones plus the established named ones.

const c = client({ as: process.env.CANVAS_AS ?? 'Claude' });
const tools = toolList(catalog());
const server = new Server({ name: 'canvas', version: '0.2.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as { type: 'object' } })) }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) return { isError: true, content: [{ type: 'text' as const, text: `unknown tool ${req.params.name}; canvas_help lists what can be done` }] };
  try {
    return { content: toContent(await tool.call(c, (req.params.arguments ?? {}) as Record<string, any>)) };
  } catch (e) {
    return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
  }
});

await server.connect(new StdioServerTransport());
