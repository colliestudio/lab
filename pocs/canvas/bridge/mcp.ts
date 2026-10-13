import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { client } from './client';
import { registerCanvasTools } from './tools';

// MCP server: the same operations as the CLI, as tools, so a Claude agent can read the board and
// add/move/link nodes live while people watch (it is seated as a player: cursor, log name, undo).
//   claude mcp add canvas -e CANVAS_AS=Claude -- pnpm --dir <repo> -s canvas-mcp
// Talks to the bridge at $CANVAS_BRIDGE (default http://localhost:5222). Tools: bridge/tools.ts.

const c = client({ as: process.env.CANVAS_AS ?? 'Claude' });
const server = new McpServer({ name: 'canvas', version: '0.1.0' });
registerCanvasTools(server, () => c);
await server.connect(new StdioServerTransport());
