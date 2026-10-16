import { describe, expect, it } from 'vitest';
import { createBoard, deleteBoard, listBoards, renameBoard, ServeError } from './api';

function fake(reply: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => (calls.push({ url, init }), reply())) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('serve api', () => {
  it('lists with a GET', async () => {
    const { f, calls } = fake(json([{ name: 'a', loaded: false, browsers: 0 }]));
    expect(await listBoards(f)).toHaveLength(1);
    expect(calls[0]).toEqual({ url: '/api/boards', init: undefined });
  });

  it('creates, renames and deletes with JSON POSTs', async () => {
    const { f, calls } = fake(json({ name: 'x' }));
    await createBoard('new one', f);
    await renameBoard('my board', 'other', f);
    await deleteBoard('my board', f);
    expect(calls.map((c) => [c.url, c.init!.method, (c.init!.headers as Record<string, string>)['content-type'], c.init!.body])).toEqual([
      ['/api/boards', 'POST', 'application/json', '{"name":"new one"}'],
      ['/api/boards/my%20board/rename', 'POST', 'application/json', '{"to":"other"}'],
      ['/api/boards/my%20board/delete', 'POST', 'application/json', '{}'],
    ]);
  });

  it('encodes awkward names in the path', async () => {
    const { f, calls } = fake(json({}));
    for (const n of ['a&b', '100%', 'a#b', 'a?b', '日本語']) await deleteBoard(n, f);
    expect(calls.map((c) => c.url)).toEqual(['/api/boards/a%26b/delete', '/api/boards/100%25/delete', '/api/boards/a%23b/delete', '/api/boards/a%3Fb/delete', '/api/boards/%E6%97%A5%E6%9C%AC%E8%AA%9E/delete']);
  });

  it('a refusal carries the service message unchanged', async () => {
    const { f } = fake(json({ error: 'a is open (1 browser); close it first' }, 409));
    const e = await renameBoard('a', 'b', f).catch((x) => x);
    expect(e).toBeInstanceOf(ServeError);
    expect(e).toMatchObject({ status: 409, message: 'a is open (1 browser); close it first' });
  });

  it('an HTML error page gets a short fallback text', async () => {
    const { f } = fake(() => new Response('<html>' + 'x'.repeat(500), { status: 502, headers: { 'content-type': 'text/html' } }));
    const e = (await listBoards(f).catch((x) => x)) as ServeError;
    expect(e.status).toBe(502);
    expect(e.message.startsWith('HTTP 502: <html>')).toBe(true);
    expect(e.message.length).toBeLessThan(230);
  });

  it('an OK answer that is not JSON (not a service) is an error', async () => {
    const { f } = fake(() => new Response('<!doctype html>', { status: 200 }));
    await expect(listBoards(f)).rejects.toThrow(/not a canvas service|not JSON/);
  });
});
