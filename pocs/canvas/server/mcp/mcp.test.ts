import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catalog } from '../../bridge/catalog';
import { client } from '../../bridge/client';
import { toolList, type ToolSpec } from '../../bridge/tools';
import { stableSerialize } from '../core/canonical';
import { BoardDirectory } from '../core/directory';
import { makeActor } from '../core/host';
import { MemoryStorage } from '../core/memory';
import { localSend } from './local';
import { McpService } from './session';
import { BOARD_ARG, scopedTools, sessionTools } from './tools';

const empty = () => stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 1 } });

let dir: BoardDirectory;
let now = 1_000_000;
let svc: McpService;
const IDLE = 60_000;
const ctx = () => ({ signal: new AbortController().signal });

beforeEach(() => {
  now = 1_000_000;
  dir = new BoardDirectory(new MemoryStorage({ alpha: empty(), beta: empty() }), { sweepMs: 0, log: () => {} });
  svc = new McpService(dir, { idleMs: IDLE, now: () => now });
});
afterEach(async () => {
  svc.closeAll();
  await dir.closeAll();
});

describe('in-process client', () => {
  it('runs commands, views and chat on a board without HTTP', async () => {
    const b = await dir.open('alpha');
    const c = client({ as: 'Ann', send: localSend(b, new AbortController().signal) });
    const added = await c.run('board.add', { text: 'hi' });
    expect(added.changed).toBe(1);
    expect((await c.query({ text: 'hi' })).length).toBe(1);
    expect(await c.chatRead()).toEqual([]);
    await c.say('hello');
    expect((await c.log(5)).some((e) => e.actor === 'Ann')).toBe(true);
    expect(((await c.status()) as { actors: unknown[] }).actors.length).toBe(1);
  });

  it('fails fast once cancelled', async () => {
    const b = await dir.open('alpha');
    const ac = new AbortController();
    const c = client({ as: 'Ann', send: localSend(b, ac.signal) });
    ac.abort();
    await expect(c.query({})).rejects.toThrow('cancelled');
  });
});

describe('scopedTools', () => {
  const tool = (name: string, schema: object, call: ToolSpec['call']): ToolSpec => ({ name, description: name, inputSchema: { type: 'object', properties: schema }, call });

  it('strips the board argument before the tool sees its args, and adds it to the schema', async () => {
    const s = svc.create('s1');
    await s.join('alpha', 'Ann');
    let seen: Record<string, any> | undefined;
    const [t] = scopedTools([tool('t', { x: { type: 'string' } }, async (c, a) => ((seen = a), String(await c.query({}).then((r) => r.length))))], s);
    expect(Object.keys(t.inputSchema.properties)).toEqual(['x', BOARD_ARG]);
    expect(await t.call({ x: '1', [BOARD_ARG]: 'alpha' }, ctx())).toBe('0');
    expect(seen).toEqual({ x: '1' });
  });

  it('gives every generated tool the argument; a tool that already has it throws', () => {
    const s = svc.create('s1');
    for (const t of scopedTools(toolList(catalog()), s)) expect(Object.keys(t.inputSchema.properties), t.name).toContain(BOARD_ARG);
    expect(() => scopedTools([tool('t', { [BOARD_ARG]: { type: 'string' } }, async () => '')], s)).toThrow(/already has/);
  });

  it('resolves lazily: a tool that never uses its client works unjoined', async () => {
    const s = svc.create('s1');
    const [t] = scopedTools([tool('t', {}, async () => 'fine')], s);
    expect(await t.call({}, ctx())).toBe('fine');
    const [u] = scopedTools([tool('u', {}, async (c) => String(await c.query({})))], s);
    await expect(u.call({}, ctx())).rejects.toThrow('join a board first');
  });

  it('with several joins an unnamed call lists them; a named one works', async () => {
    const s = svc.create('s1');
    await s.join('alpha', 'Ann');
    await s.join('Beta', 'Ann');
    const [u] = scopedTools([tool('u', {}, async (c) => String((await c.query({})).length))], s);
    await expect(u.call({}, ctx())).rejects.toThrow('alpha, beta');
    expect(await u.call({ [BOARD_ARG]: 'BETA' }, ctx())).toBe('0');
  });
});

describe('sessions', () => {
  it('joins seat, leave unseat, and the lease keeps the board in use', async () => {
    const s = svc.create('s1');
    const j = await s.join('alpha', 'Ann');
    expect(j.board.host.seated().map((a) => a.name)).toEqual(['Ann']);
    expect(j.board.leases).toBe(1);
    s.leave('ALPHA');
    expect(j.board.host.seated()).toEqual([]);
    expect(j.board.leases).toBe(0);
    expect(() => s.leave('alpha')).toThrow('not joined');
  });

  it('seat names: trimmed, 1-32 chars, unique per board across sessions by slug', async () => {
    const a = svc.create('a');
    const b = svc.create('b');
    await expect(a.join('alpha', '  ')).rejects.toThrow('required');
    await expect(a.join('alpha', 'x'.repeat(33))).rejects.toThrow('at most 32');
    const j = await a.join('alpha', ' Claude · A ');
    expect(j.actor.name).toBe('Claude · A');
    await expect(b.join('alpha', 'claude-a')).rejects.toThrow('taken');
    expect((await b.join('beta', 'claude-a')).actor.id).toBe(makeActor('Claude · A').id);
    await expect(a.join('alpha', 'Other')).rejects.toThrow('already joined');
    expect(await a.join('alpha', 'claude a')).toBe(j); // same seat again: no-op
    expect(dir.loaded('alpha')!.leases).toBe(1); // the refused joins released their leases
  });

  it('create: only with the flag', async () => {
    const s = svc.create('s');
    await expect(s.join('new', 'Ann')).rejects.toThrow('no board "new"');
    await s.join('new', 'Ann', { create: true });
    expect((await dir.list()).map((e) => e.name)).toContain('new');
  });

  it('sweep closes an idle session and releases its leases; one with an open request stays', async () => {
    const idle = svc.create('idle');
    const busy = svc.create('busy');
    const ji = await idle.join('alpha', 'Ann');
    await busy.join('beta', 'Bob');
    busy.open = 1; // a pending chat_wait
    now += IDLE + 1;
    svc.sweep();
    expect(svc.get('idle')).toBeUndefined();
    expect(svc.get('busy')).toBeDefined();
    expect(ji.board.leases).toBe(0);
    expect(ji.board.host.seated()).toEqual([]);
    busy.open = 0;
    busy.touch();
    now += IDLE;
    svc.sweep();
    expect(svc.get('busy')).toBeDefined();
    now += 1;
    svc.sweep();
    expect(svc.get('busy')).toBeUndefined();
  });

  it('a joined seat survives the host sweep while touched, and is gone after leave', async () => {
    const s = svc.create('s');
    const j = await s.join('alpha', 'Ann');
    const host = j.board.host;
    const t = Date.now();
    svc.touchSeats();
    host.sweep(3 * 60_000, t + 3 * 60_000 - 1);
    expect(host.seated()).toHaveLength(1);
    s.leave('alpha');
    expect(host.seated()).toHaveLength(0);
  });

  it('at the cap the longest idle session makes room; with none idle it refuses', () => {
    const small = new McpService(dir, { max: 2, now: () => now });
    const a = small.create('a');
    now += 10;
    const b = small.create('b');
    b.open = 1;
    small.create('c');
    expect(small.get('a')).toBeUndefined();
    a.close();
    b.open = 1;
    small.get('c')!.open = 1;
    expect(() => small.create('d')).toThrow('too many');
  });
});

describe('chat_wait over several boards', () => {
  it('returns the first board with news, names it, and a cancelled wait loses nothing', async () => {
    const s = svc.create('s');
    const ja = await s.join('alpha', 'Ann');
    const jb = await s.join('beta', 'Ann');
    const tools = sessionTools(catalog(), s);
    const wait = tools.find((t) => t.name === 'chat_wait')!;
    const p = wait.call({ timeout_s: 5 }, ctx());
    await new Promise((r) => setTimeout(r, 20));
    jb.board.host.say(makeActor('Zoe'), 'hi @Ann');
    ja.board.host.say(makeActor('Zoe'), 'also here'); // lands while the race is being settled
    const text = await p;
    expect(text).toContain('# beta');
    expect(text).toContain('hi @Ann');
    expect(ja.board.host.unreadChat(ja.actor)).toBeLessThanOrEqual(1);
    // either alpha's message came back with this answer or it is still unread: never lost
    expect(text.includes('also here') || ja.board.host.unreadChat(ja.actor) === 1).toBe(true);
  });

  it('a session closed during the wait ends it', async () => {
    const s = svc.create('s');
    await s.join('alpha', 'Ann');
    await s.join('beta', 'Ann');
    const wait = sessionTools(catalog(), s).find((t) => t.name === 'chat_wait')!;
    const p = wait.call({ timeout_s: 30 }, ctx());
    await new Promise((r) => setTimeout(r, 20));
    s.close();
    expect(await p).toContain('nothing new');
  });
});
