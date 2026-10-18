import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boardHref, boardWsUrl, servedBoardName } from './route';

describe('servedBoardName', () => {
  it('reads the name from /b/<name>, decoding once', () => {
    expect(servedBoardName('/')).toBeNull();
    expect(servedBoardName('/b/')).toBeNull();
    expect(servedBoardName('/b')).toBeNull();
    expect(servedBoardName('/index.html')).toBeNull();
    expect(servedBoardName('/b/a')).toBe('a');
    expect(servedBoardName('/b/a/')).toBe('a');
    expect(servedBoardName('/b/my%20board')).toBe('my board');
    expect(servedBoardName('/b/%2520')).toBe('%20');
    expect(servedBoardName('/b/%E6%97%A5%E6%9C%AC')).toBe('日本');
    expect(servedBoardName('/b/a%26b')).toBe('a&b');
  });
  it('an extra segment or a bad escape stays in the name, so the service answers for it', () => {
    expect(servedBoardName('/b/a/b')).toBe('a/b');
    expect(servedBoardName('/b/%2F')).toBe('/');
    expect(servedBoardName('/b/100%')).toBe('100%');
  });
});

describe('urls', () => {
  it('encodes names', () => {
    expect(boardHref('a b&c#d?e/f')).toBe('/b/a%20b%26c%23d%3Fe%2Ff');
    expect(boardWsUrl({ protocol: 'http:', host: '127.0.0.1:5251' }, '日本')).toBe('ws://127.0.0.1:5251/ws/%E6%97%A5%E6%9C%AC');
    expect(boardWsUrl({ protocol: 'https:', host: 'x.example' }, 'a')).toBe('wss://x.example/ws/a');
  });
});

describe('main.ts on a host without a service', () => {
  const src = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
  it('probes only behind a /b/ path', () => {
    expect(servedBoardName('/')).toBeNull();
    expect(src.match(/probeBoard\(/g)).toHaveLength(1);
    expect(src).toMatch(/else if \(SERVED !== null\) void probeBoard\(SERVED\)/);
  });
});
