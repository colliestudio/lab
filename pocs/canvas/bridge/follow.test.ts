import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/core/chat';
import { apiBase, followChat } from './follow';

const msg = (text: string): ChatMessage => ({ id: text, text, time: 0, from: { id: 'p', name: 'Zoe', color: '#000' } }) as ChatMessage;
const doc = async () => ({ nodes: [] }) as never;

describe('apiBase', () => {
  it('without --canvas nothing changes', () => {
    expect(apiBase({}, {})).toBeUndefined();
    expect(apiBase({ bridge: 'http://x:1' }, { CANVAS_SERVE: 'http://s' })).toBe('http://x:1');
  });
  it('--canvas builds the service URL: --bridge, else $CANVAS_SERVE, else the default; the name is encoded', () => {
    expect(apiBase({ board: 'my board' }, {})).toBe('http://localhost:5231/api/boards/my%20board');
    expect(apiBase({ board: 'b' }, { CANVAS_SERVE: 'http://localhost:5252/' })).toBe('http://localhost:5252/api/boards/b');
    expect(apiBase({ board: 'b/c', bridge: 'http://h:9' }, { CANVAS_SERVE: 'http://s' })).toBe('http://h:9/api/boards/b%2Fc');
    expect(() => apiBase({ board: '' }, {})).toThrow('needs a board name');
  });
});

describe('followChat', () => {
  it('prints each batch as it arrives and waits again after a timeout slice', async () => {
    const replies: (ChatMessage[] | Error)[] = [[msg('one')], [], [msg('two')]];
    const ac = new AbortController();
    const out: string[] = [];
    await followChat(
      { chatWait: async () => (replies.length ? (replies.shift() as ChatMessage[]) : (ac.abort(), [])), doc },
      (t) => out.push(t),
      { signal: ac.signal },
    );
    expect(out.map((t) => t.includes('one') ? 'one' : t.includes('two') ? 'two' : t)).toEqual(['one', 'two']);
  });

  it('survives failures below the limit (backing off 1, 2 s) and gives up after three in a row', async () => {
    const slept: number[] = [];
    let calls = 0;
    const flaky = { chatWait: async () => (++calls === 3 ? [msg('back')] : Promise.reject(new Error('down'))), doc };
    const ac = new AbortController();
    const out: string[] = [];
    const print = (t: string) => (out.push(t), ac.abort());
    await followChat(flaky, print, { signal: ac.signal, sleep: async (ms) => void slept.push(ms) });
    expect(slept).toEqual([1000, 2000]);
    expect(out).toHaveLength(1);
    const dead = { chatWait: async () => Promise.reject(new Error('no board "b"')), doc };
    slept.length = 0;
    await expect(followChat(dead, () => {}, { sleep: async (ms) => void slept.push(ms) })).rejects.toThrow('gave up after 3');
    expect(slept).toEqual([1000, 2000]);
  });
});
