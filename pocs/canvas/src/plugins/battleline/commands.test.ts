import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, parse, serialize, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerCardsLogic } from '../cards';
import { card, cardsIn, isCard, isHand, isHomeDeck, packOf } from '../cards/deck';
import { registerBattleLineLogic } from './index';
import { DEAL_FACE_UP, flags, formation, handOf, troopsDeck } from './commands';
import { CLAIM_DY, TACTICS, TROOPS, flag, isFlag } from './model';

function ctx(seed = 1): CommandCtx {
  let n = 0;
  let s = seed;
  return { newId: () => `id${++n}`, random: () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646 };
}
function store(ydoc?: Y.Doc, seed = 1) {
  const s = new Store({ ctx: ctx(seed), ydoc });
  registerCoreCommands(s);
  registerCardsLogic(s);
  registerBattleLineLogic(s);
  return s;
}
function table() {
  const s = store();
  s.dispatch('battleline.setup', { x: 0, y: 0 });
  return s;
}
const homeOf = (s: Store, pack: string) => s.doc.nodes.find((n) => isHomeDeck(n) && packOf(n) === pack)!;
const alice = { id: 'alice', label: "Alice's hand", color: '#3cb44b' };
const bob = { id: 'bob', label: "Bob's hand", color: '#e6194b' };

describe('battle line', () => {
  it('setup: 60 troops and 10 tactics in two shuffled decks, 9 flags, 18 formations, a discard pile', () => {
    const s = table();
    const troops = cardsIn(s.doc, homeOf(s, TROOPS).id);
    const tactics = cardsIn(s.doc, homeOf(s, TACTICS).id);
    expect(troops).toHaveLength(60);
    expect(tactics).toHaveLength(10);
    expect(new Set(troops.map((c) => card(c).face)).size).toBe(60);
    expect(troops.every((c) => !card(c).faceUp)).toBe(true);
    expect(troops.map((c) => card(c).face).slice(0, 10)).not.toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10']);
    expect(flags(s.doc).map((n) => flag(n).n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(s.doc.nodes.filter((n) => (n['x-battleline'] as any)?.role === 'formation')).toHaveLength(18);
    expect(s.doc.nodes.filter((n) => (n['x-battleline'] as any)?.role === 'discard')).toHaveLength(1);
    // flags sit in a row between the two sides' formations
    const f1 = flags(s.doc)[0];
    expect(formation(s.doc, 1, 'b')!.y + formation(s.doc, 1, 'b')!.height).toBeLessThan(f1.y - CLAIM_DY);
    expect(formation(s.doc, 1, 'a')!.y).toBeGreaterThan(f1.y + f1.height + CLAIM_DY - 10);
    // a second setup on the same table does nothing (one line per table)
    const n = s.doc.nodes.length;
    s.dispatch('battleline.setup', { x: 3000, y: 0 });
    expect(s.doc.nodes).toHaveLength(n);
  });

  it('readable text in the JSON Canvas file, and a lossless round trip', () => {
    const s = table();
    s.dispatch('battleline.deal', { players: [alice] });
    s.dispatch('battleline.claim', { ids: [flags(s.doc)[2].id], side: 'a' });
    const file = parse(serialize(s.exportDoc()));
    const texts = file.nodes.map((n) => n.text ?? n.label ?? '');
    expect(texts).toContain('Flag 1');
    expect(texts).toContain('Flag 3 (claimed by A)');
    expect(texts.filter((t) => /^(Red|Orange|Yellow|Green|Blue|Purple) (10|[1-9])$/.test(t))).toHaveLength(60);
    expect(texts).toContain('Tactic: Fog');
    expect(texts).toContain('Flag 1 · A');
    const t = store();
    t.load(file);
    expect(cardsIn(t.doc, homeOf(t, TROOPS).id)).toHaveLength(46);
    expect(cardsIn(t.doc, handOf(t.doc, 'a')!.id)).toHaveLength(7);
    expect(cardsIn(t.doc, handOf(t.doc, 'b')!.id)).toHaveLength(7);
    expect(flag(flags(t.doc)[2]).claim).toBe('a');
    expect(t.doc.nodes.filter((n) => (n['x-battleline'] as any)?.role === 'formation')).toHaveLength(18);
    expect(JSON.parse(serialize(t.exportDoc()))).toEqual(JSON.parse(serialize(s.exportDoc())));
  });

  it('deal, solo: 7 troops to your hand and 7 to an open hand for side B', () => {
    const s = table();
    s.dispatch('battleline.deal', { players: [alice] });
    const a = handOf(s.doc, 'a')!;
    const b = handOf(s.doc, 'b')!;
    expect(a.owner).toBe('alice');
    expect(isHand(a)).toBe(true);
    expect(b.owner).toBeUndefined();
    expect(cardsIn(s.doc, a.id)).toHaveLength(7);
    expect(cardsIn(s.doc, b.id)).toHaveLength(7);
    expect(cardsIn(s.doc, a.id).every((c) => card(c).faceUp === DEAL_FACE_UP && packOf(c) === TROOPS)).toBe(true);
    expect(cardsIn(s.doc, troopsDeck(s.doc)!.id)).toHaveLength(46);
    expect(a.y).toBeGreaterThan(formation(s.doc, 1, 'a')!.y);
    expect(b.y + b.height).toBeLessThan(formation(s.doc, 1, 'b')!.y);
    // the open hand stays a seat when emptied; Bob joining and dealing again takes it
    s.dispatch('battleline.deal', { players: [alice, bob], count: 1 });
    expect(handOf(s.doc, 'b')!.owner).toBe('bob');
    expect(cardsIn(s.doc, b.id)).toHaveLength(8);
  });

  it('deal with two players: one hand each, owned', () => {
    const s = table();
    s.dispatch('battleline.deal', { players: [alice, bob] });
    expect(handOf(s.doc, 'a')!.owner).toBe('alice');
    expect(handOf(s.doc, 'b')!.owner).toBe('bob');
    expect(handOf(s.doc, 'b')!.label).toBe("Bob's hand");
  });

  it('formations: a card snaps into the next free slot; Mud makes room for a 4th, not a 5th', () => {
    const s = table();
    s.dispatch('battleline.deal', { players: [alice, bob] });
    const hand = handOf(s.doc, 'a')!.id;
    const f = formation(s.doc, 5, 'a')!;
    const play = () => {
      const c = cardsIn(s.doc, hand)[0];
      s.dispatch('cards.pullOut', { id: c.id });
      s.dispatch('cards.drop', { target: f.id, ids: [c.id], at: { x: f.x + 70, y: f.y + 300 } });
      return c.id;
    };
    const ids = [0, 1, 2, 3, 4].map(() => play());
    const inF = cardsIn(s.doc, f.id);
    expect(inF.map((c) => c.id)).toEqual(ids.slice(0, 4));
    expect(inF.map((c) => c.y - f.y)).toEqual([14, 60, 106, 152]);
    expect(inF.every((c) => c.x === f.x + 14)).toBe(true);
    expect(s.doc.parentOf(ids[4])).toBeUndefined(); // refused: lies on the table
    // side B's formations cascade upward from the flag
    const fb = formation(s.doc, 5, 'b')!;
    const c = cardsIn(s.doc, handOf(s.doc, 'b')!.id)[0];
    s.dispatch('cards.pullOut', { id: c.id });
    s.dispatch('cards.drop', { target: fb.id, ids: [c.id] });
    expect(s.doc.get(c.id)!.y + 168).toBe(fb.y + fb.height - 14);
  });

  it('flags: claim moves to the side, dragging snaps and claims, Reset puts everything back', () => {
    const s = table();
    const [f1, f2, f3] = flags(s.doc);
    s.dispatch('battleline.claim', { ids: [f1.id], side: 'b' });
    expect(s.doc.get(f1.id)!.y).toBe(f1.y - CLAIM_DY);
    expect(s.doc.get(f1.id)!.text).toBe('Flag 1 (claimed by B)');
    s.dispatch('core.move', { ids: [f2.id], dx: 6, dy: 60 });
    s.dispatch('battleline.placeFlags', { ids: [f2.id] });
    expect(flag(s.doc.get(f2.id)!).claim).toBe('a');
    expect(s.doc.get(f2.id)!.x).toBe(f2.x);
    expect(s.doc.get(f2.id)!.y).toBe(f2.y + CLAIM_DY);
    s.dispatch('core.move', { ids: [f2.id], dx: 0, dy: -60 });
    s.dispatch('battleline.placeFlags', { ids: [f2.id] });
    expect(flag(s.doc.get(f2.id)!).claim).toBeUndefined();
    s.dispatch('core.move', { ids: [f3.id], dx: 2000, dy: 0 });
    s.dispatch('battleline.placeFlags', { ids: [f3.id] }); // far away: lies where dropped
    expect(s.doc.get(f3.id)!.x).toBe(f3.x + 2000);

    s.dispatch('battleline.deal', { players: [alice] });
    const hand = handOf(s.doc, 'a')!.id;
    const c = cardsIn(s.doc, hand)[0];
    s.dispatch('cards.pullOut', { id: c.id });
    s.dispatch('cards.drop', { target: formation(s.doc, 1, 'a')!.id, ids: [c.id] });
    s.dispatch('core.reset', {});
    expect(flags(s.doc).every((n) => !flag(n).claim && n.x === flag(n).hx && n.y === flag(n).hy)).toBe(true);
    expect(cardsIn(s.doc, homeOf(s, TROOPS).id)).toHaveLength(60);
    expect(cardsIn(s.doc, homeOf(s, TACTICS).id)).toHaveLength(10);
    expect(s.doc.nodes.filter(isCard).every((n) => !card(n).faceUp)).toBe(true);
    expect(cardsIn(s.doc, formation(s.doc, 1, 'a')!.id)).toHaveLength(0);
    expect(s.doc.nodes.filter((n) => (n['x-battleline'] as any)?.role === 'formation')).toHaveLength(18);
    expect(handOf(s.doc, 'a')).toBeDefined();
    expect(handOf(s.doc, 'b')).toBeDefined();
    expect(s.doc.nodes.filter(isFlag)).toHaveLength(9);
  });

  it('two players: a card played on one side shows up for the other (plain Yjs sync)', () => {
    const ya = new Y.Doc();
    const yb = new Y.Doc();
    const a = store(ya, 1);
    const b = store(yb, 2);
    a.dispatch('battleline.setup', { x: 0, y: 0 });
    a.dispatch('battleline.deal', { players: [alice, bob] });
    const sync = () => {
      Y.applyUpdate(yb, Y.encodeStateAsUpdate(ya, Y.encodeStateVector(yb)));
      Y.applyUpdate(ya, Y.encodeStateAsUpdate(yb, Y.encodeStateVector(ya)));
    };
    sync();
    const c = cardsIn(b.doc, handOf(b.doc, 'b')!.id)[0];
    b.dispatch('cards.pullOut', { id: c.id });
    b.dispatch('cards.drop', { target: formation(b.doc, 3, 'b')!.id, ids: [c.id] });
    b.dispatch('battleline.claim', { ids: [flags(b.doc)[2].id], side: 'b' });
    sync();
    expect(cardsIn(a.doc, formation(a.doc, 3, 'b')!.id).map((x) => x.id)).toEqual([c.id]);
    expect(flag(flags(a.doc)[2]).claim).toBe('b');
  });
});
