import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardDirectory } from './core/directory';
import { parseServeArgs } from './serve-args';
import { FolderStorage } from './node/folder';
import { makeGuard } from './node/guard';
import { createNodeServer } from './node/http';
import { createStaticApp } from './node/static';
import { mcpHandler } from './node/mcp';
import { McpService } from './mcp/session';

// canvas serve: one process that serves every .canvas file in a folder.
//  - Browsers: http://HOST:PORT/ lists the boards, /b/<board> opens one (the built app, from --app, default the
//    repo's dist: run `pnpm build`); the live document is ws://HOST:PORT/ws/<board>
//  - Agents and tools: http://HOST:PORT/api/boards/<board>/... (CANVAS_BRIDGE=that URL works for the CLI and MCP)
//  - GET /api/boards lists the folder; POST /api/boards {name}, /api/boards/<name>/rename {to} and
//    /delete (to the trash folder) change it
//  - MCP agents: http://HOST:PORT/mcp (claude mcp add --transport http canvas <that URL>); a session joins boards
//    with canvas_join and its tools then act there (server/mcp/)
//  - A board loads when first used and unloads when nobody has it open (--idle-ms). Each board's file
//    stays the durable record, as with the bridge.
//
// Usage: tsx server/serve.ts <dir> [--port 5231] [--host 127.0.0.1] [--allow-origin URL]… [--host-name NAME]… [--idle-ms N] [--mcp-idle-ms N] [--app DIR]
//  Binds 127.0.0.1 by default. Reached by another host name (http://mini.internal:5231) or serving a browser
//  app from another origin, it must be listed: --allow-origin http://mini.internal:5231
//  (or $CANVAS_ALLOW_ORIGIN, comma separated); see node/guard.ts. --host-name mini.internal is the short form for a
//  proxy that forwards http://mini.internal:PORT to this port: that name is trusted as Host and Origin on this port.

const DEFAULT_PORT = 5231;

function fail(msg: string, code = 2): never {
  console.error(`canvas serve: ${msg}`);
  return process.exit(code);
}

let args: ReturnType<typeof parseServeArgs>;
try {
  args = parseServeArgs(process.argv.slice(2));
} catch (e) {
  fail(`${(e as Error).message}\nusage: tsx server/serve.ts <dir> [--port N] [--host H] [--allow-origin URL]… [--host-name NAME]… [--idle-ms N] [--mcp-idle-ms N] [--app DIR]`);
}
const dir = resolve(args.dir);
try {
  if (!statSync(dir).isDirectory()) fail(`${dir} is not a folder`);
} catch (e) {
  fail(`${dir}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such folder' : (e as Error).message}`);
}

const port = args.port ?? (Number(process.env.CANVAS_SERVE_PORT) || DEFAULT_PORT);
const host = args.host ?? '127.0.0.1';
const log = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);
const hostOrigins = args.hostNames.map((n) => `http://${n}:${port}`);
const guard = makeGuard({ port, allowOrigins: [...args.allowOrigins, ...hostOrigins, ...(process.env.CANVAS_ALLOW_ORIGIN?.split(',') ?? [])] });
const storage = new FolderStorage(dir);
const directory = new BoardDirectory(storage, { idleMs: args.idleMs, sweepMs: Math.min(10_000, Math.max(50, (args.idleMs ?? 600_000) / 2)), log });
const appDir = resolve(args.app ?? fileURLToPath(new URL('../dist', import.meta.url)));
for (const f of ['index.html', 'home.html']) {
  if (!existsSync(join(appDir, f))) console.warn(`canvas serve: ${join(appDir, f)} is missing; the web app won't open until \`pnpm build\` has run (the API works)`);
}
const mcpService = new McpService(directory, { idleMs: args.mcpIdleMs });
mcpService.start();
const mcp = mcpHandler(mcpService, log);
const server = createNodeServer({ directory, guard, log, mcp, app: createStaticApp(appDir, guard) });

try {
  await server.listen(port, host);
} catch (e) {
  fail(`cannot listen on ${host}:${port}: ${(e as Error).message}`, 1);
}
const boards = await directory.list();
log(`canvas serve: ${storage.dir} on http://${host}:${port} (${boards.length} board${boards.length === 1 ? '' : 's'}; open http://${host}:${port}/; app origins allowed: ${guard.origins.join(', ')})`);
for (const o of hostOrigins) log(`open ${o}/`);
if (!args.allowOrigins.length && !hostOrigins.length && !process.env.CANVAS_ALLOW_ORIGIN) log(`from another host name (http://<host name>:${port}): start with --allow-origin http://<that name>:${port}`);
log(`agents: claude mcp add --transport http canvas http://${host}:${port}/mcp`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    // stop taking connections first: a tab redialing after its board closed would reload it and
    // land its unsaved edits in a board that is about to be dropped
    const closing = server.close();
    mcpService.closeAll(); // seats leave, leases are released (same tick: no session can join in between)
    await closing;
    await directory.closeAll();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
