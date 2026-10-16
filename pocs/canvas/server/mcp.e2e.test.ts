import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalog } from '../bridge/catalog';
import { freePort, root, until } from '../bridge/process.test-util';
import { toolList } from '../bridge/tools';
import { stableSerialize } from './core/canonical';

// `canvas serve` with its /mcp endpoint as a real process on a scratch folder, and the SDK's own
// client as the agents: several sessions, joins, scoping, wake, session close, the guard.

const empty = () => stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 1 } });

let dir: string;
let port: number;
let url: string;
let proc: ChildProcess;
let exited: Promise<number | null>;
const clients: Client[] = [];

const get = async (path: string) => {
  const r = await fetch(url + path);
  return { status: r.status, json: await r.json() };
};
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

async function connect(): Promise<{ c: Client; t: StreamableHTTPClientTransport; call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string }> }> {
  const c = new Client({ name: 'test', version: '1' });
  const t = new StreamableHTTPClientTransport(new URL(url + '/mcp'));
  await c.connect(t);
  clients.push(c);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: (r.content as { text: string }[])[0].text };
  };
  return { c, t, call };
}

/** A raw request, so Host and other headers can be anything. */
const raw = (method: string, headers: Record<string, string>, body?: string, p = port) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: p, path: '/mcp', method, headers }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: s }));
    });
    req.on('error', reject);
    req.end(body);
  });

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

const seated = async (b: string) => ((await get(`/api/boards/${b}/status`)).json.actors ?? []) as { name: string }[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-mcp-'));
  for (const n of ['alpha', 'beta', 'gamma']) writeFileSync(join(dir, n + '.canvas'), empty());
  port = await freePort();
  url = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['--import', 'tsx', 'server/serve.ts', dir, '--port', String(port), '--allow-origin', `http://mini.internal:${port}`], { cwd: root, stdio: 'ignore' });
  exited = new Promise((r) => proc.once('exit', r));
  await until(async () => !!(await fetch(url + '/api/info').catch(() => null))?.ok);
}, 30000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  proc?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('canvas serve /mcp', () => {
  let one: Awaited<ReturnType<typeof connect>>;
  let two: Awaited<ReturnType<typeof connect>>;

  it('A1: two clients connect to one endpoint and see every tool, with the board argument on the acting ones', async () => {
    one = await connect();
    two = await connect();
    const expected = toolList(catalog()).map((t) => t.name);
    for (const x of [one, two]) {
      const tools = (await x.c.listTools()).tools;
      const names = tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining([...expected, 'canvas_boards', 'canvas_join', 'canvas_leave']));
      expect(names).toHaveLength(expected.length + 3);
      for (const t of tools) {
        if (['canvas_boards', 'canvas_join', 'canvas_leave'].includes(t.name)) continue;
        expect(Object.keys((t.inputSchema as { properties: object }).properties), t.name).toContain('canvas');
      }
    }
  });

  it('A2: canvas_boards lists the folder; unjoined tools say to join; canvas_help works unjoined', async () => {
    const r = await one.call('canvas_boards');
    expect(r.text).toContain('alpha');
    expect(r.text).toContain('gamma');
    const look = await one.call('canvas_look');
    expect(look.isError).toBe(true);
    expect(look.text).toContain('join a board first');
    const help = await one.call('canvas_help');
    expect(help.isError).toBe(false);
  });

  it('A3: two sessions on one board each have their own seat, log name and undo', async () => {
    expect((await one.call('canvas_join', { board: 'alpha', name: 'Ann' })).text).toContain('joined "alpha" as Ann');
    const bob = await two.call('canvas_join', { board: 'alpha', name: 'Bob' });
    expect(bob.text).toContain('also seated: Ann');
    expect((await seated('alpha')).map((a) => a.name).sort()).toEqual(['Ann', 'Bob']);
    expect((await one.call('canvas_add_node', { text: 'from Ann' })).isError).toBe(false);
    expect((await two.call('canvas_add_node', { text: 'from Bob' })).isError).toBe(false);
    const log = (await one.call('canvas_log')).text;
    expect(log).toContain('Ann');
    expect(log).toContain('Bob');
    expect((await one.call('canvas_undo')).isError).toBe(false);
    const left = (await two.call('canvas_look')).text;
    expect(left).toContain('from Bob');
    expect(left).not.toContain('from Ann');
  });

  it('A4: with several boards joined the board argument decides', async () => {
    await one.call('canvas_join', { board: 'beta', name: 'Ann' });
    const amb = await one.call('canvas_look');
    expect(amb.isError).toBe(true);
    expect(amb.text).toMatch(/alpha, beta|beta, alpha/);
    expect((await one.call('canvas_look', { canvas: 'beta' })).text).not.toContain('from Bob');
    expect((await one.call('canvas_add_node', { text: 'only on beta', canvas: 'beta' })).isError).toBe(false);
    expect((await get('/api/boards/beta/query')).json.map((n: { text: string }) => n.text)).toEqual(['only on beta']);
    expect((await get('/api/boards/alpha/query')).json.map((n: { text: string }) => n.text)).not.toContain('only on beta');
    const bad = await one.call('canvas_look', { canvas: 'gamma' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('not joined to "gamma"');
  });

  it('A5: join errors: seat taken, unknown board, create, long name', async () => {
    const three = await connect();
    const taken = await three.call('canvas_join', { board: 'alpha', name: 'ann' });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain('taken');
    await three.c.close();
    const twice = await one.call('canvas_join', { board: 'alpha', name: 'Other' });
    expect(twice.isError).toBe(true);
    expect(twice.text).toContain('already joined');
    expect((await one.call('canvas_join', { board: 'alpha', name: 'Ann' })).isError).toBe(false); // same name again: no-op
    const missing = await two.call('canvas_join', { board: 'nope', name: 'Bob' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('no board "nope"');
    expect((await get('/api/boards')).json.map((b: { name: string }) => b.name)).not.toContain('nope');
    expect((await two.call('canvas_join', { board: 'fresh', name: 'Bob', create: true })).isError).toBe(false);
    expect((await get('/api/boards')).json.map((b: { name: string }) => b.name)).toContain('fresh');
    await two.call('canvas_leave', { board: 'fresh' });
    const long = await two.call('canvas_join', { board: 'gamma', name: 'x'.repeat(33) });
    expect(long.isError).toBe(true);
    expect(long.text).toContain('at most 32');
  });

  it('A6: a joined board can not be renamed; leaving frees it and unseats', async () => {
    expect((await post('/api/boards/alpha/rename', { to: 'alpha2' })).status).toBe(409);
    await one.call('canvas_leave', { board: 'alpha' });
    expect((await seated('alpha')).map((a) => a.name)).toEqual(['Bob']);
    expect((await post('/api/boards/alpha/rename', { to: 'alpha2' })).status).toBe(409); // Bob still sits there
    await two.call('canvas_leave', { board: 'alpha' });
    expect((await seated('alpha')).map((a) => a.name)).toEqual([]);
    expect((await post('/api/boards/alpha/rename', { to: 'alpha2' })).status).toBe(200);
    expect((await post('/api/boards/alpha2/rename', { to: 'alpha' })).status).toBe(200);
  });

  it('A8: chat_wait with several boards joined wakes on the first message, and only on joined boards', async () => {
    await one.call('canvas_join', { board: 'alpha', name: 'Ann' });
    const started = Date.now();
    const wait = one.call('chat_wait', { timeout_s: 10 });
    await new Promise((r) => setTimeout(r, 300));
    await post('/api/boards/gamma/chat/say', { as: 'Zoe', text: 'not for you' });
    await new Promise((r) => setTimeout(r, 300));
    await post('/api/boards/beta/chat/say', { as: 'Zoe', text: 'hello @Ann' });
    const r = await wait;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.text).toContain('# beta');
    expect(r.text).toContain('hello @Ann');
    expect(r.text).not.toContain('not for you');
    // nothing was marked seen by the cancelled wait on alpha: a message there is still new
    await post('/api/boards/alpha/chat/say', { as: 'Zoe', text: 'second' });
    expect((await one.call('chat_wait', { timeout_s: 5 })).text).toContain('# alpha');
  });

  it('A7: closing the session unseats it and its id stops working', async () => {
    const id = two.t.sessionId!;
    await two.call('canvas_join', { board: 'gamma', name: 'Bob' });
    expect((await seated('gamma')).map((a) => a.name)).toContain('Bob');
    await two.t.terminateSession();
    await until(async () => !(await seated('gamma')).some((a) => a.name === 'Bob'));
    expect((await post('/api/boards/gamma/rename', { to: 'gamma2' })).status).toBe(200);
    expect((await post('/api/boards/gamma2/rename', { to: 'gamma' })).status).toBe(200);
    const stale = await raw('POST', { ...MCP_HEADERS, 'mcp-session-id': id }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(stale.status).toBe(404);
  });

  it('A9: the guard applies to /mcp', async () => {
    const ok = { ...MCP_HEADERS, host: `127.0.0.1:${port}` };
    expect((await raw('POST', { ...ok, host: 'evil.example' }, INIT)).status).toBe(403);
    expect((await raw('POST', { ...ok, origin: 'http://evil.example' }, INIT)).status).toBe(403);
    expect((await raw('POST', { ...ok, 'sec-fetch-site': 'cross-site' }, INIT)).status).toBe(403);
    expect((await raw('POST', { ...ok, 'content-type': 'text/plain' }, INIT)).status).toBe(403);
    expect((await raw('POST', { ...ok, host: `mini.internal:${port}`, origin: `http://mini.internal:${port}` }, INIT)).status).toBe(200);
    expect((await raw('POST', { ...ok }, INIT)).status).toBe(200);
    // a DELETE needs no content type; here it is refused for the missing session, not by the guard
    const del = await raw('DELETE', { host: `127.0.0.1:${port}` });
    expect(del.status).not.toBe(403);
    expect((await raw('DELETE', { host: 'evil.example' })).status).toBe(403);
  });

  it('A16: SIGTERM with a joined session exits 0 and leaves an unedited board file alone', async () => {
    const before = readFileSync(join(dir, 'beta.canvas'), 'utf8');
    expect((await one.call('canvas_look', { canvas: 'beta' })).isError).toBe(false);
    proc.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(readFileSync(join(dir, 'beta.canvas'), 'utf8')).toBe(before);
  });
});
