import { describe, expect, it } from 'vitest';
import { parseServeArgs } from './serve-args';

describe('parseServeArgs', () => {
  it('needs exactly one folder', () => {
    expect(() => parseServeArgs([])).toThrow(/folder .* required/);
    expect(() => parseServeArgs(['a', 'b'])).toThrow(/one folder only/);
    expect(parseServeArgs(['/boards'])).toEqual({ dir: '/boards', allowOrigins: [], hostNames: [] });
  });

  it('reads the options in either order and either form', () => {
    expect(parseServeArgs(['--port', '5248', '/b', '--host=0.0.0.0', '--allow-origin', 'http://a:1', '--allow-origin=http://b:2', '--idle-ms', '300', '--app', '/dist'])).toEqual({
      dir: '/b',
      port: 5248,
      host: '0.0.0.0',
      allowOrigins: ['http://a:1', 'http://b:2'],
      hostNames: [],
      idleMs: 300,
      app: '/dist',
    });
  });

  it('--host-name repeats and takes comma lists; only bare host names', () => {
    expect(parseServeArgs(['/b', '--host-name', 'mini.internal', '--host-name=Other.local,third']).hostNames).toEqual(['mini.internal', 'other.local', 'third']);
    for (const bad of ['http://x', 'x:1', 'a/b', 'a,,b', 'a b']) expect(() => parseServeArgs(['/b', `--host-name=${bad}`])).toThrow(/bare host name/);
    expect(() => parseServeArgs(['/b', '--host-name='])).toThrow(/needs a value/);
  });

  it('refuses unknown options, missing and bad values', () => {
    expect(() => parseServeArgs(['/b', '--nope'])).toThrow(/unknown option --nope/);
    expect(() => parseServeArgs(['/b', '-p'])).toThrow(/unknown option -p/);
    expect(() => parseServeArgs(['/b', '--port'])).toThrow(/needs a value/);
    expect(() => parseServeArgs(['/b', '--host='])).toThrow(/needs a value/);
    expect(() => parseServeArgs(['/b', '--port', 'x'])).toThrow(/not a port/);
    expect(() => parseServeArgs(['/b', '--port', '70000'])).toThrow(/not a port/);
    expect(() => parseServeArgs(['/b', '--idle-ms', '-1'])).toThrow(/milliseconds/);
    expect(() => parseServeArgs(['/b', '--app'])).toThrow(/needs a value/);
  });
});
