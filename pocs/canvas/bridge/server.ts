import { resolve } from 'node:path';
import { BridgeService } from './service';
import { parseBridgeArgs } from './args';

// canvas bridge: a Node process that owns one .canvas file and hosts its live document.
//  - Browsers join over WebSocket (the y-websocket protocol): ?bridge=ws://localhost:5222
//  - Agents and tools call the HTTP API (bridge/cli.ts, bridge/mcp.ts) and appear as players.
//  - The file is the durable record: doc changes are written back (canonical text, clean git diffs);
//    edits to the file (editor, git checkout, a script) flow into the open browsers.
//  - <dir>/.canvas-bridge/<name>.ystate keeps the Yjs history across restarts (so open tabs and
//    the restarted bridge agree on identity); delete it any time, the file wins.
// The per-file logic is bridge/board.ts; bridge/service.ts hosts many files (the desktop app uses it).
//
// Usage: tsx bridge/server.ts <file.canvas> [--port 5222] [--host 127.0.0.1] [--allow-origin URL]…
//  Binds 127.0.0.1 by default. A browser app on another origin (the vite dev server) must be listed:
//  --allow-origin http://mini.internal:5284 (or $CANVAS_ALLOW_ORIGIN, comma separated); see guard.ts.

let opts: ReturnType<typeof parseBridgeArgs>;
try {
  opts = parseBridgeArgs(process.argv.slice(2));
} catch (e) {
  console.error(`canvas bridge: ${(e as Error).message}\nusage: tsx bridge/server.ts <file.canvas> [--port N] [--host H] [--allow-origin URL]…`);
  process.exit(2);
}
const file = resolve(opts.file);
const port = opts.port ?? (Number(process.env.CANVAS_BRIDGE_PORT) || 5222);
const bindHost = opts.host ?? '127.0.0.1';
const log = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);

const service = new BridgeService({ port, host: bindHost, allowOrigins: [...opts.allowOrigins, ...(process.env.CANVAS_ALLOW_ORIGIN?.split(',') ?? [])], log });
service.open(file);
await service.listen();
log(`canvas bridge: ${file} on http://${bindHost}:${port} (browsers: ?bridge=ws://${bindHost}:${port}; app origins allowed: ${service.guard.origins.join(', ')})`);

const stop = () => {
  service.closeAll();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
