import { describe, expect, it } from 'vitest';
import { parseBridgeArgs } from './args';
import { makeGuard } from './guard';

const json = { 'content-type': 'application/json' };

describe('guard', () => {
  const g = makeGuard({ port: 5285, allowOrigins: ['http://mini.internal:5284/'] });

  it('lets non-browser clients through (no Origin), GET and JSON POST', () => {
    expect(g.check({ host: '127.0.0.1:5285' }, 'GET')).toBeUndefined();
    expect(g.check({ host: 'localhost:5285', ...json }, 'POST')).toBeUndefined();
    expect(g.check({ host: '[::1]:5285', 'content-type': 'application/json; charset=utf-8' }, 'POST')).toBeUndefined();
  });
  it('refuses a foreign Origin, also on reads and WebSocket upgrades', () => {
    expect(g.check({ host: 'localhost:5285', origin: 'https://evil.example', ...json }, 'POST')).toMatch(/Origin/);
    expect(g.check({ host: 'localhost:5285', origin: 'https://evil.example' }, 'GET')).toMatch(/Origin/);
    expect(g.check({ host: 'localhost:5285', origin: 'http://localhost:9999' }, 'GET')).toMatch(/Origin/); // another local app
    expect(g.check({ host: 'localhost:5285', origin: 'null' }, 'GET')).toMatch(/Origin/);
  });
  it('allows the listed app origin, and the bridge host name it implies', () => {
    expect(g.check({ host: 'mini.internal:5285', origin: 'http://mini.internal:5284' }, 'GET')).toBeUndefined();
    expect(g.check({ host: 'localhost:5285', origin: 'http://localhost:5285' }, 'GET')).toBeUndefined();
  });
  it('refuses a Host that is not loopback or allowed (DNS rebinding)', () => {
    expect(g.check({ host: 'evil.example:5285' }, 'GET')).toMatch(/Host/);
    expect(g.check({}, 'GET')).toMatch(/Host/);
    expect(makeGuard({ port: 1 }).check({ host: 'mini.internal:1' }, 'GET')).toMatch(/Host/);
  });
  it('refuses a browser request from another site that carries no Origin (an <img> or <script> GET)', () => {
    expect(g.check({ host: 'localhost:5285', 'sec-fetch-site': 'cross-site' }, 'GET')).toMatch(/cross-site/);
    expect(g.check({ host: 'localhost:5285', 'sec-fetch-site': 'same-site' }, 'GET')).toMatch(/same-site/); // another local app
    expect(g.check({ host: 'localhost:5285', 'sec-fetch-site': 'none' }, 'GET')).toBeUndefined(); // typed into the address bar
    expect(g.check({ host: 'mini.internal:5285', origin: 'http://mini.internal:5284', 'sec-fetch-site': 'same-site' }, 'GET')).toBeUndefined();
  });
  it('--allow-origin takes http(s) origins only: "null" never matches', () => {
    const n = makeGuard({ port: 1, allowOrigins: ['null', 'file://', 'HTTP://App.Example:8080/'] });
    expect(n.check({ host: 'localhost:1', origin: 'null' }, 'GET')).toMatch(/Origin/);
    expect(n.check({ host: 'app.example:1', origin: 'http://app.example:8080' }, 'GET')).toBeUndefined();
  });
  it('requires JSON on POST', () => {
    expect(g.check({ host: 'localhost:5285', 'content-type': 'text/plain' }, 'POST')).toMatch(/json/);
    expect(g.check({ host: 'localhost:5285' }, 'POST')).toMatch(/json/);
    expect(g.check({ host: 'localhost:5285', 'content-type': 'application/jsonp' }, 'POST')).toMatch(/json/);
  });
});

describe('guard: methods without a JSON body', () => {
  const g = makeGuard({ port: 5285 });
  it('lets a DELETE through without a content type (an MCP session close); every other body method still needs JSON', () => {
    expect(g.check({ host: 'localhost:5285' }, 'DELETE')).toBeUndefined();
    expect(g.check({ host: 'localhost:5285' }, 'PUT')).toMatch(/json/);
    expect(g.check({ host: 'localhost:5285', 'content-type': 'text/plain' }, 'PATCH')).toMatch(/json/);
    expect(g.check({ host: 'localhost:5285', 'content-type': 'text/plain' }, 'POST')).toMatch(/json/);
  });
  it('still checks Host and Origin on a DELETE', () => {
    expect(g.check({ host: 'evil.example' }, 'DELETE')).toMatch(/Host/);
    expect(g.check({ host: 'localhost:5285', origin: 'https://evil.example' }, 'DELETE')).toMatch(/Origin/);
  });
});

describe('guard with a pairing token', () => {
  const g = makeGuard({ port: 5285, allowOrigins: ['https://canvas.lab.collie.studio'], token: 'sekret-token' });
  const origin = 'https://canvas.lab.collie.studio';
  const tunneled = { host: 'localhost:5285', origin, 'cf-connecting-ip': '203.0.113.9' };
  it('lets local processes through without it (the CLI, agents on the machine)', () => {
    expect(g.check({ host: 'localhost:5285' }, 'GET', { remote: '127.0.0.1', url: '/status' })).toBeUndefined();
    expect(g.check({ host: 'localhost:5285', 'content-type': 'application/json' }, 'POST', { remote: '::ffff:127.0.0.1', url: '/cmd' })).toBeUndefined();
  });
  it('wants it from anything that came through a proxy or tunnel', () => {
    expect(g.check(tunneled, 'GET', { remote: '127.0.0.1', url: '/' })).toMatch(/pairing token/);
    expect(g.check({ host: 'localhost:5285', 'x-forwarded-for': '1.2.3.4' }, 'GET', { remote: '127.0.0.1', url: '/doc' })).toMatch(/pairing token/);
    expect(g.check(tunneled, 'GET', { remote: '127.0.0.1', url: '/?token=wrong' })).toMatch(/pairing token/);
    expect(g.check(tunneled, 'GET', { remote: '127.0.0.1', url: '/?token=sekret-token-x' })).toMatch(/pairing token/);
  });
  it('and from a non-loopback peer', () => {
    expect(g.check({ host: 'localhost:5285' }, 'GET', { remote: '192.168.1.5', url: '/doc' })).toMatch(/pairing token/);
    expect(g.check({ host: 'localhost:5285' }, 'GET', {})).toMatch(/pairing token/);
  });
  it('accepts it as ?token= or a bearer header; the origin rules still apply after it', () => {
    expect(g.check(tunneled, 'GET', { remote: '127.0.0.1', url: '/?token=sekret-token' })).toBeUndefined();
    expect(g.check({ ...tunneled, authorization: 'Bearer sekret-token' }, 'GET', { remote: '127.0.0.1', url: '/doc' })).toBeUndefined();
    expect(g.check({ ...tunneled, origin: 'https://evil.example' }, 'GET', { remote: '127.0.0.1', url: '/?token=sekret-token' })).toMatch(/Origin/);
  });
  it('no token configured: as before', () => {
    expect(makeGuard({ port: 1 }).check({ host: 'localhost:1', 'cf-connecting-ip': '1.1.1.1' }, 'GET', { remote: '127.0.0.1' })).toBeUndefined();
  });
});

describe('parseBridgeArgs', () => {
  it('a flag before the file is not the file', () => {
    expect(parseBridgeArgs(['--host', '0.0.0.0', 'b.canvas', '--port', '1'])).toEqual({ file: 'b.canvas', fileGiven: true, host: '0.0.0.0', port: 1, allowOrigins: [] });
    expect(parseBridgeArgs(['--port=7', '--allow-origin', 'http://a:1', '--allow-origin=http://b:2', 'x.canvas']).allowOrigins).toEqual(['http://a:1', 'http://b:2']);
  });
  it('share and join, as words or flags', () => {
    expect(parseBridgeArgs(['share', 'b.canvas'])).toMatchObject({ file: 'b.canvas', share: true });
    expect(parseBridgeArgs(['share', '--no-tunnel', '--app', 'http://x:1', '--token=t'])).toMatchObject({ share: true, noTunnel: true, app: 'http://x:1', token: 't', fileGiven: false });
    expect(parseBridgeArgs(['join', 'https://canvas.lab.collie.studio/?room=k3m', 'r.canvas'])).toMatchObject({ join: 'https://canvas.lab.collie.studio/?room=k3m', file: 'r.canvas' });
    expect(parseBridgeArgs(['r.canvas', '--join', 'k3m', '--signal', 'ws://127.0.0.1:5243'])).toMatchObject({ join: 'k3m', signal: 'ws://127.0.0.1:5243', file: 'r.canvas' });
    expect(() => parseBridgeArgs(['join'])).toThrow(/room/);
    expect(() => parseBridgeArgs(['--no-tunnel'])).toThrow(/share/);
    expect(() => parseBridgeArgs(['--share=1'])).toThrow(/no value/);
    expect(parseBridgeArgs(['join', 'k3m', 'r.canvas', '--merge'])).toMatchObject({ join: 'k3m', merge: true });
    expect(() => parseBridgeArgs(['r.canvas', '--merge'])).toThrow(/join/);
  });
  it('defaults, and clear errors', () => {
    expect(parseBridgeArgs([]).file).toBe('board.canvas');
    expect(() => parseBridgeArgs(['b.canvas', '--host'])).toThrow(/needs a value/);
    expect(() => parseBridgeArgs(['--host', '--port', '1'])).toThrow(/needs a value/);
    expect(() => parseBridgeArgs(['--prot', '1'])).toThrow(/unknown option/);
    expect(() => parseBridgeArgs(['a', 'b'])).toThrow(/one file/);
    expect(() => parseBridgeArgs(['-p', '1'])).toThrow(/unknown option -p/);
    expect(() => parseBridgeArgs(['--port', 'x'])).toThrow(/not a port/);
    expect(() => parseBridgeArgs(['--host='])).toThrow(/needs a value/); // would bind every interface
    expect(() => parseBridgeArgs(['--port='])).toThrow(/needs a value/);
    expect(() => parseBridgeArgs(['--port', '0x10'])).toThrow(/not a port/);
  });
});
