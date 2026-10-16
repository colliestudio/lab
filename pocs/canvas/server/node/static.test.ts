import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeGuard } from './guard';
import { createStaticApp } from './static';

let tmp: string;
let app: string;
let server: Server;
let missing: Server;
let port: number;
let missingPort: number;

/** A raw request, so the path reaches the server exactly as written (no URL normalizing). */
const call = (p: number, path: string, o: { method?: string; headers?: Record<string, string> } = {}) =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: p, path, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${p}`, ...o.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

const serve = (root: string) =>
  new Promise<{ s: Server; p: number }>((resolve) => {
    const guard = makeGuard({ port: 0 });
    const a = createStaticApp(root, guard);
    const s = createServer(async (req, res) => {
      if (!(await a.handle(req, res))) {
        res.writeHead(418);
        res.end('not static');
      }
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, p: (s.address() as AddressInfo).port }));
  });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'canvas-static-'));
  app = join(tmp, 'app');
  mkdirSync(join(app, 'assets'), { recursive: true });
  writeFileSync(join(app, 'index.html'), '<title>board</title>');
  writeFileSync(join(app, 'home.html'), '<title>home</title>');
  writeFileSync(join(app, 'assets', 'a.js'), 'console.log(1)');
  writeFileSync(join(app, 'x.woff2'), 'font');
  writeFileSync(join(app, '.secret'), 'dot');
  writeFileSync(join(tmp, 'outside.txt'), 'OUTSIDE');
  symlinkSync(join(tmp, 'outside.txt'), join(app, 'link.txt'));
  ({ s: server, p: port } = await serve(app));
  ({ s: missing, p: missingPort } = await serve(join(tmp, 'nope')));
});
afterAll(() => {
  server.close();
  missing.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('static app', () => {
  it('/ is home.html; /b/<name> in any spelling is index.html; /b is a redirect', async () => {
    expect((await call(port, '/')).body).toBe('<title>home</title>');
    for (const p of ['/b/x', '/b/%E6%97%A5', '/b/x/', '/b/a%2Fb', '/b/x?room=1']) expect((await call(port, p)).body, p).toBe('<title>board</title>');
    expect(await call(port, '/b')).toMatchObject({ status: 302, headers: { location: '/' } });
    expect(await call(port, '/b/')).toMatchObject({ status: 302 });
  });

  it('types and caching', async () => {
    expect((await call(port, '/assets/a.js')).headers).toMatchObject({ 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
    expect((await call(port, '/x.woff2')).headers['content-type']).toBe('font/woff2');
    expect((await call(port, '/')).headers).toMatchObject({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    expect((await call(port, '/nope.js')).status).toBe(404);
  });

  it('never hands out anything outside the app folder', async () => {
    for (const p of ['/..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/x', '/assets/../../package.json', '/assets/%2e%2e%2f%2e%2e%2fpackage.json', '/a%00b', '/assets%5c..%5ca.js', '/.secret', '/link.txt', '/assets', '/%ZZ', '//%', '//[', '/%61pi/info', '//api/info', '/api/..%2f', '/%2561pi']) {
      const r = await call(port, p);
      expect([400, 404, 418], p).toContain(r.status);
      expect(r.body, p).not.toMatch(/OUTSIDE|dot|root:/);
    }
  });

  it('a request target that is not a URL is a 400 and the server lives on', async () => {
    for (const p of ['//%', '//[']) expect((await call(port, p)).status, p).toBe(400);
    expect((await call(port, '/')).status).toBe(200);
  });

  it('the pages cannot be framed by other sites; assets need not say', async () => {
    for (const p of ['/', '/b/x']) expect((await call(port, p)).headers, p).toMatchObject({ 'content-security-policy': "frame-ancestors 'self'", 'x-frame-options': 'SAMEORIGIN' });
    expect((await call(port, '/assets/a.js')).headers['x-frame-options']).toBeUndefined();
  });

  it('encoded and protocol-relative spellings of the reserved paths agree with the API router', async () => {
    // WHATWG-normalized like http.ts: %61pi is not /api (static answers, 404), //api/info has host "api"
    expect((await call(port, '/%61pi/info')).status).toBe(404);
    expect((await call(port, '//api/info')).status).toBe(404); // host "api", path /info
    expect((await call(port, '/api/..')).body).toBe('<title>home</title>');
  });

  it('only GET and HEAD; HEAD has no body', async () => {
    expect(await call(port, '/', { method: 'POST' })).toMatchObject({ status: 405, headers: { allow: 'GET, HEAD' } });
    const h = await call(port, '/', { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(h.body).toBe('');
    expect(h.headers['content-length']).toBe(String('<title>home</title>'.length));
  });

  it('leaves /api, /ws and /mcp alone, whatever the method', async () => {
    for (const p of ['/api', '/api/boards', '/ws/a', '/mcp', '/mcp/x']) {
      expect((await call(port, p)).status, p).toBe(418);
      expect((await call(port, p, { method: 'POST' })).status, p).toBe(418);
    }
  });

  it('refuses a Host that is not loopback or allowed, but not a cross-site navigation', async () => {
    expect((await call(port, '/', { headers: { host: 'evil.example:80' } })).status).toBe(403);
    expect((await call(port, '/', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
  });

  it('adds no CORS headers', async () => {
    const r = await call(port, '/assets/a.js', { headers: { origin: 'http://evil.example' } });
    expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control'))).toEqual([]);
  });

  it('a missing build: the pages say to run pnpm build, other paths are 404', async () => {
    for (const p of ['/', '/b/x']) {
      const r = await call(missingPort, p);
      expect(r.status).toBe(503);
      expect(r.body).toContain('pnpm build');
    }
    expect((await call(missingPort, '/assets/a.js')).status).toBe(404);
  });
});
