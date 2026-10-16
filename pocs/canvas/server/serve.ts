import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BoardDirectory } from './core/directory';
import { parseServeArgs } from './serve-args';
import { FolderStorage } from './node/folder';
import { makeGuard } from './node/guard';
import { createNodeServer } from './node/http';

// canvas serve: one process that serves every .canvas file in a folder.
//  - Browsers: ws://HOST:PORT/ws/<board> (the app: ?bridge=ws://HOST:PORT/ws/<board>)
//  - Agents and tools: http://HOST:PORT/api/boards/<board>/... (CANVAS_BRIDGE=that URL works for the CLI and MCP)
//  - GET /api/boards lists the folder; POST /api/boards {name}, /api/boards/<name>/rename {to} and
//    /delete (to the trash folder) change it
//  - A board loads when first used and unloads when nobody has it open (--idle-ms). Each board's file
//    stays the durable record, as with the bridge.
//
// Usage: tsx server/serve.ts <dir> [--port 5231] [--host 127.0.0.1] [--allow-origin URL]… [--idle-ms N]
//  Binds 127.0.0.1 by default. A browser app on another origin must be listed: --allow-origin http://mini.internal:5215
//  (or $CANVAS_ALLOW_ORIGIN, comma separated); see node/guard.ts.

const DEFAULT_PORT = 5231;

function fail(msg: string, code = 2): never {
  console.error(`canvas serve: ${msg}`);
  return process.exit(code);
}

let args: ReturnType<typeof parseServeArgs>;
try {
  args = parseServeArgs(process.argv.slice(2));
} catch (e) {
  fail(`${(e as Error).message}\nusage: tsx server/serve.ts <dir> [--port N] [--host H] [--allow-origin URL]… [--idle-ms N]`);
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
const guard = makeGuard({ port, allowOrigins: [...args.allowOrigins, ...(process.env.CANVAS_ALLOW_ORIGIN?.split(',') ?? [])] });
const storage = new FolderStorage(dir);
const directory = new BoardDirectory(storage, { idleMs: args.idleMs, sweepMs: Math.min(10_000, Math.max(50, (args.idleMs ?? 600_000) / 2)), log });
const server = createNodeServer({ directory, guard, log });

try {
  await server.listen(port, host);
} catch (e) {
  fail(`cannot listen on ${host}:${port}: ${(e as Error).message}`, 1);
}
const boards = await directory.list();
log(`canvas serve: ${storage.dir} on http://${host}:${port} (${boards.length} board${boards.length === 1 ? '' : 's'}; browsers: ?bridge=ws://${host}:${port}/ws/<board>; app origins allowed: ${guard.origins.join(', ')})`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    // stop taking connections first: a tab redialing after its board closed would reload it and
    // land its unsaved edits in a board that is about to be dropped
    await server.close();
    await directory.closeAll();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
