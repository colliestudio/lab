import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

// `canvas mcp`: a stdio MCP server that connects to the running Canvas app's single endpoint and
// relays messages both ways. Lets Claude Code register one stable command while the app picks a
// random port each launch. Runs on the app's own binary in Node mode:
//   ELECTRON_RUN_AS_NODE=1 /Applications/Canvas.app/Contents/MacOS/Canvas …/shim.mjs
// Starts the app (hidden, no dialog) when it isn't running. CANVAS_AS names this agent's seat.

const userData = process.env.CANVAS_USER_DATA ?? join(homedir(), 'Library', 'Application Support', 'Canvas Electron');
const endpointFile = join(userData, 'endpoint.json');
const err = (m: string) => process.stderr.write(`canvas mcp: ${m}\n`);

function endpoint(): { port: number; pid: number; mcp: string } | undefined {
  try {
    const e = JSON.parse(readFileSync(endpointFile, 'utf8'));
    process.kill(e.pid, 0); // still running?
    return e;
  } catch {
    return undefined;
  }
}

async function findOrStart() {
  let e = endpoint();
  if (e) return e;
  // the shim runs on the app binary (ELECTRON_RUN_AS_NODE): start that binary as the app
  if (process.versions.electron && existsSync(process.execPath)) {
    err('starting the Canvas app');
    const env: NodeJS.ProcessEnv = { ...process.env, CANVAS_NO_DIALOG: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    // packaged: the binary is the app; dev: the binary is plain Electron, pass the app dir (build/..)
    const here = dirname(fileURLToPath(import.meta.url));
    const args = here.includes('app.asar') ? [] : [join(here, '..')];
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', env }).unref();
    for (let i = 0; i < 100 && !(e = endpoint()); i++) await new Promise((r) => setTimeout(r, 100));
  }
  if (!e) throw new Error(`the Canvas app isn't running (no ${endpointFile})`);
  return e;
}

const e = await findOrStart();
const headers: Record<string, string> = {};
if (process.env.CANVAS_AS) headers['x-canvas-as'] = process.env.CANVAS_AS;
const upstream = new StreamableHTTPClientTransport(new URL(e.mcp), { requestInit: { headers } });
const local = new StdioServerTransport();
local.onmessage = (m: JSONRPCMessage) => void upstream.send(m).catch((x) => err(`send: ${(x as Error).message}`));
upstream.onmessage = (m: JSONRPCMessage) => void local.send(m);
upstream.onerror = (x) => err(`upstream: ${x.message}`);
upstream.onclose = () => process.exit(0);
// the agent went away: end the session so its seat and views go right away
const bye = () => void upstream.terminateSession().catch(() => {}).finally(() => upstream.close().finally(() => process.exit(0)));
local.onclose = bye;
process.stdin.on('end', bye);
await upstream.start();
await local.start();
