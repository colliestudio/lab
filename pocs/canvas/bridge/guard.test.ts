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
  it('requires JSON on POST', () => {
    expect(g.check({ host: 'localhost:5285', 'content-type': 'text/plain' }, 'POST')).toMatch(/json/);
    expect(g.check({ host: 'localhost:5285' }, 'POST')).toMatch(/json/);
    expect(g.check({ host: 'localhost:5285', 'content-type': 'application/jsonp' }, 'POST')).toMatch(/json/);
  });
});

describe('parseBridgeArgs', () => {
  it('a flag before the file is not the file', () => {
    expect(parseBridgeArgs(['--host', '0.0.0.0', 'b.canvas', '--port', '1'])).toEqual({ file: 'b.canvas', host: '0.0.0.0', port: 1, allowOrigins: [] });
    expect(parseBridgeArgs(['--port=7', '--allow-origin', 'http://a:1', '--allow-origin=http://b:2', 'x.canvas']).allowOrigins).toEqual(['http://a:1', 'http://b:2']);
  });
  it('defaults, and clear errors', () => {
    expect(parseBridgeArgs([]).file).toBe('board.canvas');
    expect(() => parseBridgeArgs(['b.canvas', '--host'])).toThrow(/needs a value/);
    expect(() => parseBridgeArgs(['--host', '--port', '1'])).toThrow(/needs a value/);
    expect(() => parseBridgeArgs(['--prot', '1'])).toThrow(/unknown option/);
    expect(() => parseBridgeArgs(['a', 'b'])).toThrow(/one file/);
    expect(() => parseBridgeArgs(['--port', 'x'])).toThrow(/not a port/);
  });
});
