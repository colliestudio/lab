import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, type CommandCtx, type LogActor } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { findBoard, gameView } from './game';
import { registerChessLogic } from './logic';
import { SQ, board, center, isBoard, isPiece, piece, squarePos } from './model';

function ctx(): CommandCtx {
  let n = 0;
  return { newId: () => `id${++n}`, random: () => 0.5 };
}
const alice: LogActor = { id: 'p:alice', name: 'Alice', color: '#f00' };
const bot: LogActor = { id: 'agent:bot', name: 'Bot', color: '#00f' };

/** A store on a shared doc acting as `who` (like the bridge: one store per actor). */
function seat(ydoc: Y.Doc, who: LogActor | null) {
  const s = new Store({ ctx: ctx(), ydoc });
  registerCoreCommands(s);
  registerChessLogic(s);
  s.actor = () => who;
  return s;
}
function game() {
  const ydoc = new Y.Doc();
  const a = seat(ydoc, alice);
  const b = seat(ydoc, bot);
  a.dispatch('chess.newgame', { x: 0, y: 0 });
  const id = a.doc.nodes.find(isBoard)!.id;
  return { a, b, id };
}
const at = (s: Store, b: string, sq: string) => s.doc.nodes.find((n) => isPiece(n) && piece(n).board === b && piece(n).square === sq);
function drag(s: Store, id: string, b: string, sq: string) {
  const p = s.doc.get(id)!;
  const c = center(p);
  const t = squarePos(s.doc.get(b)!, sq);
  s.dispatch('core.move', { ids: [id], dx: t.x + SQ / 2 + 5 - c.x, dy: t.y + SQ / 2 - 5 - c.y });
  return s.dispatch('chess.place', { ids: [id] }, { merge: true });
}

describe('chess rules mode', () => {
  it('newgame: a set with rules on, white to move', () => {
    const { a, id } = game();
    const v = gameView(a.doc, findBoard(a.doc), alice);
    expect(v.rules).toBe(true);
    expect(v.fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(v.legal).toHaveLength(20);
    expect(v.yourTurn).toBe(true);
    expect(board(a.doc.get(id)!).turn).toBe('w');
  });

  it('move by notation: pieces, turn, history, log; illegal and out-of-turn moves fail with a reason', () => {
    const { a, b, id } = game();
    expect(a.dispatch('chess.move', { id, move: 'e2e4' }).ok).toBe(true);
    expect(at(a, id, 'e4') && piece(at(a, id, 'e4')!).piece).toBe('P');
    expect(at(a, id, 'e2')).toBeUndefined();
    const r = b.dispatch('chess.move', { id, move: 'e5' });
    expect(r.ok).toBe(true);
    const bad = a.dispatch('chess.move', { id, move: 'Ke3' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/illegal move "Ke3" for white; legal: .*Nf3/);
    const v = gameView(a.doc, a.doc.get(id)!);
    expect(v.moves).toBe('1. e4 e5');
    expect(v.fen).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2');
    expect(a.log.toArray().map((e) => `${e.actor?.name}: ${e.text}`).slice(-2)).toEqual(['Alice: played White e4', 'Bot: played Black e5']);
  });

  it('seats: only the seated player moves its color; one color per player; taken seats stay taken', () => {
    const { a, b, id } = game();
    expect(b.dispatch('chess.sit', { id, color: 'b' }).ok).toBe(true);
    expect(a.dispatch('chess.sit', { id, color: 'b' }).error).toMatch(/black is taken by Bot/);
    expect(b.dispatch('chess.move', { id, move: 'e4' }).error).toMatch(/you play black/);
    a.dispatch('chess.move', { id, move: 'e4' });
    expect(a.dispatch('chess.move', { id, move: 'e5' }).error).toMatch(/black is Bot's to move/);
    expect(gameView(b.doc, b.doc.get(id)!, bot)).toMatchObject({ you: 'black', yourTurn: true, seats: { black: 'Bot' } });
    expect(gameView(a.doc, a.doc.get(id)!, alice).yourTurn).toBe(false);
    b.dispatch('chess.sit', { id, color: 'w' });
    expect(board(a.doc.get(id)!)).toMatchObject({ white: { id: bot.id, name: 'Bot' } });
    expect(board(a.doc.get(id)!).black).toBeUndefined();
  });

  it('captures, castling, en passant, promotion move the right nodes', () => {
    const { a, id } = game();
    for (const m of ['e4', 'd5', 'exd5', 'Nf6', 'Nf3', 'c5', 'dxc6', 'e6', 'Bb5', 'Bd7', 'O-O', 'Qb6', 'cxb7', 'Nc6', 'bxa8=Q']) {
      const r = a.dispatch('chess.move', { id, move: m });
      expect(r.error).toBeUndefined();
    }
    expect(piece(at(a, id, 'g1')!).piece).toBe('K');
    expect(piece(at(a, id, 'f1')!).piece).toBe('R');
    const q = at(a, id, 'a8')!;
    expect(piece(q)).toMatchObject({ piece: 'Q', color: 'w' });
    expect(q.text).toBe('♕ a8');
    // captured pieces lie beside the board, still part of it, no square
    const aside = a.doc.nodes.filter((n) => isPiece(n) && piece(n).board === id && !piece(n).square);
    expect(aside.map((n) => piece(n).color + piece(n).piece).sort()).toEqual(['bP', 'bP', 'bP', 'bR']);
    expect(gameView(a.doc, a.doc.get(id)!).moves).toBe('1. e4 d5 2. exd5 Nf6 3. Nf3 c5 4. dxc6 e6 5. Bb5 Bd7 6. O-O Qb6 7. cxb7 Nc6 8. bxa8=Q+');
  });

  it('checkmate ends the game; no moves after', () => {
    const { a, id } = game();
    for (const m of ['f3', 'e5', 'g4', 'Qh4']) a.dispatch('chess.move', { id, move: m });
    const v = gameView(a.doc, a.doc.get(id)!);
    expect(v).toMatchObject({ result: '0-1', end: 'checkmate', yourTurn: false, legal: [], check: true });
    expect(a.log.toArray().at(-1)!.text).toBe('played Black Qh4# (checkmate, 0-1)');
    expect(a.dispatch('chess.move', { id, move: 'a3' }).error).toMatch(/game is over/);
  });

  it('drag: a legal drop plays the move; an illegal one bounces back; out of turn bounces', () => {
    const { a, b, id } = game();
    const pawn = at(a, id, 'e2')!.id;
    drag(a, pawn, id, 'e5'); // three squares: illegal
    expect(piece(a.doc.get(pawn)!).square).toBe('e2');
    expect(a.doc.get(pawn)!.x).toBe(squarePos(a.doc.get(id)!, 'e2').x);
    drag(a, pawn, id, 'e4');
    expect(piece(a.doc.get(pawn)!).square).toBe('e4');
    expect(board(a.doc.get(id)!).turn).toBe('b');
    const knight = at(a, id, 'g1')!.id;
    drag(a, knight, id, 'f3'); // black to move
    expect(piece(a.doc.get(knight)!).square).toBe('g1');
    b.dispatch('chess.sit', { id, color: 'b' });
    const bp = at(a, id, 'e7')!.id;
    drag(a, bp, id, 'e5'); // Alice can't move Bot's pieces
    expect(piece(a.doc.get(bp)!).square).toBe('e7');
    // plain undo is off in a rules game; takeback restores it
    expect(a.undoBlocked()).toMatch(/takeback/);
    const told: string[] = [];
    a.onUndoRefused = (why) => told.push(why); // the app shows this to the player
    expect(a.undo()).toBe(false);
    expect(told).toHaveLength(1);
    expect(piece(a.doc.get(pawn)!).square).toBe('e4');
    expect(a.dispatch('chess.takeback', { id }).ok).toBe(true);
    expect(piece(a.doc.get(pawn)!).square).toBe('e2');
    expect(board(a.doc.get(id)!).turn).toBe('w');
  });

  describe('undo around a rules game', () => {
    const note = { id: 'n1', type: 'text', x: 5000, y: 0, width: 100, height: 50, text: 'hi' };
    it('a chess step is skipped, so undo still reaches the steps below it', () => {
      const { a, id } = game();
      a.dispatch('core.add', { nodes: [note] });
      a.dispatch('chess.move', { id, move: 'e4' });
      const told: string[] = [];
      a.onUndoRefused = (w) => told.push(w);
      expect(a.undo()).toBe(true); // skips e4 (says why), undoes the note
      expect(told[0]).toMatch(/takeback/);
      expect(a.doc.get('n1')).toBeUndefined();
      expect(board(a.doc.get(id)!).moves).toEqual(['e4']);
      expect(a.undo()).toBe(false);
    });
    it('reset table is undone whole, rules board included', () => {
      const { a, id } = game();
      a.dispatch('chess.move', { id, move: 'e4' });
      a.dispatch('core.reset', {});
      expect(board(a.doc.get(id)!).moves).toBeUndefined();
      expect(a.undo()).toBe(true);
      expect(board(a.doc.get(id)!).moves).toEqual(['e4']);
      expect(piece(at(a, id, 'e4')!).piece).toBe('P');
    });
  });

  describe('takeback', () => {
    const play = (s: Store, id: string, ...ms: string[]) => ms.forEach((m) => expect(s.dispatch('chess.move', { id, move: m }).ok).toBe(true));
    const sans = (s: Store, id: string) => board(s.doc.get(id)!).moves;

    it('seated: undoes your move and the reply, pieces and fields', () => {
      const { a, b, id } = game();
      a.dispatch('chess.sit', { id, color: 'w' });
      b.dispatch('chess.sit', { id, color: 'b' });
      const before = JSON.stringify(a.doc.nodes.filter((n) => isPiece(n)).map((n) => [n.id, n.x, n.y, piece(n).square]));
      play(a, id, 'e4');
      play(b, id, 'e5');
      play(a, id, 'Nf3');
      play(b, id, 'Nc6');
      // an undo after the bot replied is refused: it would corrupt the game
      expect(a.undo()).toBe(false);
      expect(b.undo()).toBe(false);
      expect(a.dispatch('chess.takeback', { id }).ok).toBe(true);
      expect(sans(a, id)).toEqual(['e4', 'e5']);
      expect(board(a.doc.get(id)!)).toMatchObject({ turn: 'w', full: 2, from: 'e7', to: 'e5' });
      expect(at(a, id, 'f3')).toBeUndefined();
      expect(at(a, id, 'g1')).toBeDefined();
      expect(at(a, id, 'b8')).toBeDefined();
      expect(gameView(a.doc, a.doc.get(id)!).fen).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2');
      // Bot's takeback: back to just before its own move
      expect(b.dispatch('chess.takeback', { id }).ok).toBe(true);
      expect(sans(b, id)).toEqual(['e4']);
      expect(board(b.doc.get(id)!).turn).toBe('b');
      // all the way
      expect(a.dispatch('chess.takeback', { id }).ok).toBe(true);
      expect(sans(a, id)).toBeUndefined();
      expect(JSON.stringify(a.doc.nodes.filter((n) => isPiece(n)).map((n) => [n.id, n.x, n.y, piece(n).square]))).toBe(before);
      expect(a.dispatch('chess.takeback', { id }).error).toMatch(/no moves/);
    });

    it('brings back a captured piece, an undone promotion becomes a pawn again, castling rights return', () => {
      const { a, id } = game();
      play(a, id, 'e4', 'd5', 'exd5', 'Nf6', 'Nf3', 'c5', 'dxc6', 'e6', 'Bb5', 'Bd7', 'O-O', 'Qb6', 'cxb7', 'Nc6');
      const fen = gameView(a.doc, a.doc.get(id)!).fen;
      play(a, id, 'bxa8=Q+');
      expect(at(a, id, 'a8') && piece(at(a, id, 'a8')!).piece).toBe('Q');
      a.dispatch('chess.takeback', { id }); // hot seat: the last move only
      expect(gameView(a.doc, a.doc.get(id)!).fen).toBe(fen);
      expect(piece(at(a, id, 'b7')!).piece).toBe('P');
      expect(piece(at(a, id, 'a8')!).piece).toBe('R');
      expect(a.doc.nodes.filter((n) => isPiece(n) && piece(n).board === id).length).toBe(32);
      // the castling move comes back with its rook and rights
      for (let i = 0; i < 4; i++) a.dispatch('chess.takeback', { id });
      expect(sans(a, id)!.at(-1)).toBe('Bd7');
      expect(piece(at(a, id, 'e1')!).piece).toBe('K');
      expect(piece(at(a, id, 'h1')!).piece).toBe('R');
      expect(board(a.doc.get(id)!).castling).toBe('KQkq');
    });

    it('only seated players take back when both seats are taken; not before you moved; not in free play', () => {
      const { a, b, id } = game();
      const carol = seat(a.ydoc, { id: 'p:carol', name: 'Carol', color: '#0f0' });
      play(a, id, 'e4');
      b.dispatch('chess.sit', { id, color: 'w' });
      a.dispatch('chess.sit', { id, color: 'b' });
      expect(carol.dispatch('chess.takeback', { id }).error).toMatch(/only the players/);
      expect(a.dispatch('chess.takeback', { id }).error).toMatch(/not moved/);
      a.dispatch('chess.rules', { id, on: false });
      expect(a.dispatch('chess.takeback', { id }).error).toMatch(/free play/);
    });

    it('rules turned on mid-game: the record starts there and takeback replays from it', () => {
      const { a, id } = game();
      a.dispatch('chess.rules', { id, on: false });
      drag(a, at(a, id, 'e2')!.id, id, 'e4'); // free play move
      a.dispatch('chess.rules', { id, on: true, turn: 'b' });
      play(a, id, 'e5', 'Nf3');
      a.dispatch('chess.takeback', { id });
      a.dispatch('chess.takeback', { id });
      expect(sans(a, id)).toBeUndefined();
      expect(piece(at(a, id, 'e4')!).piece).toBe('P');
      expect(board(a.doc.get(id)!).turn).toBe('b');
      expect(at(a, id, 'e7')).toBeDefined();
    });

    it('refuses when the pieces no longer match the record', () => {
      const { a, id } = game();
      play(a, id, 'e4', 'e5');
      a.dispatch('chess.rules', { id, on: false });
      drag(a, at(a, id, 'a2')!.id, id, 'a3');
      a.dispatch('chess.rules', { id, on: true, turn: 'w' }); // the record restarts here
      expect(a.dispatch('chess.takeback', { id }).error).toMatch(/no moves/);
    });
  });

  it('a piece dragged off a rules board goes back; free-play boards are unchanged', () => {
    const { a, id } = game();
    const pawn = at(a, id, 'a2')!.id;
    a.dispatch('core.move', { ids: [pawn], dx: -2000, dy: 0 });
    a.dispatch('chess.place', { ids: [pawn] }, { merge: true });
    expect(piece(a.doc.get(pawn)!).square).toBe('a2');
    a.dispatch('chess.rules', { id, on: false });
    a.dispatch('core.move', { ids: [pawn], dx: -2000, dy: 0 });
    a.dispatch('chess.place', { ids: [pawn] }, { merge: true });
    expect(piece(a.doc.get(pawn)!).square).toBeUndefined();
  });

  it('set up and reset start a fresh game; game fields survive a file round trip', () => {
    const { a, id } = game();
    a.dispatch('chess.move', { id, move: 'd4' });
    a.dispatch('chess.setup', { id });
    expect(gameView(a.doc, a.doc.get(id)!).fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    a.dispatch('chess.move', { id, move: 'd4' });
    a.dispatch('chess.sit', { id, color: 'w' });
    const s2 = seat(new Y.Doc(), alice);
    s2.load(JSON.parse(JSON.stringify(a.exportDoc())));
    expect(board(s2.doc.get(id)!)).toMatchObject({ rules: true, turn: 'b', moves: ['d4'], white: { name: 'Alice' }, ep: 'd3' });
    a.dispatch('core.reset', {});
    expect(board(a.doc.get(id)!)).toMatchObject({ turn: 'w', full: 1 });
    expect(board(a.doc.get(id)!).moves).toBeUndefined();
  });

  it('resign', () => {
    const { a, b, id } = game();
    b.dispatch('chess.sit', { id, color: 'b' });
    expect(a.dispatch('chess.resign', { id, color: 'b' }).ok).toBe(false);
    b.dispatch('chess.resign', { id });
    expect(board(a.doc.get(id)!)).toMatchObject({ result: '1-0', end: 'black resigned' });
  });
});

describe('chess seats', () => {
  it('anyone can free a seat with force; leave alone only frees your own', () => {
    const { a, b, id } = game();
    b.dispatch('chess.sit', { id, color: 'b' });
    a.dispatch('chess.sit', { id, color: 'b', leave: true });
    expect(board(a.doc.get(id)!).black?.name).toBe('Bot');
    a.dispatch('chess.sit', { id, color: 'b', leave: true, force: true });
    expect(board(a.doc.get(id)!).black).toBeUndefined();
    expect(a.log.toArray().at(-1)!.text).toBe('freed the black seat (Bot)');
  });
});

describe('new game after a promotion', () => {
  it('starts with exactly 32 pieces (the promoted queen goes, a pawn comes back)', () => {
    const { a, id } = game();
    for (const m of ['h4', 'g5', 'hxg5', 'h6', 'gxh6', 'Bg7', 'hxg7', 'a6', 'gxh8=Q']) expect(a.dispatch('chess.move', { id, move: m }).error).toBeUndefined();
    a.dispatch('chess.newgame', { id });
    const mine = a.doc.nodes.filter((n) => isPiece(n) && piece(n).board === id);
    expect(mine).toHaveLength(32);
    expect(mine.every((n) => piece(n).square)).toBe(true);
    expect(gameView(a.doc, a.doc.get(id)!).fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });
});
