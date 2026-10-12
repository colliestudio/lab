import { describe, expect, it } from 'vitest';
import { chatArray, sendChat } from '../src/core/chat';
import { Host, makeActor } from './host';

const bot = makeActor('Bot');
const eve = makeActor('Eve');
const person = { id: 'p1', name: 'Alice', color: '#f00' };

describe('host chat', () => {
  it('say seats the actor and lands in the doc as an agent', () => {
    const h = new Host();
    h.say(bot, 'hello');
    expect(h.seated().map((a) => a.name)).toEqual(['Bot']);
    expect(chatArray(h.ydoc).get(0)).toMatchObject({ text: 'hello', from: { id: 'agent:bot', name: 'Bot', kind: 'agent' } });
    expect(() => h.say(bot, '   ')).toThrow(/empty/);
    expect(() => h.say(bot, 'hi', 'nope')).toThrow(/no such node/);
  });

  it('readChat: last N, or only new; own messages are never new; reading marks seen', () => {
    const h = new Host();
    for (let i = 1; i <= 5; i++) sendChat(h.ydoc, person, `m${i}`);
    expect(h.readChat(bot, { limit: 2 }).map((m) => m.text)).toEqual(['m4', 'm5']);
    expect(h.readChat(bot, { onlyNew: true })).toEqual([]);
    sendChat(h.ydoc, person, 'm6');
    h.say(bot, 'mine');
    sendChat(h.ydoc, person, 'm7');
    expect(h.readChat(bot, { onlyNew: true }).map((m) => m.text)).toEqual(['m6', 'm7']);
    expect(h.readChat(bot, { onlyNew: true })).toEqual([]);
  });

  it('say does not skip what others said before it (cursor moves on read only)', () => {
    const h = new Host();
    h.say(bot, 'first'); // bot's cursor starts here
    sendChat(h.ydoc, person, 'a');
    h.say(bot, 'reply');
    sendChat(h.ydoc, person, 'b');
    expect(h.readChat(bot, { onlyNew: true }).map((m) => m.text)).toEqual(['a', 'b']);
  });

  it('waitChat: resolves on the next message from someone else, with the first-ever message too', async () => {
    const h = new Host();
    const w = h.waitChat(bot, 5000); // empty chat: first contact
    h.say(bot, 'ignored: mine');
    sendChat(h.ydoc, person, 'ping');
    expect((await w)!.map((m) => m.text)).toEqual(['ping']);
    expect(await h.waitChat(bot, 30)).toBeUndefined(); // seen now; times out
  });

  it('waitChat returns what is already waiting; two waiters both get a message', async () => {
    const h = new Host();
    h.readChat(bot);
    h.readChat(eve);
    const a = h.waitChat(bot, 5000);
    const b = h.waitChat(eve, 5000);
    sendChat(h.ydoc, person, 'hey @Bot @Eve');
    expect((await a)![0].text).toBe('hey @Bot @Eve');
    expect((await b)![0].text).toBe('hey @Bot @Eve');
    sendChat(h.ydoc, person, 'later');
    expect((await h.waitChat(bot, 30))!.map((m) => m.text)).toEqual(['later']);
  });

  it('a message about a node moves the actor cursor there', () => {
    const h = new Host();
    h.dispatch(bot, 'board.add', { type: 'text', text: 'Deck', x: 10, y: 20 });
    const id = h.store.doc.nodes[0].id;
    const m = h.say(eve, 'look at this', id);
    expect(m.node).toBe(id);
  });
});
