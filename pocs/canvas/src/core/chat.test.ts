import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CHAT_CAP, CHAT_MAX_TEXT, after, chatArray, chatLine, mentions, sendChat, splitMentions, unread, validMessage } from './chat';

const alice = { id: 'alice', name: 'Alice', color: '#f00' };
const bot = { id: 'agent:bot', name: 'Bot W', color: '#0f0', kind: 'agent' as const };

describe('chat', () => {
  it('sends, trims, ignores empty, cuts long text', () => {
    const d = new Y.Doc();
    expect(sendChat(d, alice, '   ')).toBeNull();
    const m = sendChat(d, alice, '  hi  ', { node: 'n1', now: 5 })!;
    expect(m).toMatchObject({ text: 'hi', node: 'n1', time: 5, from: alice });
    expect(sendChat(d, bot, 'x'.repeat(CHAT_MAX_TEXT + 50))!.text).toHaveLength(CHAT_MAX_TEXT);
    expect(chatArray(d).toArray().map((x) => x.from.name)).toEqual(['Alice', 'Bot W']);
    expect(chatArray(d).get(1).from.kind).toBe('agent');
    expect(chatArray(d).get(0).from).not.toHaveProperty('kind');
  });

  it('caps at CHAT_CAP, dropping the oldest', () => {
    const d = new Y.Doc();
    for (let i = 0; i < CHAT_CAP + 5; i++) sendChat(d, alice, `m${i}`);
    const all = chatArray(d).toArray();
    expect(all).toHaveLength(CHAT_CAP);
    expect(all[0].text).toBe('m5');
    expect(all.at(-1)!.text).toBe(`m${CHAT_CAP + 4}`);
  });

  it('syncs between docs and ids are unique', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u) => Y.applyUpdate(b, u));
    b.on('update', (u) => Y.applyUpdate(a, u));
    sendChat(a, alice, 'one');
    sendChat(b, bot, 'two');
    sendChat(a, alice, 'three');
    expect(chatArray(a).toArray().map((m) => m.text)).toEqual(chatArray(b).toArray().map((m) => m.text));
    expect(new Set(chatArray(a).toArray().map((m) => m.id)).size).toBe(3);
  });

  it('after / unread: from a seen id, others only; unknown id = everything', () => {
    const d = new Y.Doc();
    const m1 = sendChat(d, alice, '1')!;
    const m2 = sendChat(d, bot, '2')!;
    sendChat(d, alice, '3');
    const all = chatArray(d).toArray();
    expect(after(all, m1.id).map((m) => m.text)).toEqual(['2', '3']);
    expect(after(all, undefined)).toHaveLength(3);
    expect(after(all, 'gone')).toHaveLength(3);
    expect(after(all, all[2].id)).toEqual([]);
    expect(unread(all, m1.id, 'alice').map((m) => m.text)).toEqual(['2']);
    expect(unread(all, m2.id, 'alice')).toEqual([]);
    expect(unread(all, undefined, 'agent:bot').map((m) => m.text)).toEqual(['1', '3']);
  });

  it('mentions: by name (spaces ok), case-insensitive, @all, not inside words or longer names', () => {
    expect(mentions('hey @alice, your move', 'Alice')).toBe(true);
    expect(mentions('@Bot W play e4', 'Bot W')).toBe(true);
    expect(mentions('(@bot w)', 'Bot W')).toBe(true);
    expect(mentions('@Bot Wally', 'Bot W')).toBe(false);
    expect(mentions('mail me@alice.com', 'Alice')).toBe(false);
    expect(mentions('@alicia hi', 'Alice')).toBe(false);
    expect(mentions('@all lunch?', 'Zed')).toBe(true);
    expect(mentions('hello', '')).toBe(false);
    expect(mentions('a+b @C++', 'C++')).toBe(true);
  });

  it('splitMentions cuts text around known names, longest first', () => {
    expect(splitMentions('hi @Bot W and @Bot, ok', ['Bot', 'Bot W'])).toEqual([
      { text: 'hi ' },
      { text: '@Bot W', mention: 'Bot W' },
      { text: ' and ' },
      { text: '@Bot', mention: 'Bot' },
      { text: ', ok' },
    ]);
    expect(splitMentions('plain', ['Bot'])).toEqual([{ text: 'plain' }]);
    expect(splitMentions('@ALL go', [])).toEqual([{ text: '@ALL', mention: 'ALL' }, { text: ' go' }]);
    expect(splitMentions('x@Bot', ['Bot'])).toEqual([{ text: 'x@Bot' }]);
  });

  it('chatLine and validMessage', () => {
    const d = new Y.Doc();
    const m = sendChat(d, bot, 'hello', { node: 'n1', now: Date.UTC(2026, 9, 12, 12, 3) })!;
    expect(chatLine(m, 'Deck')).toBe('[12:03] Bot W (agent): hello  (re: Deck)');
    expect(validMessage(m)).toBe(true);
    expect(validMessage({ id: 1 })).toBe(false);
    expect(validMessage(null)).toBe(false);
  });
});
