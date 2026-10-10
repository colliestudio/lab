import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, parse, serialize, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerCardsLogic } from '../cards';
import { card, cardsIn, hiddenFrom, isCard, isHand, isHomeDeck, packOf, roomIn } from '../cards/deck';
import { registerMatsLogic } from '../mats/logic';
import { isMat, isZone } from '../mats/model';
import { registerBattleLineLogic, route } from './index';
import { DEAL_FACE_UP, discardPile, environment, flags, formation, formationCapacity, handOf, homeOf as flagHome, playedRow, tacticCounts, tally, troopsDeck } from './commands';
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
  registerMatsLogic(s);
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
    // the open hand stays a seat; Bob joining and dealing again (a new game) takes it
    s.dispatch('battleline.deal', { players: [alice, bob], count: 1 });
    expect(handOf(s.doc, 'b')!.owner).toBe('bob');
    expect(cardsIn(s.doc, b.id)).toHaveLength(1);
    expect(cardsIn(s.doc, troopsDeck(s.doc)!.id)).toHaveLength(58);
  });

  it('deal with two players: one hand each, owned', () => {
    const s = table();
    s.dispatch('battleline.deal', { players: [alice, bob] });
    expect(handOf(s.doc, 'a')!.owner).toBe('alice');
    expect(handOf(s.doc, 'b')!.owner).toBe('bob');
    expect(handOf(s.doc, 'b')!.label).toBe("Bob's hand");
    // private: face down; the owner sees faces, the other player backs
    const ac = cardsIn(s.doc, handOf(s.doc, 'a')!.id);
    expect(ac.every((c) => hiddenFrom(s.doc, c, 'bob') && !hiddenFrom(s.doc, c, 'alice'))).toBe(true);
  });

  it('formations: a card snaps into the next free slot, face up; 3 slots, a 4th only while Mud lies on the flag', () => {
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
    const ids = [0, 1, 2, 3].map(() => play());
    expect(cardsIn(s.doc, f.id).map((c) => c.id)).toEqual(ids.slice(0, 3));
    expect(cardsIn(s.doc, f.id).every((c) => card(c).faceUp)).toBe(true); // face up on entry (it came from a hand face down)
    expect(s.doc.parentOf(ids[3])).toBeUndefined(); // refused: lies on the table
    // Mud on flag 5: both formations there get a 4th slot, not a 5th
    const mud = s.doc.nodes.find((n) => isCard(n) && card(n).face === 'mud')!;
    s.dispatch('cards.pullOut', { id: mud.id });
    s.dispatch('cards.drop', { target: environment(s.doc, 5)!.id, ids: [mud.id] });
    expect(formationCapacity(s.doc, f)).toEqual({ slots: 4, max: 4 });
    expect(formationCapacity(s.doc, formation(s.doc, 4, 'a')!)).toEqual({ slots: 3, max: 3 });
    s.dispatch('cards.drop', { target: f.id, ids: [ids[3]] });
    const fifth = play();
    const inF = cardsIn(s.doc, f.id);
    expect(inF.map((c) => c.id)).toEqual(ids);
    expect(inF.map((c) => c.y - f.y)).toEqual([14, 60, 106, 152]);
    expect(inF.every((c) => c.x === f.x + 14)).toBe(true);
    expect(s.doc.parentOf(fifth)).toBeUndefined();
    // Mud leaves: the 4 cards stay (over capacity), nothing more goes in
    s.dispatch('cards.pullOut', { id: mud.id });
    expect(cardsIn(s.doc, f.id)).toHaveLength(4);
    expect(roomIn(s.doc, f)).toBe(0);
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

describe('battle line packs and Sort ▸', () => {
  it('troops sort by color then value; tactics by name', async () => {
    await import('./render');
    const s = table();
    s.dispatch('battleline.deal', { players: [alice], count: 7 });
    const h = handOf(s.doc, 'a')!.id;
    s.dispatch('cards.sort', { id: h, mode: 'suit' });
    const order = ['r', 'o', 'y', 'g', 'b', 'p'];
    const keys = cardsIn(s.doc, h).map((c) => { const f = card(c).face; return order.indexOf(f[0]) * 100 + Number(f.slice(1)); });
    expect(keys).toEqual(keys.slice().sort((x, y) => x - y));
    const tac = homeOf(s, TACTICS).id;
    s.dispatch('cards.setLayout', { id: tac, layout: 'row' });
    s.dispatch('cards.sort', { id: tac, mode: 'suit' });
    expect(cardsIn(s.doc, tac).map((c) => card(c).face).slice(0, 3)).toEqual(['alexander', 'companion', 'darius']);
  });
});

describe('battle line: one game model', () => {
  /** The bits of App the drop routing uses, over a store. */
  const fakeApp = (s: Store, viewer: string) => {
    const notes: string[] = [];
    return { app: { get doc() { return s.doc; }, viewer, notify: (m: string) => void notes.push(m), dispatch: (n: string, a: unknown) => s.dispatch(n, a) } as any, notes };
  };
  /** A tactic drawn from its deck (in play it comes from a hand; here it lies on the table). */
  const tacticCard = (s: Store, face: string) => {
    const c = s.doc.nodes.find((n) => isCard(n) && card(n).face === face)!;
    if (s.doc.parentOf(c.id) && isHomeDeck(s.doc.get(s.doc.parentOf(c.id)!))) s.dispatch('cards.pullOut', { id: c.id });
    return s.doc.get(c.id)!;
  };
  /** Drop like the UI: route, drop into where it goes, run the hints. */
  const dropVia = (s: Store, app: any, target: string, id: string) => {
    const r = route(s.doc.get(target)!, [s.doc.get(id)!], app);
    s.dispatch('cards.drop', { target: r?.to ?? target, ids: [id] });
    r?.after?.();
    return r;
  };

  it('New hand for me, then Deal Battle Line: still exactly one hand for me, with 7 cards', () => {
    const s = table();
    const mine = s.dispatch('cards.newHand', { owner: 'alice', label: "Alice's hand", x: 0, y: 2000 }).select![0];
    s.dispatch('battleline.deal', { players: [alice] });
    const hands = s.doc.nodes.filter((n) => isHand(n) && n.owner === 'alice');
    expect(hands.map((h) => h.id)).toEqual([mine]);
    expect(handOf(s.doc, 'a')!.id).toBe(mine);
    expect(cardsIn(s.doc, mine)).toHaveLength(7);
  });

  it('deal is a new game: everything comes back (formations, flags, played rows, discard), flags unclaimed', () => {
    const s = table();
    s.dispatch('battleline.deal', { players: [alice, bob] });
    const { app } = fakeApp(s, 'alice');
    const hand = handOf(s.doc, 'a')!.id;
    dropVia(s, app, formation(s.doc, 2, 'a')!.id, cardsIn(s.doc, hand)[0].id);
    dropVia(s, app, formation(s.doc, 2, 'a')!.id, tacticCard(s, 'scout').id);
    dropVia(s, app, flags(s.doc)[3].id, tacticCard(s, 'fog').id);
    s.dispatch('cards.drop', { target: discardPile(s.doc)!.id, ids: [cardsIn(s.doc, hand)[0].id] });
    s.dispatch('battleline.claim', { ids: [flags(s.doc)[1].id], side: 'a' });
    s.dispatch('battleline.deal', { players: [alice, bob] });
    expect(cardsIn(s.doc, troopsDeck(s.doc)!.id)).toHaveLength(46);
    expect(cardsIn(s.doc, homeOf(s, TACTICS).id)).toHaveLength(10);
    for (const side of ['a', 'b'] as const) expect(cardsIn(s.doc, handOf(s.doc, side)!.id)).toHaveLength(7);
    expect([discardPile(s.doc)!, playedRow(s.doc, 'a')!, environment(s.doc, 4)!, formation(s.doc, 2, 'a')!].map((n) => cardsIn(s.doc, n.id).length)).toEqual([0, 0, 0, 0]);
    expect(flags(s.doc).every((n) => !flag(n).claim)).toBe(true);
    expect(tacticCounts(s.doc)).toEqual({ a: 0, b: 0 });
  });

  it('routing: Fog / Mud on a flag or a formation → the flag’s environment spot (who played it); Guile → the dropper’s played row; a troop on a flag → the dropper’s formation there', () => {
    const s = table();
    s.dispatch('battleline.deal', { players: [alice, bob] });
    const { app } = fakeApp(s, 'bob');
    const fog = tacticCard(s, 'fog');
    expect(dropVia(s, app, formation(s.doc, 6, 'a')!.id, fog.id)?.label).toBe('Fog on flag 6');
    expect(s.doc.parentOf(fog.id)).toBe(environment(s.doc, 6)!.id);
    expect(card(s.doc.get(fog.id)!).faceUp).toBe(true);
    expect(s.doc.get(fog.id)!['x-battleline']).toEqual({ by: 'a' }); // not from a hand: the side of the formation it was dropped on
    const mud = tacticCard(s, 'mud');
    dropVia(s, app, flags(s.doc)[5].id, mud.id);
    expect(cardsIn(s.doc, environment(s.doc, 6)!.id)).toHaveLength(2);
    // sideways and smaller, across the flag
    expect(s.doc.styleOf(mud.id)?.angle).toBe(90);
    // Guile from Bob's hand, dropped on Alice's formation: Bob's played row
    const scout = tacticCard(s, 'scout');
    s.dispatch('cards.drop', { target: handOf(s.doc, 'b')!.id, ids: [scout.id] });
    expect(dropVia(s, app, formation(s.doc, 1, 'a')!.id, scout.id)?.label).toBe('Played tactics · Bob');
    expect(s.doc.parentOf(scout.id)).toBe(playedRow(s.doc, 'b')!.id);
    expect(card(s.doc.get(scout.id)!).faceUp).toBe(true);
    // a troop from Bob's hand dropped on flag 2 lands in Bob's (top) formation there
    const t = cardsIn(s.doc, handOf(s.doc, 'b')!.id)[0];
    dropVia(s, app, flags(s.doc)[1].id, t.id);
    expect(s.doc.parentOf(t.id)).toBe(formation(s.doc, 2, 'b')!.id);
    expect(tacticCounts(s.doc)).toEqual({ a: 1, b: 2 }); // Fog: A (its formation); Mud on the flag: Bob (the dropper); Scout: Bob
  });

  it('soft hints, never blocking: a tactic while ahead, a second Leader, cards at a claimed flag', () => {
    const s = table();
    s.dispatch('battleline.deal', { players: [alice, bob] });
    const { app, notes } = fakeApp(s, 'alice');
    dropVia(s, app, formation(s.doc, 1, 'a')!.id, tacticCard(s, 'alexander').id);
    expect(notes).toEqual([]);
    dropVia(s, app, formation(s.doc, 2, 'a')!.id, tacticCard(s, 'darius').id);
    expect(notes.join()).toMatch(/more tactics than/);
    expect(notes.join()).toMatch(/two Leaders/);
    expect(s.doc.parentOf(tacticCard(s, 'darius').id)).toBe(formation(s.doc, 2, 'a')!.id); // still allowed
    s.dispatch('battleline.claim', { ids: [flags(s.doc)[2].id], side: 'b' });
    dropVia(s, app, formation(s.doc, 3, 'a')!.id, cardsIn(s.doc, handOf(s.doc, 'a')!.id)[0].id);
    expect(notes.at(-1)).toMatch(/Flag 3 is claimed/);
  });

  it('Guile moves work: Scout puts a hand card back on a deck top face down; Deserter discards face up', () => {
    const s = table();
    s.dispatch('battleline.deal', { players: [alice, bob] });
    const deck = troopsDeck(s.doc)!.id;
    const back = cardsIn(s.doc, handOf(s.doc, 'a')!.id)[0];
    s.dispatch('cards.drop', { target: deck, ids: [back.id] });
    expect(cardsIn(s.doc, deck).at(-1)!.id).toBe(back.id);
    expect(card(s.doc.get(back.id)!).faceUp).toBe(false);
    const { app } = fakeApp(s, 'bob');
    const victim = cardsIn(s.doc, handOf(s.doc, 'b')!.id)[0];
    dropVia(s, app, formation(s.doc, 4, 'b')!.id, victim.id);
    s.dispatch('cards.drop', { target: discardPile(s.doc)!.id, ids: [victim.id] });
    expect(card(s.doc.get(victim.id)!).faceUp).toBe(true);
  });

  it('on a mat: formations, discard and played rows are its zones; moving the mat keeps flags snapping home', () => {
    const s = store();
    s.dispatch('battleline.setup', { x: 0, y: 0, mat: true });
    const m = s.doc.nodes.find(isMat)!;
    expect(isZone(formation(s.doc, 1, 'a'))).toBe(true);
    expect(isZone(playedRow(s.doc, 'b'))).toBe(true);
    expect(isZone(discardPile(s.doc))).toBe(true);
    expect(tally(s.doc)).toBeDefined();
    const riders = new Set(s.doc.riders(m.id).map((n) => n.id));
    expect(flags(s.doc).every((f) => riders.has(f.id))).toBe(true);
    expect(riders.has(troopsDeck(s.doc)!.id)).toBe(true);
    s.dispatch('core.move', { ids: [m.id], dx: 300, dy: 100 });
    const f = flags(s.doc)[4];
    expect(flagHome(s.doc, f)).toEqual({ x: f.x, y: f.y });
    s.dispatch('battleline.claim', { ids: [f.id], side: 'a' });
    expect(s.doc.get(f.id)!.y).toBe(f.y + CLAIM_DY);
    // an older table (no played rows / environment spots / tally) gets them at the next deal
    const t = store();
    t.dispatch('battleline.setup', { x: 0, y: 0 });
    const old = [playedRow(t.doc, 'a')!.id, environment(t.doc, 1)!.id, tally(t.doc)!.id];
    t.apply(old.map((id) => ({ op: 'del' as const, id })));
    t.dispatch('battleline.deal', { players: [alice] });
    expect([playedRow(t.doc, 'a'), environment(t.doc, 1), tally(t.doc)].every(Boolean)).toBe(true);
  });
});
