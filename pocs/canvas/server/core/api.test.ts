import { afterEach, describe, expect, it } from 'vitest';
import { boardApi, errorReply, serviceApi, type ApiRequest } from './api';
import { BoardFileError, DirError } from './errors';
import { FormatError } from '../../src/core/format';
import { BoardDirectory } from './directory';
import { Board } from './board';
import { stableSerialize } from './canonical';
import { MemoryStorage } from './memory';
import { ShotError, type ShotProvider, type ShotRequest } from './shots';
import type { Actor } from './host';

const req = (method: string, path: string, body: unknown = {}, headers: ApiRequest['headers'] = {}): ApiRequest => {
  const [p, qs] = path.split('?');
  return { method, path: p, query: new URLSearchParams(qs), headers, body: async () => body };
};

let board: Board;
afterEach(() => board.close());
const open = async () =>
  (board = await Board.load('demo', new MemoryStorage({ demo: stableSerialize({ nodes: [{ id: 'a', type: 'text', text: 'hi', x: 0, y: 0, width: 100, height: 50 }], edges: [] }) }), { log: () => {} }));

describe('boardApi', () => {
  it('/status counts what is on the board', async () => {
    await open();
    const r = await boardApi(board, req('GET', '/status'));
    expect(r).toMatchObject({ status: 200, json: { name: 'demo', file: 'memory:demo', nodes: 1, edges: 0, browsers: 0, actors: [] } });
  });

  it('/doc gives the canonical text as is', async () => {
    await open();
    const r = await boardApi(board, req('GET', '/doc'));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.raw!).nodes[0].id).toBe('a');
    expect(r.raw).toBe(board.host.fileText());
  });

  it('/agent/run as a named actor changes the board and seats the actor', async () => {
    await open();
    const r = await boardApi(board, req('POST', '/agent/run', { as: 'Claude', name: 'board.add', args: { text: 'new note' } }));
    expect(r).toMatchObject({ status: 200, json: { ok: true, changed: 1 } });
    expect(board.host.store.nodes.size).toBe(2);
    expect(board.host.seated().map((a) => a.name)).toEqual(['Claude']);
  });

  it('the actor can come from the x-canvas-as header', async () => {
    await open();
    await boardApi(board, req('POST', '/cmd', { name: 'board.add', args: { id: 'z', text: 'x' } }, { 'x-canvas-as': 'Header Bot' }));
    expect(board.host.seated().map((a) => a.name)).toEqual(['Header Bot']);
  });

  it('answers 400 for a command that fails, 404 for an unknown route', async () => {
    await open();
    expect((await boardApi(board, req('POST', '/agent/run', { name: 'nope.nothing' }))).status).toBe(400);
    expect((await boardApi(board, req('GET', '/nothing'))).status).toBe(404);
  });

  it('a body that is not JSON is a 500 with the message', async () => {
    await open();
    const bad: ApiRequest = { ...req('POST', '/cmd'), body: async () => JSON.parse('{') };
    expect((await boardApi(board, bad)).status).toBe(500);
  });
});

describe('directoryApi and serviceApi', () => {
  const svc = (files: Record<string, string> = {}) => {
    st = new MemoryStorage(files);
    dir = new BoardDirectory(st, { sweepMs: 0, log: () => {} });
    return (method: string, path: string, body: unknown = {}) => serviceApi(dir, req(method, path, body));
  };
  const stamped = (id: string) => stableSerialize({ nodes: [{ id, type: 'text', text: id, x: 0, y: 0, width: 100, height: 50 }], edges: [], extra: { 'x-canvas-format': 1 } });
  let st: MemoryStorage;
  let dir: BoardDirectory;
  afterEach(() => dir.closeAll());

  it('create with text: the file is the text; a non-string text is 400, a newer one 409, junk 422', async () => {
    const call = svc();
    expect(await call('POST', '/api/boards', { name: 'imp', text: stamped('q') })).toMatchObject({ status: 201, json: { name: 'imp' } });
    expect(st.files.get('imp')).toBe(stamped('q'));
    expect((await call('POST', '/api/boards', { name: 'x', text: 5 }))!.status).toBe(400);
    expect(await call('POST', '/api/boards', { name: 'n', text: stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 99 } }) })).toMatchObject({ status: 409, json: { kind: 'newer' } });
    expect(await call('POST', '/api/boards', { name: 'j', text: 'junk' })).toMatchObject({ status: 422, json: { kind: 'invalid' } });
    expect([...st.files.keys()]).toEqual(['imp']);
  });

  it('info, list, create, rename, delete and their status codes', async () => {
    const call = svc({ a: stamped('x') });
    expect(await call('GET', '/api/info')).toMatchObject({ status: 200, json: { service: 'canvas-serve', format: 1 } });
    expect((await call('GET', '/api/boards'))!.json).toEqual([expect.objectContaining({ name: 'a', loaded: false })]);
    expect(await call('POST', '/api/boards', { name: 'b' })).toMatchObject({ status: 201, json: { name: 'b' } });
    expect((await call('POST', '/api/boards', { name: 'b' }))!.status).toBe(409);
    expect((await call('POST', '/api/boards', { name: '../x' }))!.status).toBe(400);
    expect(await call('POST', '/api/boards/b/rename', { to: 'c d' })).toMatchObject({ status: 200, json: { name: 'c d' } });
    expect((await call('POST', '/api/boards/b/rename', { to: 'z' }))!.status).toBe(404);
    expect(await call('POST', '/api/boards/c%20d/delete')).toMatchObject({ status: 200, json: { ok: true } });
    expect(((await call('GET', '/api/boards'))!.json as { name: string }[]).map((e) => e.name)).toEqual(['a']);
  });

  it("a board's own routes load it on first use; an unknown board is a 404", async () => {
    const call = svc({ a: stamped('x') });
    expect(await call('GET', '/api/boards/a/status')).toMatchObject({ status: 200, json: { name: 'a', nodes: 1 } });
    expect(dir.loaded('a')).toBeDefined();
    expect((await call('GET', '/api/boards/nope/status'))!.status).toBe(404);
    expect((await call('GET', '/api/boards/a'))!.status).toBe(404);
    expect(await call('GET', '/doc')).toBeUndefined();
  });

  it('errorReply: status and kind per error', () => {
    expect(errorReply(new FormatError(7))).toMatchObject({ status: 409, json: { kind: 'newer' } });
    expect(errorReply(new FormatError('x'))).toMatchObject({ status: 409, json: { kind: 'invalid' } });
    expect(errorReply(new BoardFileError('a', new Error('bad json')))).toMatchObject({ status: 422, json: { kind: 'invalid', error: expect.stringContaining('bad json') } });
    expect(errorReply(new DirError(404, 'no'))).toEqual({ status: 404, json: { error: 'no' } });
    expect(errorReply(new Error('boom'))).toEqual({ status: 500, json: { error: 'boom' } });
  });

  it('a broken file is a 422 invalid and untouched', async () => {
    const call = svc({ bad: '{nope' });
    expect(await call('GET', '/api/boards/bad/status')).toMatchObject({ status: 422, json: { kind: 'invalid' } });
    expect(st.files.get('bad')).toBe('{nope');
  });

  it('a board in a newer format is a 409 with the message, and untouched', async () => {
    const text = stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 7 } });
    const call = svc({ new: text });
    const r = await call('GET', '/api/boards/new/status');
    expect(r).toMatchObject({ status: 409, json: { error: expect.stringContaining('format 7') } });
    expect(st.files.get('new')).toBe(text);
  });
});

describe('/shot', () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const texts = stableSerialize({
    nodes: [
      { id: 'a', type: 'text', text: 'Alpha', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', type: 'text', text: 'Beta', x: 200, y: 0, width: 100, height: 50 },
    ],
    edges: [],
  });
  const withShots = async (shoot: ShotProvider['shoot']) => (board = await Board.load('demo', new MemoryStorage({ demo: texts }), { log: () => {}, shots: { shoot, drop: async () => 0, close: async () => {} } }));
  const calls: { board: string; actor: Actor; r: ShotRequest }[] = [];
  const ok = (board: string, actor: Actor, r: ShotRequest) => (calls.push({ board, actor, r }), Promise.resolve({ png: PNG, width: r.width, height: r.height, ms: 12, nodes: [{ id: 'a', type: 'text', box: [1, 2, 3, 4] as [number, number, number, number] }] }));
  const get = (path: string) => boardApi(board, req('GET', path));
  const args = (a: object, extra = '') => `/shot?args=${encodeURIComponent(JSON.stringify(a))}${extra}`;

  it('passes the seat, defaults and the board state to the provider, and returns base64 + metadata', async () => {
    calls.length = 0;
    await withShots(ok);
    const r = await get('/shot?as=Claude Code&kind=tool');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ mime: 'image/png', seat: 'tool:claude-code', target: 'whole board', width: 1000, height: 750, ms: 12, nodes: [{ id: 'a' }] });
    expect(Buffer.from((r.json as { png: string }).png, 'base64')).toEqual(Buffer.from(PNG));
    expect(calls[0].board).toBe('demo');
    expect(calls[0].actor.id).toBe('tool:claude-code');
    expect(calls[0].r).toMatchObject({ target: { kind: 'all' }, width: 1000, height: 750, padding: 40, labels: false });
    expect(calls[0].r.stateVector).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('resolves a node title to its id, clamps sizes, and takes a region and labels', async () => {
    calls.length = 0;
    await withShots(ok);
    await get(args({ node: 'beta', width: 99999, height: 5, labels: true, padding: 10 }));
    expect(calls[0].r).toMatchObject({ target: { kind: 'node', id: 'b' }, width: 2000, height: 200, padding: 10, labels: true });
    await get(args({ region: { x: -10, y: 5, width: 300, height: 200 } }, '&as=Claude'));
    expect(calls[1].r.target).toEqual({ kind: 'region', x: -10, y: 5, width: 300, height: 200 });
    expect(calls[1].actor.id).toBe('agent:claude');
  });

  it('a bad region or an unknown node is a 400 with a clear message', async () => {
    await withShots(ok);
    for (const [a, msg] of [
      [{ region: { x: 0, y: 0, width: 0, height: 10 } }, 'above 0'],
      [{ region: { x: 'a', y: 0, width: 5, height: 10 } }, 'region.x must be a number'],
      [{ region: 5 }, 'region must be'],
      [{ node: 'zzz' }, 'no node "zzz"'],
      [{ node: 'a', region: { x: 0, y: 0, width: 1, height: 1 } }, 'not both'],
    ] as const) {
      const r = await get(args(a));
      expect(r.status).toBe(400);
      expect((r.json as { error: string }).error).toContain(msg);
    }
    expect((await get('/shot?args=%7B')).status).toBe(400);
  });

  it('without a provider: 503 "not available here"; a provider error keeps its status and text', async () => {
    await open();
    const none = await get('/shot');
    expect(none.status).toBe(503);
    expect((none.json as { error: string }).error).toContain('screenshots are not available here');
    await withShots(() => Promise.reject(new ShotError(503, 'no browser for screenshots: install Chrome')));
    expect(await get('/shot')).toEqual({ status: 503, json: { error: 'no browser for screenshots: install Chrome' } });
    await withShots(() => Promise.reject(new Error('boom')));
    expect((await get('/shot')).status).toBe(500);
  });
});
