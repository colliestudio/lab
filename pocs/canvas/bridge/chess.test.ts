import { describe, expect, it } from 'vitest';
import type { GameView } from '../src/plugins/chess/game';
import { gameText } from './chess';
import { Host, makeActor } from './host';

describe('chess through the bridge', () => {
  const claude = makeActor('Claude');
  const bot = makeActor('Bot');

  it('agents sit, move by notation, read the game; the cursor goes to the moved piece', () => {
    const h = new Host();
    expect(h.dispatch(claude, 'chess.newgame', { x: 0, y: 0 }).ok).toBe(true);
    const id = (h.view(claude, 'chess.state', {}) as GameView).board;
    h.dispatch(claude, 'chess.sit', { id, color: 'w' });
    h.dispatch(bot, 'chess.sit', { id, color: 'b' });
    const r = h.dispatch(claude, 'chess.move', { id, move: 'Nf3' });
    expect(r.ok).toBe(true);
    const knight = h.store.doc.get(r.select![0])!;
    expect(knight['x-chess']).toMatchObject({ piece: 'N', square: 'f3' });
    expect(h.dispatch(claude, 'chess.move', { id, move: 'e4' }).error).toMatch(/black is Bot's to move/);
    const v = h.view(bot, 'chess.state', {}) as GameView;
    expect(v).toMatchObject({ you: 'black', yourTurn: true, lastMove: 'Nf3', seats: { white: 'Claude', black: 'Bot' } });
    expect(gameText(v)).toContain('you play black: your move');
    expect(h.view(claude, 'chess.turn', {})).toBeUndefined();
    expect(h.store.log.toArray().at(-1)).toMatchObject({ text: 'played White Nf3', actor: { name: 'Claude' } });
  });

  it('wait resolves when the opponent moves', async () => {
    const h = new Host();
    h.dispatch(claude, 'chess.newgame', { x: 0, y: 0 });
    const id = (h.view(claude, 'chess.state', {}) as GameView).board;
    h.dispatch(claude, 'chess.sit', { id, color: 'w' });
    h.dispatch(bot, 'chess.sit', { id, color: 'b' });
    const waiting = h.wait(bot, 'chess.turn', {}, 2000);
    setTimeout(() => h.dispatch(claude, 'chess.move', { id, move: 'd4' }), 10);
    expect(((await waiting) as GameView).lastMove).toBe('d4');
    expect(await h.wait(claude, 'chess.turn', {}, 30)).toBeUndefined();
  });

  it('game fields round-trip through the canonical file', () => {
    const h = new Host();
    h.dispatch(claude, 'chess.newgame', { x: 0, y: 0 });
    const id = (h.view(claude, 'chess.state', {}) as GameView).board;
    h.dispatch(claude, 'chess.move', { id, move: 'e4' });
    const text = h.fileText();
    const h2 = new Host();
    h2.applyFile(text);
    expect((h2.view(claude, 'chess.state', {}) as GameView).fen).toBe((h.view(claude, 'chess.state', {}) as GameView).fen);
  });
});
