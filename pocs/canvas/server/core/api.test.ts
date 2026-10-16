import { afterEach, describe, expect, it } from 'vitest';
import { boardApi, serviceApi, type ApiRequest } from './api';
import { BoardDirectory } from './directory';
import { Board } from './board';
import { stableSerialize } from './canonical';
import { MemoryStorage } from './memory';

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

  it('a board in a newer format is a 409 with the message, and untouched', async () => {
    const text = stableSerialize({ nodes: [], edges: [], extra: { 'x-canvas-format': 7 } });
    const call = svc({ new: text });
    const r = await call('GET', '/api/boards/new/status');
    expect(r).toMatchObject({ status: 409, json: { error: expect.stringContaining('format 7') } });
    expect(st.files.get('new')).toBe(text);
  });
});
