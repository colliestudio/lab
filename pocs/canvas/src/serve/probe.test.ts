import { describe, expect, it } from 'vitest';
import { classifyStatus, probeBoard } from './probe';

const JSON_CT = 'application/json; charset=utf-8';

describe('classifyStatus', () => {
  it('200 JSON with a name is ok', () => {
    expect(classifyStatus(200, JSON_CT, '{"name":"a","file":"/x/a.canvas"}')).toEqual({ kind: 'ok', name: 'a' });
  });
  it('maps the service errors', () => {
    expect(classifyStatus(404, JSON_CT, '{"error":"no board \\"x\\""}')).toEqual({ kind: 'missing', error: 'no board "x"' });
    expect(classifyStatus(409, JSON_CT, '{"error":"format 2","kind":"newer"}')).toEqual({ kind: 'newer', error: 'format 2' });
    expect(classifyStatus(409, JSON_CT, '{"error":"bad","kind":"invalid"}')).toMatchObject({ kind: 'failed', error: 'bad' });
    expect(classifyStatus(422, JSON_CT, '{"error":"not a canvas","kind":"invalid"}')).toMatchObject({ kind: 'failed', error: 'not a canvas' });
    expect(classifyStatus(500, JSON_CT, '{"error":"boom"}')).toEqual({ kind: 'failed', error: 'boom' });
    expect(classifyStatus(400, JSON_CT, '{}')).toEqual({ kind: 'failed', error: 'HTTP 400' });
  });
  it('anything that is not a JSON answer means no service', () => {
    expect(classifyStatus(200, 'text/html', '<!doctype html>')).toEqual({ kind: 'none' }); // vite, or a static host's fallback
    expect(classifyStatus(200, 'text/plain', 'canvas signaling…')).toEqual({ kind: 'none' }); // the Worker
    expect(classifyStatus(500, 'text/plain', 'oops')).toEqual({ kind: 'none' });
    expect(classifyStatus(200, JSON_CT, 'not json')).toEqual({ kind: 'none' });
    expect(classifyStatus(200, null, '{"name":"a"}')).toEqual({ kind: 'none' });
    expect(classifyStatus(200, JSON_CT, 'null')).toEqual({ kind: 'none' });
  });
});

describe('probeBoard', () => {
  it('asks for the status of the encoded name', async () => {
    let seen = '';
    const f = (async (u: string) => ((seen = u), new Response('{"name":"a b"}', { headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;
    expect(await probeBoard('a b', f)).toEqual({ kind: 'ok', name: 'a b' });
    expect(seen).toBe('/api/boards/a%20b/status');
  });
  it('a network error is a failure, not "no service"', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await probeBoard('a', f)).toMatchObject({ kind: 'failed', error: expect.stringContaining('Could not reach') });
  });
  it('a host that never answers gives up at the timeout', async () => {
    const f = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const t = Date.now();
    expect(await probeBoard('a', f, 30)).toMatchObject({ kind: 'failed' });
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
