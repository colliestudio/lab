import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardId } from '../../bridge/board';
import { makeActor } from '../../bridge/host';
import { BridgeService } from '../../bridge/service';
import { registerCanvasTools } from '../../bridge/tools';
import { localClient } from './mcp';

let dir: string;
let state: string;
let service: BridgeService;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cc-boards-'));
  state = mkdtempSync(join(tmpdir(), 'cc-state-'));
  service = new BridgeService({ host: '127.0.0.1', port: 0, stateDir: (f) => join(state, boardId(f)) });
  await service.listen();
});
afterEach(() => {
  service.closeAll();
  rmSync(dir, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(service.origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const node = (id: string, text: string, x = 0) => ({ id, type: 'text', text, x, y: 0, width: 100, height: 50 });

describe('BridgeService', () => {
  it('hosts several files; the Yjs sidecar goes to stateDir, not next to the board', async () => {
    const a = service.open(join(dir, 'a.canvas'));
    const b = service.open(join(dir, 'b.canvas'));
    expect(service.boards.size).toBe(2);
    const r = await post(`/b/${a.id}/cmd`, { as: 'Bot', name: 'board.add', args: { text: 'hello' } });
    expect((await r.json()).ok).toBe(true);
    await sleep(500);
    expect(readFileSync(join(dir, 'a.canvas'), 'utf8')).toContain('hello');
    expect(readFileSync(join(dir, 'b.canvas'), 'utf8')).not.toContain('hello');
    expect(readdirSync(dir, { encoding: 'utf8' }).sort()).toEqual(['a.canvas', 'b.canvas']); // no .canvas-bridge, no temp file left
    expect(existsSync(join(state, a.id, 'a.canvas.ystate'))).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  it('applies the guard: foreign Origin refused, no-Origin clients and the own origin pass', async () => {
    const a = service.open(join(dir, 'a.canvas'));
    const get = (headers: Record<string, string> = {}) => fetch(`${service.origin}/b/${a.id}/status`, { headers }).then((r) => r.status);
    expect(await get()).toBe(200);
    expect(await get({ origin: service.origin })).toBe(200);
    expect(await get({ origin: 'http://evil.example' })).toBe(403);
    expect(await get({ 'sec-fetch-site': 'cross-site' })).toBe(403);
    expect((await fetch(`${service.origin}/b/${a.id}/cmd`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(403);
  });

  it('picks up a file replaced on disk (how editors, git and iCloud write)', async () => {
    const f = join(dir, 'a.canvas');
    writeFileSync(f, JSON.stringify({ nodes: [node('n1', 'one')], edges: [] }));
    const a = service.open(f);
    expect(a.host.store.nodes.size).toBe(1);
    writeFileSync(f + '.x', JSON.stringify({ nodes: [node('n1', 'one'), node('n2', 'two', 200)], edges: [] }));
    renameSync(f + '.x', f);
    await sleep(600);
    expect(a.host.store.nodes.size).toBe(2);
  });
});

describe('the app MCP tools on an in-process client', () => {
  it('has the chess and chat tools; chat works between two seats', async () => {
    const b = service.open(join(dir, 'a.canvas'));
    const me = makeActor('Claude');
    const server = new McpServer({ name: 'collie-canvas', version: '0' });
    registerCanvasTools(server, (board) => localClient(service.find(board), me), true);
    const client = new Client({ name: 'test', version: '0' });
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(t1), client.connect(t2)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['canvas_list', 'chess_state', 'chess_move', 'chess_wait_for_turn', 'chat_send', 'chat_read', 'chat_wait']));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { error: r.isError, text: r.content.map((c) => c.text).join('\n') };
    };
    expect(await call('chat_send', { text: 'hello table' })).toEqual({ error: undefined, text: 'sent' });
    b.say(makeActor('Eve'), 'hi Claude');
    expect((await call('chat_read', { limit: 5 })).text).toContain('hi Claude');
    expect((await call('chat_read', { only_new: true })).text).toBe('(nothing new)');
    const wait = call('chat_wait', { timeout_s: 5 });
    setTimeout(() => b.say(makeActor('Eve'), 'ping'), 100);
    expect((await wait).text).toContain('ping');
    // no chessboard on the table: refused with a reason, not a crash
    expect((await call('chess_state', { canvas: b.id })).error).toBe(true);
  });
});
