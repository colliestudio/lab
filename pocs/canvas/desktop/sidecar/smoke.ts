import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';

// Smoke test of the app's MCP endpoint through the stdio shim, as Claude Code would use it:
//   npx tsx desktop/sidecar/smoke.ts desktop/build/Canvas.app/Contents/MacOS/canvas-bridge [board] [out.png]
const [shim, board, out = '/tmp/canvas-smoke.png'] = process.argv.slice(2);
const t0 = Date.now();
const client = new Client({ name: 'smoke', version: '1' });
await client.connect(new StdioClientTransport({ command: shim, args: ['mcp'], env: { ...process.env, CANVAS_AS: 'Smoke' } as Record<string, string> }));
console.log(`connected in ${Date.now() - t0} ms`);
const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
const text = (r: any) => r.content.find((c: any) => c.type === 'text')?.text;
console.log('list_canvases:', text(await client.callTool({ name: 'list_canvases', arguments: {} })));
const add = await client.callTool({ name: 'canvas_add_node', arguments: { board, text: 'Smoke test was here', color: '3' } });
console.log('add:', text(add));
const t1 = Date.now();
const shot: any = await client.callTool({ name: 'canvas_screenshot', arguments: { board, labels: true } });
const img = shot.content.find((c: any) => c.type === 'image');
if (img) writeFileSync(out, Buffer.from(img.data, 'base64'));
console.log(`screenshot: ${Date.now() - t1} ms round trip`, text(shot), img ? `→ ${out}` : '(no image)');
await client.close();
