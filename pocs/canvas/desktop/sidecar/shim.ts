import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// `canvas-bridge mcp`: a stdio MCP server that relays to the running Canvas app's single MCP
// endpoint (streamable HTTP; URL + token from <home>/endpoint.json). Starts the app (in the
// background) if it isn't running. $CANVAS_AS names the seat (default: the client's name).
//   claude mcp add canvas -- /Applications/Canvas.app/Contents/MacOS/canvas-bridge mcp

const HOME = process.env.CANVAS_HOME ?? join(homedir(), 'Library', 'Application Support', 'Canvas');
const EP = join(HOME, 'endpoint.json');

async function endpoint(): Promise<{ mcp: string; pid: number }> {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const read = () => (existsSync(EP) ? JSON.parse(readFileSync(EP, 'utf8')) : undefined);
  let ep = read();
  if (ep && alive(ep.pid)) return ep;
  try {
    execFileSync('open', ['-g', '-b', process.env.CANVAS_BUNDLE_ID ?? 'studio.collie.canvas']);
  } catch {
    throw new Error('Canvas app is not running and could not be started');
  }
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    ep = read();
    if (ep && alive(ep.pid)) return ep;
  }
  throw new Error('Canvas app did not start its service within 10 s');
}

export async function runShim() {
  const ep = await endpoint();
  const headers: Record<string, string> = {};
  if (process.env.CANVAS_AS) headers['x-canvas-as'] = process.env.CANVAS_AS;
  const up = new StreamableHTTPClientTransport(new URL(ep.mcp), { requestInit: { headers } });
  const down = new StdioServerTransport();
  down.onmessage = (m) => void up.send(m).catch((e) => console.error('canvas mcp:', e.message));
  up.onmessage = (m) => void down.send(m);
  up.onerror = (e) => console.error('canvas mcp (app):', e.message);
  down.onclose = () => void up.close().then(() => process.exit(0));
  up.onclose = () => process.exit(0);
  await up.start();
  await down.start();
}
