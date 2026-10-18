import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { root, startBridge, until, type TestBridge } from './process.test-util';

// The MCP server end to end: a real bridge on a scratch board file, the real `bridge/mcp.ts` over
// stdio, and the SDK's own client calling its tools.

let b: TestBridge;
let mcp: Client;
beforeAll(async () => {
  b = await startBridge();
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: `${root}/node_modules/.bin/tsx`, args: ['bridge/mcp.ts'], cwd: root, env: { ...env, CANVAS_BRIDGE: b.url, CANVAS_AS: 'Tester' } }));
}, 30000);
afterAll(async () => {
  await mcp?.close();
  b?.stop();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: (r.content as { text: string }[])[0].text };
};

describe('canvas MCP server', () => {
  it('lists the tools agents had plus the generic ones', async () => {
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['canvas_look', 'canvas_do', 'canvas_help', 'canvas_wait', 'canvas_add_node', 'chess_move', 'chess_wait_for_turn', 'chat_send', 'canvas_remove_arrow', 'canvas_draw_add']));
    expect(names).toHaveLength(32);
  });

  it('adds a note; the board file holds it', async () => {
    const r = await call('canvas_add_node', { text: 'Hello' });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).id).toEqual(expect.any(String));
    await until(() => readFileSync(b.file, 'utf8').includes('Hello'));
    expect((await call('canvas_look', { text: 'hello' })).text).toContain('Hello');
  });

  it('plays chess through the named tools', async () => {
    await call('chess_new_game');
    expect((await call('chess_sit', { color: 'white' })).text).toContain('you play white');
    const m = await call('chess_move', { move: 'e4' });
    expect(m.isError).toBe(false);
    expect(m.text).toContain('1. e4');
  });

  it('refuses bad arguments with the field and an example', async () => {
    const r = await call('canvas_do', { command: 'chess.move', args: {} });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('args.move');
    expect(r.text).toContain('Example: {"move":"Nf3"}');
    expect((await call('canvas_do', { command: 'chess.nope' })).text).toContain('chess has:');
  });

  it('canvas_do runs a command; canvas_look reads a view', async () => {
    expect((await call('canvas_do', { command: 'board.add', args: { text: 'Via do' } })).text).toContain('"id"');
    expect((await call('canvas_look', { view: 'chess.state' })).text).toContain('moves: 1. e4');
  });

  it('canvas_wait says it is still waiting', async () => {
    const r = await call('canvas_wait', { view: 'chess.turn', timeout_s: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('still waiting');
  });

  it('chat round trip', async () => {
    expect((await call('chat_send', { text: 'hi there', node: 'Hello' })).text).toBe('sent');
    expect((await call('chat_read')).text).toContain('Tester (agent): hi there  (re: Hello)');
  });

  it('canvas_help gives the board guide and the plugin list', async () => {
    expect((await call('canvas_help', { plugin: 'board' })).text).toContain('A column is a group node');
    expect((await call('canvas_help')).text).toContain('chess -');
  });
});
