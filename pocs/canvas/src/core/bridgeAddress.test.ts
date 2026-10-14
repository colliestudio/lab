import { describe, expect, it } from 'vitest';
import { bridgeLink, parseBridgeAddress, parseRoomRef } from './bridgeAddress';

describe('parseBridgeAddress', () => {
  it('takes ws, wss and http(s) addresses and bare host:port', () => {
    expect(parseBridgeAddress('wss://a-b.trycloudflare.com')).toEqual({ url: 'wss://a-b.trycloudflare.com', token: undefined });
    expect(parseBridgeAddress(' https://a-b.trycloudflare.com/ ').url).toBe('wss://a-b.trycloudflare.com');
    expect(parseBridgeAddress('http://localhost:5222').url).toBe('ws://localhost:5222');
    expect(parseBridgeAddress('localhost:5222').url).toBe('ws://localhost:5222');
    expect(parseBridgeAddress('mini.internal:5222').url).toBe('ws://mini.internal:5222');
  });
  it('finds the token in ?token= and in #token=', () => {
    expect(parseBridgeAddress('wss://x.example?token=abc')).toEqual({ url: 'wss://x.example', token: 'abc' });
    expect(parseBridgeAddress('wss://x.example#token=abc')).toEqual({ url: 'wss://x.example', token: 'abc' });
  });
  it('unwraps a full app link', () => {
    const link = bridgeLink('https://canvas.lab.collie.studio', { url: 'wss://x.example', token: 'a/b+c' });
    expect(link).toBe('https://canvas.lab.collie.studio/?bridge=wss%3A%2F%2Fx.example#token=a%2Fb%2Bc');
    expect(parseBridgeAddress(link)).toEqual({ url: 'wss://x.example', token: 'a/b+c' });
  });
  it('rejects junk with a readable message', () => {
    expect(() => parseBridgeAddress('')).toThrow(/Paste/);
    expect(() => parseBridgeAddress('ftp://x.example')).toThrow(/ws:\/\//);
    expect(() => parseBridgeAddress('http://')).toThrow();
  });
});

describe('parseRoomRef', () => {
  it('a bare id has no signal of its own', () => {
    expect(parseRoomRef('abc123')).toEqual({ room: 'abc123', signal: null, app: null });
  });
  it('a deployed link signals on its own origin, a dev link on 5192, ?signal= wins', () => {
    expect(parseRoomRef('https://canvas.lab.collie.studio/?room=k3m')).toEqual({ room: 'k3m', signal: 'wss://canvas.lab.collie.studio', app: 'https://canvas.lab.collie.studio' });
    expect(parseRoomRef('http://mini.internal:5190/?room=k3m').signal).toBe('ws://mini.internal:5192');
    expect(parseRoomRef('http://x:5241/?room=k3m&signal=ws://127.0.0.1:5243').signal).toBe('ws://127.0.0.1:5243');
  });
  it('refuses a link without a room', () => {
    expect(() => parseRoomRef('https://canvas.lab.collie.studio/')).toThrow(/room/);
    expect(() => parseRoomRef('not a link')).toThrow();
  });
});
