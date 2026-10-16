import { describe, expect, it } from 'vitest';
import { Host, makeActor } from '../../../bridge/host';
import type { GameView } from './game';
import { gameText } from './text';

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

  it('undo is refused in a rules game; takeback restores the position (also after the reply)', () => {
    const h = new Host();
    h.dispatch(claude, 'chess.newgame', { x: 0, y: 0 });
    const id = (h.view(claude, 'chess.state', {}) as GameView).board;
    h.dispatch(claude, 'chess.sit', { id, color: 'w' });
    h.dispatch(bot, 'chess.sit', { id, color: 'b' });
    h.dispatch(claude, 'chess.move', { id, move: 'e4' });
    h.dispatch(bot, 'chess.move', { id, move: 'e5' });
    expect(() => h.undo(claude)).toThrow(/takeback/);
    expect(() => h.undo(bot)).toThrow(/takeback/);
    expect((h.view(claude, 'chess.state', {}) as GameView).moves).toBe('1. e4 e5');
    expect(h.dispatch(claude, 'chess.takeback', { id }).ok).toBe(true);
    const v = h.view(claude, 'chess.state', {}) as GameView;
    expect(v).toMatchObject({ moves: '', yourTurn: true, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' });
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

  it('agent calls: described commands are checked, run as the seat, and answer with the game', () => {
    const h = new Host();
    const g = h.run(claude, 'chess.newgame', {});
    expect(g).toMatchObject({ ok: true });
    expect(h.run(claude, 'chess.sit', { color: 'white' })).toMatchObject({ ok: true });
    const m = h.run(claude, 'chess.move', { move: 'e4' });
    expect(m).toMatchObject({ ok: true, result: { you: 'white', lastMove: 'e4' } });
    expect((m as { text: string }).text).toContain('1. e4');
    expect(h.run(claude, 'chess.move', { move: 'e5' })).toMatchObject({ ok: false, error: expect.stringMatching(/Black to move/) });
  });

  it('bad args name the field and give the example', () => {
    const h = new Host();
    h.run(claude, 'chess.newgame', {});
    const r = h.run(claude, 'chess.move', {});
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('chess.move: args.move: expected string, received undefined');
    expect((r as { error: string }).error).toContain('Example: {"move":"Nf3"}');
    expect((r as { error: string }).error).toContain('canvas_help {"plugin":"chess","command":"chess.move"}');
  });

  it('views check their args; unknown views list the known ones', () => {
    const h = new Host();
    h.run(claude, 'chess.newgame', {});
    expect(() => h.view(claude, 'chess.state', { board: 3 })).toThrow(/args\.board: expected string/);
    expect(() => h.view(claude, 'chess.nope', {})).toThrow(/chess has: chess\.state, chess\.turn/);
  });

  it('a command without a spec runs unchecked, marked undescribed, and help lists it', () => {
    const h = new Host();
    h.run(claude, 'chess.newgame', {});
    expect(h.run(claude, 'chess.repair', {})).toMatchObject({ ok: true, undescribed: true });
    expect(h.catalog.plugin('chess')!.undescribed).toContain('chess.repair');
    expect(h.catalog.helpText('chess')).toContain('Not described yet');
  });

  it('chess.turn is empty until it is your move', () => {
    const h = new Host();
    h.run(claude, 'chess.newgame', {});
    h.run(claude, 'chess.sit', { color: 'white' });
    h.run(bot, 'chess.sit', { color: 'black' });
    expect(h.view(bot, 'chess.turn', {})).toBeUndefined();
    expect(h.view(claude, 'chess.turn', {})).toMatchObject({ yourTurn: true });
  });
});
