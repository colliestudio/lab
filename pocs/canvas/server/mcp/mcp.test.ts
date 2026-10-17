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
    await expect(u.call({}, ctx())).rejects.toThrow('join a canvas first');
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

  it('a seat whose session has been silent past the takeover time goes to a new session joining under the same name; before that it is taken', async () => {
    const a = svc.create('a');
    const b = svc.create('b');
    const j = await a.join('alpha', 'Claude');
    const board = dir.loaded('alpha')!;
    const c = await dir.open('alpha');
    c.host.dispatch(j.actor, 'board.add', { id: 'x', text: 'pasted' });
    expect(c.host.seated().map((x) => x.name)).toEqual(['Claude']);
    now += 119_000;
    await expect(b.join('alpha', 'Claude')).rejects.toThrow('taken');
    now += 2_000;
    a.open = 1; // a request in flight: not silent
    await expect(b.join('alpha', 'Claude')).rejects.toThrow('taken');
    a.open = 0;
    const j2 = await b.join('alpha', 'Claude');
    expect(j2.actor.id).toBe(j.actor.id);
    expect(a.joins.size).toBe(0); // the old session lost it
    expect(c.host.seated().map((x) => x.name)).toEqual(['Claude']);
    expect(j.abort.signal.aborted).toBe(true); // its waits end
    expect(board.leases).toBe(1);
  });

  it('leave and a closing session take the seat off the table (cursor and selection gone for everyone)', async () => {
    const a = svc.create('a');
    const j = await a.join('alpha', 'Claude');
    const b = await dir.open('alpha');
    b.host.dispatch(j.actor, 'board.add', { id: 'x', text: 'pasted' });
    expect(b.host.seated()).toHaveLength(1);
    a.leave('alpha');
    expect(b.host.seated()).toHaveLength(0);
    const a2 = svc.create('a2');
    await a2.join('alpha', 'Claude');
    b.host.dispatch(makeActor('Claude'), 'board.add', { id: 'y', text: 'again' });
    expect(b.host.seated()).toHaveLength(1);
    a2.close();
    expect(b.host.seated()).toHaveLength(0);
  });

  it('create: only with the flag', async () => {
    const s = svc.create('s');
    await expect(s.join('new', 'Ann')).rejects.toThrow('no canvas "new"');
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
    const text = (await p) as string;
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

describe('cancelling and racing', () => {
  it('a wait cancelled through the call signal marks nothing seen on any board', async () => {
    const s = svc.create('s');
    const ja = await s.join('alpha', 'Ann');
    const jb = await s.join('beta', 'Ann');
    const wait = sessionTools(catalog(), s).find((t) => t.name === 'chat_wait')!;
    const ac = new AbortController();
    const p = wait.call({ timeout_s: 30 }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    expect(await p).toContain('nothing new');
    ja.board.host.say(makeActor('Zoe'), 'a');
    jb.board.host.say(makeActor('Zoe'), 'b');
    expect(ja.board.host.unreadChat(ja.actor)).toBe(1);
    expect(jb.board.host.unreadChat(jb.actor)).toBe(1);
  });

  it('two joins at once: the same name shares one seat and one lease, another name loses', async () => {
    const s = svc.create('s');
    const [x, y] = await Promise.all([s.join('alpha', 'Ann'), s.join('alpha', 'Ann')]);
    expect(x).toBe(y);
    expect(x.board.leases).toBe(1);
    const other = svc.create('o');
    const results = await Promise.allSettled([s.join('beta', 'Ann'), other.join('beta', 'Ann'), s.join('beta', 'Different')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(dir.loaded('beta')!.leases).toBe(1);
  });
});

describe('canvas_screenshot through a session', () => {
  it('reaches the board’s provider as the seat that joined, with the board state, and answers with an image', async () => {
    const calls: { board: string; actor: string; target: unknown; sv: string }[] = [];
    const shots = {
      shoot: async (board: string, actor: { id: string }, r: { target: unknown; stateVector: string; width: number; height: number }) => (
        calls.push({ board, actor: actor.id, target: r.target, sv: r.stateVector }),
        { png: new Uint8Array([137, 80, 78, 71]), width: r.width, height: r.height, ms: 7, nodes: [] }
      ),
      drop: async () => 0,
      close: async () => {},
    };
    const d2 = new BoardDirectory(new MemoryStorage({ alpha: stableSerialize({ nodes: [{ id: 'n', type: 'text', text: 'Hello', x: 0, y: 0, width: 100, height: 50 }], edges: [], extra: { 'x-canvas-format': 1 } }) }), { sweepMs: 0, log: () => {}, shots });
    const s2 = new McpService(d2, { idleMs: IDLE, now: () => now });
    try {
      const s = s2.create('s9');
      await s.join('alpha', 'Ann');
      const t = sessionTools(catalog(), s).find((x) => x.name === 'canvas_screenshot')!;
      const out = (await t.call({ node: 'Hello' }, ctx())) as { type: string; data?: string; mimeType?: string; text?: string }[];
      expect(calls).toEqual([{ board: 'alpha', actor: 'agent:ann', target: { kind: 'node', id: 'n' }, sv: expect.any(String) }]);
      expect(out[0]).toEqual({ type: 'image', data: Buffer.from([137, 80, 78, 71]).toString('base64'), mimeType: 'image/png' });
      expect(out[1].text).toContain('agent:ann');
    } finally {
      s2.closeAll();
      await d2.closeAll();
    }
  });
});
