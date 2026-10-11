import { resolve } from 'node:path';
import { BridgeService } from './service';

// canvas bridge: a Node process that owns one .canvas file and hosts its live document.
//  - Browsers join over WebSocket (the y-websocket protocol): ?bridge=ws://localhost:5222
//  - Agents and tools call the HTTP API (bridge/cli.ts, bridge/mcp.ts) and appear as players.
//  - The file is the durable record: doc changes are written back (canonical text, clean git diffs);
//    edits to the file (editor, git checkout, a script) flow into the open browsers.
//  - <dir>/.canvas-bridge/<name>.ystate keeps the Yjs history across restarts (so open tabs and
//    the restarted bridge agree on identity); delete it any time, the file wins.
// The per-file logic is bridge/board.ts; bridge/service.ts hosts many files (the desktop app uses it).
//
// Usage: tsx bridge/server.ts <file.canvas> [--port 5222]

const args = process.argv.slice(2);
const file = resolve(args.find((a) => !a.startsWith('--')) ?? 'board.canvas');
const port = Number(args[args.indexOf('--port') + 1]) || Number(process.env.CANVAS_BRIDGE_PORT) || 5222;
const log = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);

const service = new BridgeService({ port, cors: true, log });
service.open(file);
await service.listen();
log(`canvas bridge: ${file} on http://localhost:${port} (browsers: ?bridge=ws://localhost:${port})`);

const stop = () => {
  service.closeAll();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
