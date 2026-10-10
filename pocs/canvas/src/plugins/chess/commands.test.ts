import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, parse, serialize, type CanvasNode, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerChessLogic } from './index';
import { BOARD, FIELD, SQ, START, board, captureSlots, center, isBoard, isPiece, piece, squarePos } from './model';

function ctx(prefix = 'id'): CommandCtx {
  let n = 0;
  return { newId: () => `${prefix}${++n}`, random: () => 0.5 };
}
function store(c = ctx(), ydoc?: Y.Doc) {
  const s = new Store({ ctx: c, ydoc });
  registerCoreCommands(s);
  registerChessLogic(s);
  return s;
}
/** A store with one fresh chess set; returns the board id too. */
function withSet(s = store(), at = { x: 0, y: 0 }) {
  s.dispatch('chess.create', at);
  const b = s.doc.nodes.filter(isBoard).at(-1)!;
  return { s, b: b.id };
}
const at = (s: Store, b: string, sq: string) =>
  s.doc.nodes.find((n) => isPiece(n) && piece(n).board === b && piece(n).square === sq);
const label = (n: CanvasNode | undefined) => n && piece(n).color + piece(n).piece;
/** Drag a piece so its center lands at the center of `sq` (as core.move does), then drop it. */
function drag(s: Store, id: string, to: { x: number; y: number }) {
  const p = s.doc.get(id)!;
  const c = center(p);
  s.dispatch('core.move', { ids: [id], dx: to.x - c.x, dy: to.y - c.y });
  s.dispatch('chess.place', { ids: [id] }, { merge: true });
}
const sqCenter = (s: Store, b: string, sq: string) => {
  const pos = squarePos(s.doc.get(b)!, sq);
  return { x: pos.x + SQ / 2 + 7, y: pos.y + SQ / 2 - 9 }; // off-center on purpose
};

describe('chess commands', () => {
  it('create lays out a board and 32 pieces in the starting position, riding on it', () => {
    const { s, b } = withSet();
    const pieces = s.doc.nodes.filter(isPiece);
    expect(pieces).toHaveLength(32);
    expect(s.doc.riders(b)).toHaveLength(32);
    for (const [k, c, sq] of START) expect(label(at(s, b, sq))).toBe(c + k);
    expect(label(at(s, b, 'e1'))).toBe('wK');
    expect(label(at(s, b, 'd8'))).toBe('bQ');
    // pieces sit on their squares, above the board
    const e2 = at(s, b, 'e2')!;
    expect({ x: e2.x, y: e2.y }).toEqual(squarePos(s.doc.get(b)!, 'e2'));
    expect(s.doc.visible[0].id).toBe(b);
    // a second set goes next to the first, not on top of it
    const { b: b2 } = withSet(s);
    expect(s.doc.get(b2)!.x).toBeGreaterThanOrEqual(s.doc.get(b)!.x + BOARD);
  });

  it('a dropped piece snaps to the square under its center and marks the last move', () => {
    const { s, b } = withSet();
    const pawn = at(s, b, 'e2')!.id;
    drag(s, pawn, sqCenter(s, b, 'e4'));
    const p = s.doc.get(pawn)!;
    expect(piece(p)).toMatchObject({ board: b, square: 'e4' });
    expect({ x: p.x, y: p.y }).toEqual(squarePos(s.doc.get(b)!, 'e4'));
    expect(board(s.doc.get(b)!)).toMatchObject({ from: 'e2', to: 'e4' });
    // one undo step for drag + snap
    s.undo();
    expect(piece(s.doc.get(pawn)!).square).toBe('e2');
    expect(board(s.doc.get(b)!).to).toBeUndefined();
  });

  it('dropping on an occupied square captures: the occupant goes beside the board on its side', () => {
    const { s, b } = withSet();
    const knight = at(s, b, 'g1')!.id;
    const victim = at(s, b, 'd7')!.id;
    drag(s, knight, sqCenter(s, b, 'd7'));
    expect(piece(s.doc.get(knight)!).square).toBe('d7');
    const v = s.doc.get(victim)!;
    expect(piece(v).board).toBe(b); // still with the board
    expect(piece(v).square).toBeUndefined();
    expect({ x: v.x, y: v.y }).toEqual(captureSlots(s.doc.get(b)!, 'b')[0]);
    expect(v.y).toBeLessThan(s.doc.get(b)!.y); // black's side: above an unflipped board
    // the next capture of a black piece takes the next slot
    drag(s, knight, sqCenter(s, b, 'c7'));
    const v2 = s.doc.nodes.find((n) => isPiece(n) && piece(n).color === 'b' && piece(n).piece === 'P' && n.id !== victim && !piece(n).square)!;
    expect({ x: v2.x, y: v2.y }).toEqual(captureSlots(s.doc.get(b)!, 'b')[1]);
    // the whole capture is one undo step
    s.undo();
    s.undo();
    expect(piece(s.doc.get(victim)!).square).toBe('d7');
    expect(piece(s.doc.get(knight)!).square).toBe('g1');
  });

  it('a piece dropped beside the board stays with it; further away it lies free', () => {
    const { s, b } = withSet();
    const bd = s.doc.get(b)!;
    const q = at(s, b, 'd1')!.id;
    drag(s, q, { x: bd.x + 100, y: bd.y + BOARD + 60 });
    expect(piece(s.doc.get(q)!)).toEqual(expect.objectContaining({ board: b }));
    expect(piece(s.doc.get(q)!).square).toBeUndefined();
    drag(s, q, { x: bd.x + BOARD + 400, y: bd.y });
    expect(piece(s.doc.get(q)!).board).toBeUndefined();
    expect(s.doc.carrierOf(q)).toBeUndefined();
  });

  it('moving the board carries its pieces (squares, captures) but not free pieces', () => {
    const { s, b } = withSet();
    const bd = s.doc.get(b)!;
    const free = at(s, b, 'a2')!.id;
    drag(s, free, { x: bd.x - 600, y: bd.y });
    const before = s.doc.get(free)!;
    s.dispatch('core.move', { ids: [b], dx: 300, dy: -40 });
    const nb = s.doc.get(b)!;
    expect([nb.x, nb.y]).toEqual([bd.x + 300, bd.y - 40]);
    for (const p of s.doc.riders(b)) expect({ x: p.x, y: p.y }).toEqual(squarePos(nb, piece(p).square!));
    expect([s.doc.get(free)!.x, s.doc.get(free)!.y]).toEqual([before.x, before.y]);
  });

  it('flip turns the board around: same squares, mirrored positions, captures swap sides', () => {
    const { s, b } = withSet();
    drag(s, at(s, b, 'g1')!.id, sqCenter(s, b, 'g7')); // capture a black pawn
    s.dispatch('chess.flip', { id: b });
    const bd = s.doc.get(b)!;
    expect(board(bd).flipped).toBe(true);
    const k = at(s, b, 'e1')!;
    expect(label(k)).toBe('wK');
    expect(k.y).toBe(bd.y + 28); // white's back rank is now at the top
    const captured = s.doc.riders(b).find((p) => !piece(p).square)!;
    expect(captured.y).toBeGreaterThan(bd.y + BOARD); // black's captures now below
    // a drop on the flipped board resolves squares the flipped way
    const pawn = at(s, b, 'e2')!.id;
    drag(s, pawn, sqCenter(s, b, 'e4'));
    expect(piece(s.doc.get(pawn)!).square).toBe('e4');
    expect(s.doc.get(pawn)!.y).toBe(squarePos(bd, 'e4').y);
    s.dispatch('chess.flip', { id: b });
    expect(board(s.doc.get(b)!).flipped).toBeUndefined();
    expect(s.doc.get(pawn)!.y).toBe(squarePos(s.doc.get(b)!, 'e4').y);
  });

  it('setup gathers the set back from anywhere, replaces lost pieces, evicts strangers', () => {
    const { s, b } = withSet();
    const { b: b2 } = withSet(s);
    const bd = s.doc.get(b)!;
    drag(s, at(s, b, 'e2')!.id, sqCenter(s, b, 'e4'));
    drag(s, at(s, b, 'd1')!.id, sqCenter(s, b, 'e7')); // captures e7
    drag(s, at(s, b, 'a1')!.id, { x: bd.x - 900, y: bd.y }); // far away, free
    drag(s, at(s, b, 'h8')!.id, sqCenter(s, b2, 'h4')); // onto the other board
    s.dispatch('core.delete', { ids: [at(s, b, 'b8')!.id] }); // lost
    const stranger = at(s, b2, 'a2')!.id;
    drag(s, stranger, sqCenter(s, b, 'a2')); // captures b's own a2 pawn
    s.dispatch('chess.setup', { id: b });
    for (const [k, c, sq] of START) expect(label(at(s, b, sq))).toBe(c + k);
    expect(s.doc.riders(b).filter((p) => piece(p).square)).toHaveLength(32);
    expect(piece(s.doc.get(stranger)!).square).toBeUndefined();
    expect(piece(s.doc.get(stranger)!).board).toBe(b); // beside b, for its owner to take back
    expect(s.doc.nodes.filter((n) => isPiece(n) && piece(n).home === b)).toHaveLength(32);
    expect(board(s.doc.get(b)!).to).toBeUndefined();
    // the other board is untouched apart from the pieces that belonged to b
    expect(s.doc.riders(b2).filter((p) => piece(p).square)).toHaveLength(31);
    // pieces are above their board
    const zb = s.doc.get(b)!.z!;
    expect(s.doc.riders(b).every((p) => p.z! > zb)).toBe(true);
  });

  it('clear takes every piece off into the capture rows by color; lock toggles', () => {
    const { s, b } = withSet();
    s.dispatch('chess.clear', { id: b });
    const bd = s.doc.get(b)!;
    const rs = s.doc.riders(b);
    expect(rs).toHaveLength(32);
    expect(rs.every((p) => !piece(p).square)).toBe(true);
    expect(rs.filter((p) => piece(p).color === 'w').every((p) => p.y > bd.y + BOARD)).toBe(true);
    expect(rs.filter((p) => piece(p).color === 'b').every((p) => p.y < bd.y)).toBe(true);
    expect(new Set(rs.map((p) => `${p.x},${p.y}`)).size).toBe(32);
    s.dispatch('chess.lock', { id: b, locked: false });
    expect(board(s.doc.get(b)!).unlocked).toBe(true);
    s.dispatch('chess.lock', { id: b, locked: true });
    expect(board(s.doc.get(b)!).unlocked).toBeUndefined();
  });

  it('two boards on one table are independent', () => {
    const { s, b } = withSet();
    const { b: b2 } = withSet(s);
    drag(s, at(s, b, 'e2')!.id, sqCenter(s, b, 'e4'));
    s.dispatch('chess.flip', { id: b2 });
    s.dispatch('core.move', { ids: [b2], dx: 0, dy: 500 });
    expect(label(at(s, b2, 'e2'))).toBe('wP');
    expect(at(s, b2, 'e4')).toBeUndefined();
    expect(board(s.doc.get(b)!).flipped).toBeUndefined();
    expect(board(s.doc.get(b2)!).to).toBeUndefined();
    expect(s.doc.get(b)!.y).toBe(-BOARD / 2);
  });

  it('bad args are no-ops', () => {
    const { s } = withSet();
    for (const [name, args] of [
      ['chess.setup', { id: 'nope' }],
      ['chess.flip', null],
      ['chess.clear', { id: 3 }],
      ['chess.place', { ids: 'x' }],
      ['chess.create', { x: 'a', y: 0 }],
      ['chess.lock', { id: 'nope', locked: 1 }],
    ] as const)
      expect(s.dispatch(name, args).changes).toEqual([]);
  });

  it('round-trips through JSON Canvas with readable text', () => {
    const { s, b } = withSet();
    drag(s, at(s, b, 'e2')!.id, sqCenter(s, b, 'e4'));
    s.dispatch('chess.flip', { id: b });
    const text = serialize(s.exportDoc());
    const file = JSON.parse(text);
    const king = file.nodes.find((n: any) => n[FIELD]?.piece === 'K' && n[FIELD].color === 'w');
    expect(king).toMatchObject({ type: 'text', text: '♔ e1', [FIELD]: { piece: 'K', color: 'w', board: b, square: 'e1' } });
    expect(file.nodes.find((n: any) => n.id === b).text).toMatch(/^Chessboard/);
    expect(file.nodes.find((n: any) => n[FIELD]?.square === 'e4').text).toBe('♙ e4');
    const t = store(ctx('t'));
    t.load(parse(text));
    expect(JSON.parse(serialize(t.exportDoc()))).toEqual(file);
    expect(t.doc.riders(b)).toHaveLength(32);
  });

  it('import repairs bad chess data', () => {
    const s = store();
    const n = (id: string, f: unknown, extra = {}) => ({ id, type: 'text', x: 0, y: 0, width: 10, height: 10, [FIELD]: f, ...extra });
    s.load(
      parse(
        JSON.stringify({
          nodes: [
            n('b', { kind: 'board', flipped: 'yes', from: 'z9', to: 'e4' }),
            n('k', { piece: 'K', color: 'w', board: 'b', square: 'e1', home: 'b' }),
            n('k2', { piece: 'K', color: 'w', board: 'b', square: 'e1' }),
            n('q', { piece: 'Q', color: 'b', board: 'gone', square: 'd8', home: 'gone' }),
            n('sq', { piece: 'R', color: 'b', board: 'b', square: 'i9' }),
            n('junk', { piece: 'X', color: 'w' }),
            n('junk2', 'hello'),
          ],
          edges: [],
        }),
      ),
    );
    const d = s.doc;
    expect(board(d.get('b')!)).toEqual({ kind: 'board', to: 'e4' });
    expect(d.get('b')!.width).toBe(BOARD);
    expect(piece(d.get('k')!)).toEqual({ piece: 'K', color: 'w', board: 'b', square: 'e1', home: 'b' });
    expect(piece(d.get('k2')!)).toEqual({ piece: 'K', color: 'w', board: 'b' }); // square taken
    expect(piece(d.get('q')!)).toEqual({ piece: 'Q', color: 'b' });
    expect(piece(d.get('sq')!)).toEqual({ piece: 'R', color: 'b', board: 'b' });
    expect(d.get('q')!.text).toBe('♛');
    expect(d.get('junk')![FIELD]).toBeUndefined();
    expect(d.get('junk2')![FIELD]).toBeUndefined();
  });

  it('concurrent moves of different pieces on two peers both survive', () => {
    const a = store(ctx('a'));
    const { b } = withSet(a);
    const peer = store(ctx('p'), new Y.Doc());
    Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    drag(a, at(a, b, 'e2')!.id, sqCenter(a, b, 'e4'));
    drag(peer, at(peer, b, 'd7')!.id, sqCenter(peer, b, 'd5'));
    Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(peer.ydoc)));
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(peer.ydoc, Y.encodeStateVector(a.ydoc)));
    for (const st of [a, peer]) {
      expect(label(at(st, b, 'e4'))).toBe('wP');
      expect(label(at(st, b, 'd5'))).toBe('bP');
    }
  });

  it('spawn onto a square snaps, captures and joins the set; on the table it lies free', () => {
    const { s, b } = withSet();
    const victim = at(s, b, 'e7')!.id;
    const r = s.dispatch('chess.spawn', { piece: 'Q', color: 'w', ...sqCenter(s, b, 'e7') });
    const q = s.doc.get(r.select![0])!;
    expect(piece(q)).toEqual({ piece: 'Q', color: 'w', board: b, square: 'e7', home: b });
    expect({ x: q.x, y: q.y }).toEqual(squarePos(s.doc.get(b)!, 'e7'));
    expect(piece(s.doc.get(victim)!).square).toBeUndefined();
    expect(board(s.doc.get(b)!)).toMatchObject({ to: 'e7' });
    expect(q.text).toBe('♕ e7');
    s.undo(); // one step
    expect(s.doc.get(q.id)).toBeUndefined();
    expect(piece(s.doc.get(victim)!).square).toBe('e7');
    const f = s.dispatch('chess.spawn', { piece: 'N', color: 'b', x: 2000, y: 2000 });
    const n = s.doc.get(f.select![0])!;
    expect(piece(n)).toEqual({ piece: 'N', color: 'b' });
    expect([n.x + SQ / 2, n.y + SQ / 2]).toEqual([2000, 2000]);
    expect(s.dispatch('chess.spawn', { piece: 'X', color: 'w', x: 0, y: 0 }).changes).toEqual([]);
  });

  it('spawn beside a board lands in a free capture slot of its set; set up keeps extras aside', () => {
    const { s, b } = withSet();
    const r1 = s.dispatch('chess.spawn', { piece: 'Q', color: 'w', board: b, keepSelection: true });
    const r2 = s.dispatch('chess.spawn', { piece: 'Q', color: 'w', board: b, keepSelection: true });
    expect(r1.select).toBeUndefined();
    const [q1, q2] = [r1, r2].map((r) => s.doc.get((r.changes[0] as any).node.id)!);
    const slots = captureSlots(s.doc.get(b)!, 'w');
    expect([{ x: q1.x, y: q1.y }, { x: q2.x, y: q2.y }]).toEqual([slots[0], slots[1]]);
    expect(piece(q1)).toEqual({ piece: 'Q', color: 'w', board: b, home: b });
    // set up: 32 on squares, the two extra queens stay beside the board
    drag(s, q1.id, sqCenter(s, b, 'd4'));
    s.dispatch('chess.setup', { id: b });
    expect(s.doc.riders(b).filter((p) => piece(p).square)).toHaveLength(32);
    const extras = s.doc.riders(b).filter((p) => !piece(p).square);
    expect(extras).toHaveLength(2);
    expect(extras.every((p) => p.y > s.doc.get(b)!.y + BOARD)).toBe(true);
    // clear: all 34 off the squares (beyond 16 per color they share the last slot)
    s.dispatch('chess.clear', { id: b });
    expect(s.doc.riders(b)).toHaveLength(34);
    expect(s.doc.riders(b).every((p) => !piece(p).square)).toBe(true);
  });

  it('duplicate copies pieces offset, keeping board and set but not the square; boards refuse', () => {
    const { s, b } = withSet();
    const k = at(s, b, 'e1')!;
    const r = s.dispatch('core.duplicate', { ids: [k.id, b] });
    expect(r.select).toHaveLength(1);
    const c = s.doc.get(r.select![0])!;
    expect(piece(c)).toEqual({ piece: 'K', color: 'w', board: b, home: b });
    expect([c.x, c.y]).toEqual([k.x + 24, k.y + 24]);
    expect(at(s, b, 'e1')!.id).toBe(k.id);
    expect(s.doc.nodes.filter(isBoard)).toHaveLength(1);
    // dropping the copy snaps it like any piece
    drag(s, c.id, sqCenter(s, b, 'e4'));
    expect(piece(s.doc.get(c.id)!).square).toBe('e4');
    // delete removes pieces
    s.dispatch('core.delete', { ids: [c.id] });
    expect(s.doc.get(c.id)).toBeUndefined();
  });

  it('deleting a board deletes its riding pieces in one undo step', () => {
    const { s, b } = withSet();
    const free = at(s, b, 'a2')!.id;
    drag(s, free, { x: -2000, y: 0 });
    s.dispatch('core.delete', { ids: [b] });
    expect(s.doc.nodes.map((n) => n.id)).toEqual([free]);
    s.undo();
    expect(s.doc.nodes).toHaveLength(33);
  });

  it('reset table: every board back to its 32, extras and loose pieces deleted, one undo step', () => {
    const { s, b } = withSet();
    const { b: b2 } = withSet(s);
    s.dispatch('chess.flip', { id: b2 });
    drag(s, at(s, b, 'e2')!.id, sqCenter(s, b, 'e4'));
    drag(s, at(s, b, 'h8')!.id, sqCenter(s, b2, 'h4')); // b's rook on b2
    s.dispatch('chess.spawn', { piece: 'Q', color: 'w', board: b }); // extra
    s.dispatch('chess.spawn', { piece: 'N', color: 'b', x: 5000, y: 5000 }); // loose
    s.dispatch('core.duplicate', { ids: [at(s, b2, 'e1')!.id] }); // extra on b2
    s.dispatch('core.delete', { ids: [at(s, b, 'b1')!.id] }); // lost
    s.dispatch('core.reset', {});
    for (const id of [b, b2]) {
      for (const [k, c, sq] of START) expect(label(at(s, id, sq))).toBe(c + k);
      expect(s.doc.riders(id)).toHaveLength(32);
    }
    expect(s.doc.nodes.filter(isPiece)).toHaveLength(64);
    expect(board(s.doc.get(b2)!).flipped).toBe(true); // orientation kept
    s.undo();
    expect(s.doc.nodes.filter(isPiece)).toHaveLength(66);
  });
});
