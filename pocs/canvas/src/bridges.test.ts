import { describe, expect, it } from 'vitest';
import { bridgeFromLocation, forgetBridge, rememberBridge, savedBridges } from './bridges';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('remembered bridges', () => {
  it('most recent first, one entry per address, capped', () => {
    const s = mem();
    rememberBridge({ url: 'wss://a.example', token: 't1' }, s, 1);
    rememberBridge({ url: 'wss://b.example' }, s, 2);
    rememberBridge({ url: 'wss://a.example', token: 't2' }, s, 3);
    expect(savedBridges(s)).toEqual([
      { url: 'wss://a.example', token: 't2', last: 3 },
      { url: 'wss://b.example', last: 2 },
    ]);
    for (let i = 0; i < 12; i++) rememberBridge({ url: `wss://h${i}.example` }, s, 10 + i);
    expect(savedBridges(s)).toHaveLength(8);
    expect(forgetBridge('wss://h11.example', s)).toHaveLength(7);
  });
  it('survives junk in storage', () => {
    const s = mem();
    s.setItem('canvas-poc:bridges', '{nope');
    expect(savedBridges(s)).toEqual([]);
    s.setItem('canvas-poc:bridges', '[1,{"url":3},{"url":"wss://x","last":1}]');
    expect(savedBridges(s)).toEqual([{ url: 'wss://x', last: 1 }]);
  });
  it('the page takes its token from #token=, else from what was saved', () => {
    const s = mem();
    rememberBridge({ url: 'wss://a.example', token: 'saved' }, s);
    expect(bridgeFromLocation({ search: '?bridge=wss%3A%2F%2Fa.example', hash: '#token=fresh' }, s)).toEqual({ url: 'wss://a.example', token: 'fresh' });
    expect(bridgeFromLocation({ search: '?bridge=wss%3A%2F%2Fa.example', hash: '' }, s)).toEqual({ url: 'wss://a.example', token: 'saved' });
    expect(bridgeFromLocation({ search: '?bridge=ws%3A%2F%2Flocalhost%3A1', hash: '' }, s)).toEqual({ url: 'ws://localhost:1' });
    expect(bridgeFromLocation({ search: '', hash: '' }, s)).toBeNull();
  });
});
