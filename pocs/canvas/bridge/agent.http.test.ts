import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBridge, type TestBridge } from './process.test-util';

// The agent API over HTTP against a real bridge: /agent/run, /agent/help, view args, raw /cmd.

let b: TestBridge;
beforeAll(async () => {
  b = await startBridge();
}, 30000);
afterAll(() => b?.stop());

const run = (name: string, args: unknown, as = 'Claude') => b.post('/agent/run', { as, name, args });

describe('agent API', () => {
  it('adds a note by column title and returns its id', async () => {
    const col = await run('board.add', { text: 'Doing', type: 'group' });
    expect(col).toMatchObject({ status: 200, ok: true });
    const r = await run('board.add', { text: 'Write it', column: 'Doing' });
    expect(r).toMatchObject({ status: 200, ok: true, result: { id: expect.any(String) } });
    const nodes = await b.get('/query?column=Doing');
    expect(nodes.map((n: any) => n.id)).toEqual([r.result.id]);
  });

  it('plays a chess move and answers with the game text', async () => {
    expect(await run('chess.newgame', {})).toMatchObject({ ok: true });
    await run('chess.sit', { color: 'white' });
    const m = await run('chess.move', { move: 'e4' });
    expect(m.ok).toBe(true);
    expect(m.text).toContain('1. e4');
  });

  it('bad args are a 400 with the field and an example', async () => {
    const r = await run('chess.move', {});
    expect(r.status).toBe(400);
    expect(r.error).toContain('args.move');
    expect(r.error).toContain('Example: {"move":"Nf3"}');
  });

  it('help: plugins, then a plugin with its guide, JSON Schema and examples', async () => {
    const all = await b.get('/agent/help');
    expect(all.map((p: any) => p.id)).toEqual(expect.arrayContaining(['core', 'board', 'chess']));
    const chess = await b.get('/agent/help?plugin=chess');
    expect(chess.guide).toContain('Sit first');
    const mv = chess.commands.find((c: any) => c.name === 'chess.move');
    expect(mv.example).toEqual({ move: 'Nf3' });
    expect(mv.args.properties.move.type).toBe('string');
    expect(await b.get('/agent/help?plugin=chess&command=chess.move')).toMatchObject({ name: 'chess.move' });
    expect((await b.get('/agent/help?plugin=nope')).error).toMatch(/unknown plugin/);
  });

  it('views take args as JSON or plain parameters', async () => {
    const a = await b.get(`/view/chess.state?as=Claude&args=${encodeURIComponent('{}')}`);
    expect(a.you).toBe('white');
    const bad = await b.get(`/view/chess.state?as=Claude&args=${encodeURIComponent('{"board":3}')}`);
    expect(bad.error).toContain('args.board');
  });

  it('raw /cmd still works unvalidated', async () => {
    const r = await b.post('/cmd', { as: 'Claude', name: 'board.add', args: { type: 'text', text: 'raw', x: 0, y: 500 } });
    expect(r).toMatchObject({ ok: true, changed: 1 });
  });

  it('a command without a spec runs, marked undescribed', async () => {
    const r = await run('chess.repair', {});
    expect(r).toMatchObject({ ok: true, undescribed: true });
  });

  it('chat points at a node by title', async () => {
    const r = await b.post('/chat/say', { as: 'Claude', text: 'about this', node: 'Write it' });
    expect(r.ok).toBe(true);
    expect(r.message.node).toBeTruthy();
  });
});
