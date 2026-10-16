import { afterEach, describe, expect, it } from 'vitest';
import { boardApi, type ApiRequest } from './api';
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
