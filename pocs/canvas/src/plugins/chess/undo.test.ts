import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, raise, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerClockLogic } from '../clock';
import { isClock } from '../clock/model';
import { registerChessLogic } from './index';
import { FILES, SQ, center, isBoard, isPiece, piece, squarePos } from './model';

// Undo/redo of chess gestures, alone and with another player changing things in between.

/** Deterministic pseudo-random numbers from a seed. */
function rng(seed: number) {
  let r = seed;
  return () => (r = (r * 1103515245 + 12345) % 2147483648) / 2147483648;
}
function store(prefix = 'id', ydoc?: Y.Doc) {
  let n = 0;
  const c: CommandCtx = { newId: () => `${prefix}${++n}`, random: () => 0.5 };
  const s = new Store({ ctx: c, ydoc });
  registerCoreCommands(s);
  registerChessLogic(s);
  registerClockLogic(s);
  return s;
}
/** Two players on one table: every update reaches the other side right away. */
function peers() {
  const da = new Y.Doc();
  const db = new Y.Doc();
  da.on('update', (u: Uint8Array, o: unknown) => o !== 'remote' && Y.applyUpdate(db, u, 'remote'));
  db.on('update', (u: Uint8Array, o: unknown) => o !== 'remote' && Y.applyUpdate(da, u, 'remote'));
  return [store('a', da), store('b', db)] as const;
}
const boardId = (s: Store) => s.doc.nodes.find(isBoard)!.id;
const at = (s: Store, sq: string) => s.doc.nodes.find((n) => isPiece(n) && piece(n).square === sq);
const sqCenter = (s: Store, sq: string) => {
  const p = squarePos(s.doc.get(boardId(s))!, sq);
  return { x: p.x + SQ / 2, y: p.y + SQ / 2 };
};
/** What the view does for a press-drag-drop: new undo step, raise (not undoable), moves merged, drop merged. */
function gesture(s: Store, ids: string[], to: { x: number; y: number }, steps = 3) {
  s.newUndoStep();
  s.select(ids);
  raise(s, ids);
  const c = center(s.doc.get(ids[0])!);
  let done = { x: 0, y: 0 };
  for (let i = 1; i <= steps; i++) {
    const t = { x: Math.round(((to.x - c.x) * i) / steps), y: Math.round(((to.y - c.y) * i) / steps) };
    s.dispatch('core.move', { ids, dx: t.x - done.x, dy: t.y - done.y }, { merge: true });
    done = t;
  }
  const pieces = ids.filter((id) => isPiece(s.doc.get(id)));
  if (pieces.length) s.merged(() => s.dispatch('chess.place', { ids: pieces }));
}
const norm = (v: any): any => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v);
/** Chess pieces and boards without z (raising isn't undone). */
const snap = (s: Store) =>
  JSON.stringify(
    s.doc.nodes
      .filter((n) => isPiece(n) || isBoard(n))
      .map(({ z: _z, ...n }) => norm(n))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
/** Broken states: a piece away from the square it says it is on, two pieces on one square. */
function problems(s: Store) {
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const p of s.doc.nodes.filter(isPiece)) {
    const f = piece(p);
    if (!f.square || !f.board) continue;
    const pos = squarePos(s.doc.get(f.board)!, f.square);
    if (pos.x !== p.x || pos.y !== p.y) out.push(`${p.id} says ${f.square} but stands at ${p.x},${p.y}`);
    const k = f.board + f.square;
    if (seen.has(k)) out.push(`${p.id} and ${seen.get(k)} both on ${f.square}`);
    seen.set(k, p.id);
  }
  return out;
}

describe('chess undo', () => {
  it('spawn, then a queen capture: one undo step each, restoring pieces fully; redo re-applies (clock running)', () => {
    const s = store();
    s.dispatch('chess.create', { x: 0, y: 0 });
    s.dispatch('clock.create', { x: 1200, y: 0 });
    const clockId = s.doc.nodes.find(isClock)!.id;
    s.dispatch('clock.tap', { id: clockId, side: 0, now: 1000 }, { undoable: false });
    const s0 = snap(s);
    s.dispatch('chess.spawn', { piece: 'N', color: 'b', ...sqCenter(s, 'd4') }); // palette drag onto d4
    const knight = at(s, 'd4')!.id;
    const s1 = snap(s);
    const queen = at(s, 'd1')!.id;
    s.dispatch('clock.tap', { id: clockId, side: 1, now: 2000 }, { undoable: false });
    gesture(s, [queen], sqCenter(s, 'd4'));
    s.dispatch('clock.tap', { id: clockId, side: 0, now: 3000 }, { undoable: false });
    expect(at(s, 'd4')!.id).toBe(queen);
    expect(piece(s.doc.get(knight)!).square).toBeUndefined();
    const s2 = snap(s);
    s.undo();
    expect(snap(s)).toBe(s1);
    s.undo();
    expect(snap(s)).toBe(s0);
    s.redo();
    expect(snap(s)).toBe(s1);
    s.redo();
    expect(snap(s)).toBe(s2);
  });

  it('random spawns, drags, captures, clicks, clock taps, flips: undo all then redo all retraces every step', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = rng(seed);
      const pickOne = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
      const s = store();
      s.dispatch('chess.create', { x: 0, y: 0 });
      s.dispatch('clock.create', { x: 1200, y: 0 });
      const b = boardId(s);
      const clockId = s.doc.nodes.find(isClock)!.id;
      s.undoManager.clear();
      const snaps = [snap(s)];
      let now = 1000;
      for (let k = 0; k < 8; k++) {
        const sq = () => sqCenter(s, pickOne([...FILES]) + (1 + Math.floor(rnd() * 8)));
        const before = s.undoManager.undoStack.length;
        const op = Math.floor(rnd() * 8);
        if (op === 0) s.dispatch('chess.spawn', { piece: pickOne(['Q', 'N', 'P']), color: pickOne(['w', 'b']), ...sq() });
        else if (op === 1) s.dispatch('chess.spawn', { piece: 'R', color: pickOne(['w', 'b']), board: b, keepSelection: true });
        else if (op <= 4) gesture(s, [pickOne(s.doc.nodes.filter(isPiece)).id], sq());
        else if (op === 5) s.dispatch('clock.tap', { id: clockId, side: pickOne([0, 1]), now: (now += 1000) }, { undoable: false });
        else if (op === 6) raise(s, [pickOne(s.doc.nodes.filter(isPiece)).id]);
        else s.dispatch('chess.flip', { id: b });
        if (s.undoManager.undoStack.length > before) snaps.push(snap(s));
      }
      for (let i = snaps.length - 2; i >= 0; i--) {
        s.undo();
        expect(snap(s), `seed ${seed} undo to ${i}`).toBe(snaps[i]);
      }
      for (let i = 1; i < snaps.length; i++) {
        s.redo();
        expect(snap(s), `seed ${seed} redo to ${i}`).toBe(snaps[i]);
      }
    }
  });

  it('undoing a capture after the other player moved the board puts the queen back on its square, not just its square name', () => {
    const [A, B] = peers();
    A.dispatch('chess.create', { x: 0, y: 0 });
    A.undoManager.clear();
    const queen = at(A, 'd1')!.id;
    const pawn = at(A, 'd7')!.id;
    gesture(A, [queen], sqCenter(A, 'd7'));
    const b = boardId(B);
    gesture(B, [b], { x: center(B.doc.get(b)!).x + 200, y: center(B.doc.get(b)!).y + 40 });
    A.undo();
    for (const s of [A, B]) {
      expect(problems(s)).toEqual([]);
      expect(piece(s.doc.get(queen)!).square).toBe('d1');
      expect(piece(s.doc.get(pawn)!).square).toBe('d7');
    }
    expect(snap(A)).toBe(snap(B));
  });

  it('undoing a board move after the other player moved one of its pieces keeps every piece on its square', () => {
    const [A, B] = peers();
    A.dispatch('chess.create', { x: 0, y: 0 });
    A.undoManager.clear();
    const b = boardId(A);
    const x0 = A.doc.get(b)!.x;
    gesture(A, [b], { x: center(A.doc.get(b)!).x + 300, y: center(A.doc.get(b)!).y });
    gesture(B, [at(B, 'e2')!.id], sqCenter(B, 'e4'));
    A.undo();
    expect(A.doc.get(b)!.x).toBe(x0);
    expect(problems(A)).toEqual([]);
    expect(at(A, 'e4')).toBeDefined();
  });

  it('an undo that puts a piece back on a square the other player took sets the restored piece aside', () => {
    const [A, B] = peers();
    A.dispatch('chess.create', { x: 0, y: 0 });
    A.undoManager.clear();
    const queen = at(A, 'd1')!.id;
    gesture(A, [queen], sqCenter(A, 'd5')); // d1 is free now
    const knight = at(B, 'b1')!.id;
    gesture(B, [knight], sqCenter(B, 'd1')); // B puts a knight there
    A.undo(); // the queen wants d1 back: B's knight keeps it
    for (const s of [A, B]) {
      expect(problems(s)).toEqual([]);
      expect(at(s, 'd1')!.id).toBe(knight);
      const q = piece(s.doc.get(queen)!);
      expect([q.board, q.square]).toEqual([boardId(s), undefined]);
    }
  });

  it('two players dropping on one square at once: both tables end with one piece there, the other captured', () => {
    const da = new Y.Doc();
    const db = new Y.Doc();
    const A = store('a', da);
    const B = store('b', db);
    A.dispatch('chess.create', { x: 0, y: 0 });
    Y.applyUpdate(db, Y.encodeStateAsUpdate(da));
    gesture(A, [at(A, 'e2')!.id], sqCenter(A, 'e4'));
    gesture(B, [at(B, 'd7')!.id], sqCenter(B, 'e4'));
    Y.applyUpdate(db, Y.encodeStateAsUpdate(da));
    Y.applyUpdate(da, Y.encodeStateAsUpdate(db));
    Y.applyUpdate(db, Y.encodeStateAsUpdate(da));
    for (const s of [A, B]) {
      expect(problems(s)).toEqual([]);
      expect(s.doc.nodes.filter((n) => isPiece(n) && piece(n).square === 'e4')).toHaveLength(1);
    }
    expect(snap(A)).toBe(snap(B));
  });

  it('undoing a table reset brings the pieces back but not the running clock', () => {
    const s = store();
    s.dispatch('chess.create', { x: 0, y: 0 });
    s.dispatch('clock.create', { x: 1200, y: 0 });
    const clockId = s.doc.nodes.find(isClock)!.id;
    gesture(s, [at(s, 'e2')!.id], sqCenter(s, 'e4'));
    s.dispatch('clock.tap', { id: clockId, side: 0, now: 1000 }, { undoable: false });
    const moved = snap(s);
    s.dispatch('core.reset', {});
    expect(at(s, 'e4')).toBeUndefined();
    s.undo();
    expect(snap(s)).toBe(moved);
    const c = s.doc.get(clockId)!['x-clock'] as Record<string, unknown>;
    expect([c.run, c.since]).toEqual([undefined, undefined]);
  });

  it('redo of an arrow-key nudge keeps the piece off-center (repairs snap only pieces off their square)', () => {
    const s = store();
    s.dispatch('chess.create', { x: 0, y: 0 });
    const p = at(s, 'e2')!.id;
    s.dispatch('core.move', { ids: [p], dx: 5, dy: 3 });
    s.dispatch('chess.place', { ids: [p], soft: true }, { merge: true });
    const nudged = snap(s);
    s.undo();
    s.redo();
    expect(snap(s)).toBe(nudged);
  });

  it('two players playing and undoing at random never leave a piece off its square or two on one square', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const rnd = rng(seed);
      const pickOne = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
      const [A, B] = peers();
      A.dispatch('chess.create', { x: 0, y: 0 });
      A.undoManager.clear();
      const b = boardId(A);
      const ops: string[] = [];
      for (let k = 0; k < 12; k++) {
        const s = rnd() < 0.5 ? A : B;
        const who = s === A ? 'A' : 'B';
        const sq = () => sqCenter(s, pickOne([...FILES]) + (1 + Math.floor(rnd() * 8)));
        const op = Math.floor(rnd() * 8);
        if (op === 0) s.dispatch('chess.spawn', { piece: 'Q', color: pickOne(['w', 'b']), ...sq() });
        else if (op <= 3) gesture(s, [pickOne(s.doc.nodes.filter(isPiece)).id], sq());
        else if (op === 4) raise(s, [pickOne(s.doc.nodes.filter(isPiece)).id]);
        else if (op === 5) gesture(s, [b], { x: center(s.doc.get(b)!).x + 40, y: center(s.doc.get(b)!).y });
        else if (op === 6) s.undo();
        else s.redo();
        ops.push(`${who} ${op}`);
        expect(problems(A), `seed ${seed}: ${ops.join(', ')}`).toEqual([]);
      }
      for (let i = 0; i < 14; i++) A.undo();
      expect(problems(A), `seed ${seed} undo all`).toEqual([]);
      for (let i = 0; i < 14; i++) A.redo();
      expect(problems(A), `seed ${seed} redo all`).toEqual([]);
      expect(snap(A)).toBe(snap(B));
    }
  });
});
