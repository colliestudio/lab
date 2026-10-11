// Drive the running app's MCP endpoint through the stdio shim, like Claude Code would.
//   node scripts/mcp-smoke.mjs <out-dir> [board.canvas] [iframe-url]
// Needs the app running (or starts it via the shim). Writes screenshots to <out-dir>.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const [out = '/tmp', file, frameUrl = 'http://127.0.0.1:5252/'] = process.argv.slice(2);
const exe = process.env.CANVAS_EXE ?? createRequire(import.meta.url)('electron');
const shim = process.env.CANVAS_SHIM ?? join(here, '../build/shim.mjs');
const transport = new StdioClientTransport({ command: exe, args: [shim], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CANVAS_AS: process.env.CANVAS_AS ?? 'Claude' }, stderr: 'inherit' });
const c = new Client({ name: 'claude-code', version: '0' });
const t = (ms) => `${Math.round(ms)} ms`;
let t0 = performance.now();
await c.connect(transport);
console.log('connected via shim in', t(performance.now() - t0));
const { tools } = await c.listTools();
console.log('tools:', tools.map((x) => x.name).join(', '));
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return r;
};
process.on('unhandledRejection', (e) => (console.error(e.message), process.exit(1)));
const text = (r) => r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
console.log(text(await call('list_canvases')));
let board;
if (file) board = JSON.parse(text(await call('open_canvas', { path: file }))).board;
await call('canvas_add_node', { board, text: '# Order placed\nfrom the MCP smoke test', color: '4' });
await call('canvas_add_node', { board, text: 'Payment taken', near: 'Order placed', color: '5' });
await call('canvas_connect', { board, from: 'Order placed', to: 'Payment taken', label: 'then' });
await call('canvas_add_node', { board, type: 'link', text: '', url: frameUrl, embed: true, x: 400, y: 0, width: 420, height: 300 });
for (const target of ['board', 'Payment taken', 'board']) {
  t0 = performance.now();
  const r = await call('canvas_screenshot', { board, target });
  const img = r.content.find((x) => x.type === 'image');
  const name = `shot-${target.replace(/\W+/g, '-')}-${Date.now()}.png`;
  writeFileSync(join(out, name), Buffer.from(img.data, 'base64'));
  console.log(`screenshot ${target}: ${t(performance.now() - t0)} round trip; ${text(r)} → ${name}`);
}
console.log(text(await call('canvas_log', { board, limit: 6 })));
await c.close();
process.exit(0);
