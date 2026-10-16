import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, root, until } from '../../bridge/process.test-util';
import { stableSerialize } from '../../server/core/canonical';

// The /canvas skill's helper script against a real `canvas serve` on a scratch folder.

const script = join(root, 'skills/canvas/canvas-wait.mjs');
const SEAT = 'Claude · t';

let dir: string;
let url: string;
let proc: ChildProcess;
const kids: ChildProcess[] = [];

const api = async (path: string, body?: unknown) => {
  const r = await fetch(url + '/api/boards/' + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const say = (board: string, as: string, text: string) => api(`${board}/chat/say`, { as, text });

/** Run `follow` and collect its stdout lines. */
function follow(board: string, seat: string, env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [script, 'follow', board, '--as', seat, '--serve', url], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.push(p);
  const out = { lines: [] as string[], err: '', code: null as number | null };
  let buf = '';
  p.stdout!.on('data', (d) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop()!;
    out.lines.push(...parts);
  });
  p.stderr!.on('data', (d) => (out.err += d));
  p.on('exit', (c) => (out.code = c));
  return { p, out };
}
const settle = () => new Promise((r) => setTimeout(r, 300));

const name = (cwd: string) => execFileSync(process.execPath, [script, 'name'], { cwd, encoding: 'utf8' }).trim();
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-skill-'));
  for (const n of ['a', 'b']) writeFileSync(join(dir, n + '.canvas'), stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 1 } }));
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['--import', 'tsx', 'server/serve.ts', dir, '--port', String(port)], { cwd: root, stdio: 'ignore' });
  await until(async () => !!(await fetch(url + '/api/info').catch(() => null))?.ok);
}, 30000);

afterAll(() => {
  for (const k of kids) k.kill('SIGKILL');
  proc?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('canvas-wait name', () => {
  it('uses the task id from the branch, else the repo folder, else the cwd', () => {
    const repo = join(dir, 'foo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    expect(name(repo)).toBe('Claude · foo');
    git(repo, 'checkout', '-q', '-b', 'task-3.38-x');
    expect(name(repo)).toBe('Claude · task-3.38');
    git(repo, 'checkout', '-q', '-b', 'task-12');
    expect(name(repo)).toBe('Claude · task-12');
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    expect(name(plain)).toBe('Claude · plain');
  });

  it('cuts to 32 characters', () => {
    const long = join(dir, 'x'.repeat(60));
    mkdirSync(long);
    expect(name(long)).toHaveLength(32);
  });
});

describe('canvas-wait follow', () => {
  it("prints others' messages, marks mentions, skips its own, and marks them seen", async () => {
    const { p, out } = follow('a', SEAT);
    await settle();
    const t0 = Date.now();
    await say('a', 'Bob', `@${SEAT} hello there`);
    await until(() => out.lines.length >= 1, 5000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out.lines[0]).toMatch(/^@you \[\d\d:\d\d\] Bob \(agent\): @Claude · t hello there$/);
    await say('a', SEAT, 'my own words');
    await say('a', 'Bob', 'just chatting');
    await until(() => out.lines.length >= 2, 5000);
    expect(out.lines[1]).toMatch(/^\[\d\d:\d\d\] Bob \(agent\): just chatting$/);
    expect(out.lines).toHaveLength(2);
    const unread = await api(`a/chat/read?new=1&as=${encodeURIComponent(SEAT)}`);
    expect(JSON.stringify(unread)).not.toContain('Bob');
    p.kill();
  });

  it('shares the seat with an MCP join: printed once, not unread over MCP', async () => {
    const seat = 'Claude · shared';
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp')));
    const call = async (n: string, args: Record<string, unknown> = {}) => ((await c.callTool({ name: n, arguments: args })).content as { text: string }[])[0].text;
    await call('canvas_join', { board: 'b', name: seat });
    const { p, out } = follow('b', seat);
    await settle();
    await say('b', 'Bob', `@${seat} ping`);
    await until(() => out.lines.length >= 1, 5000);
    expect(out.lines).toHaveLength(1);
    expect(await call('chat_read', { only_new: true })).not.toContain('ping');
    p.kill();
    await call('canvas_leave', { board: 'b' });
    await c.close();
  });

  it('exits 1 naming the board and URL after 3 failed waits', async () => {
    const dead = await freePort();
    const p = spawn(process.execPath, [script, 'follow', 'a', '--as', SEAT, '--serve', `http://127.0.0.1:${dead}`], { env: { ...process.env, CANVAS_WAIT_BACKOFF_MS: '10' }, stdio: ['ignore', 'ignore', 'pipe'] });
    kids.push(p);
    let err = '';
    p.stderr!.on('data', (d) => (err += d));
    const code = await new Promise((r) => p.once('exit', r));
    expect(code).toBe(1);
    expect(err).toContain(`http://127.0.0.1:${dead}`);
    expect(err).toContain('"a"');
  });

  it('ends by itself after its lifetime (exit 0), so an orphaned Monitor does not run forever', async () => {
    const p = follow('a', SEAT, { CANVAS_WAIT_MAX_MS: '400' });
    await until(() => p.out.code !== null, 5000);
    expect(p.out.code).toBe(0);
  });

  it('exits 1 for an unknown board (404) and 2 for bad arguments', async () => {
    const p = follow('nope', SEAT, { CANVAS_WAIT_BACKOFF_MS: '10' });
    await until(() => p.out.code !== null, 5000);
    expect(p.out.code).toBe(1);
    const bad = spawn(process.execPath, [script, 'follow'], { stdio: 'ignore' });
    expect(await new Promise((r) => bad.once('exit', r))).toBe(2);
  });
});
