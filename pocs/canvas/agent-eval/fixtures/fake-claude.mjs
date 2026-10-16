#!/usr/bin/env node
// Stand-in for `claude` in the session tests: speaks enough stream-json for the harness.
// FAKE_HANG=1: never finishes. FAKE_TOOLS=Bash: a foreign tool in init. FAKE_PIDFILE: where to write pids.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('0.0.0 (fake)');
  process.exit(0);
}
const cfg = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8'));
const bridge = cfg.mcpServers.canvas.env.CANVAS_BRIDGE;
const out = (o) => console.log(JSON.stringify(o));

// a grandchild, like the MCP server claude starts
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, JSON.stringify({ claude: process.pid, child: child.pid }));

out({ type: 'system', subtype: 'init', model: 'fake-model', tools: ['mcp__canvas__canvas_do', ...(process.env.FAKE_TOOLS ? process.env.FAKE_TOOLS.split(',') : [])], mcp_servers: [{ name: 'canvas', status: 'connected' }], plugins: [], skills: [], slash_commands: [] });
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else {
  const r = await fetch(bridge + '/agent/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as: 'Agent', name: 'board.add', args: { text: 'Fake note' } }) });
  const text = await r.text();
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
  out({ type: 'assistant', message: { id: 'm1', usage, content: [{ type: 'tool_use', id: 't1', name: 'mcp__canvas__canvas_do', input: { command: 'board.add' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: !r.ok, content: text }] } });
  out({ type: 'assistant', message: { id: 'm2', usage, content: [{ type: 'text', text: 'Done.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 50, num_turns: 2, total_cost_usd: 0.01, usage, permission_denials: [] });
  child.kill();
}
