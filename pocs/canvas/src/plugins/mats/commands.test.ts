import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, parse, serialize, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerCardsLogic } from '../cards';
import { card, cardNode, cardsIn, isHand, isHomeDeck } from '../cards/deck';
import { registerMatsLogic } from './logic';
import { zonesOf } from './commands';
import { isMat, isZone, zone } from './model';

function ctx(seed = 1): CommandCtx {
  let n = 0;
  let s = seed;
  return { newId: () => `id${++n}`, random: () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646 };
}
function store(ydoc?: Y.Doc) {
  const s = new Store({ ctx: ctx(), ydoc });
  registerCoreCommands(s);
  registerCardsLogic(s);
  registerMatsLogic(s);
  return s;
}
const theMat = (s: Store) => s.doc.nodes.find(isMat)!;
const loose = (id: string, x: number, y: number, faceUp = false, z = 100) => cardNode(id, x, y, { face: 'AS', faceUp }, z);

describe('mats', () => {
  it('a mat carries what lies on it (zones by id, anything else by its center), not what is beside it', () => {
    const s = store();
    s.dispatch('mats.create', { x: 500, y: 300, w: 1000, h: 600 });
    const m = theMat(s);
    const zid = s.dispatch('mats.addZone', { mat: m.id, kind: 'row' }).select![0];
    s.apply([{ op: 'add', node: loose('on', 100, 100) }, { op: 'add', node: loose('off', 2000, 100) }, { op: 'add', node: loose('edge', -100, 100) }]);
    expect(s.doc.riders(m.id).map((n) => n.id).sort()).toEqual(['on', zid].sort());
    s.dispatch('core.move', { ids: [m.id], dx: 50, dy: 20 });
    expect([s.doc.get('on')!.x, s.doc.get('off')!.x, s.doc.get('edge')!.x]).toEqual([150, 2000, -100]);
    expect(s.doc.get(zid)!.x).toBe(m.x + 50 + (1000 - s.doc.get(zid)!.width) / 2);
  });

  it('a card dropped into a zone takes its layout and facing on entry; max refuses more', () => {
    const s = store();
    s.dispatch('mats.create', { x: 0, y: 0 });
    const zid = s.dispatch('mats.addZone', { mat: theMat(s).id, kind: 'row' }).select![0];
    s.dispatch('mats.configZone', { id: zid, max: 2, enter: 'up' });
    s.apply(['a', 'b', 'c'].map((id, i) => ({ op: 'add' as const, node: loose(id, 2000 + i * 200, 0) })));
    for (const id of ['a', 'b', 'c']) s.dispatch('cards.drop', { target: zid, ids: [id] });
    expect(cardsIn(s.doc, zid).map((c) => c.id)).toEqual(['a', 'b']);
    expect(cardsIn(s.doc, zid).every((c) => card(c).faceUp)).toBe(true);
    expect(s.doc.get(zid)!['x-cards']).toMatchObject({ layout: 'row', max: 2, slots: 2, enter: 'up', spot: true });
    // a zone stays when emptied and through Reset
    s.dispatch('cards.pullOut', { id: 'a' });
    s.dispatch('cards.pullOut', { id: 'b' });
    s.dispatch('core.reset', {});
    expect(s.doc.get(zid)).toBeDefined();
  });

  it('configure: layout, no limit, keep facing, rename; a seat can not be a pile', () => {
    const s = store();
    s.dispatch('mats.create', {});
    const zid = s.dispatch('mats.addZone', { mat: theMat(s).id, kind: 'stack' }).select![0];
    s.dispatch('mats.configZone', { id: zid, layout: 'column', max: 4, enter: 'down', name: 'Tableau' });
    expect(s.doc.get(zid)!).toMatchObject({ label: 'Tableau', 'x-cards': { layout: 'column', max: 4, slots: 4, enter: 'down' } });
    s.dispatch('mats.configZone', { id: zid, max: null, enter: 'keep' });
    expect(s.doc.get(zid)!['x-cards']).not.toHaveProperty('max');
    expect(s.doc.get(zid)!['x-cards']).not.toHaveProperty('enter');
    s.dispatch('mats.visibility', { id: zid, owner: 'alice', label: "Alice's hand", color: '#3cb44b' });
    expect(isHand(s.doc.get(zid))).toBe(true);
    expect(s.dispatch('mats.configZone', { id: zid, layout: 'stack' }).changes).toEqual([]);
  });

  it('visibility: private to a player (a hand with a fixed frame the zone width), public again restores the name', () => {
    const s = store();
    s.dispatch('mats.create', {});
    const zid = s.dispatch('mats.addZone', { mat: theMat(s).id, kind: 'stack', name: 'Seat 1' }).select![0];
    s.dispatch('mats.visibility', { id: zid, owner: 'alice', label: "Alice's hand" });
    const z = s.doc.get(zid)!;
    expect(z).toMatchObject({ owner: 'alice', label: "Alice's hand", 'x-cards': { layout: 'fan', fixed: true } });
    expect(isZone(z)).toBe(true);
    s.dispatch('mats.visibility', { id: zid, owner: null });
    expect(s.doc.get(zid)!).toMatchObject({ label: 'Seat 1' });
    expect(s.doc.get(zid)!.owner).toBeUndefined();
  });

  it('resize and keep-inside: a dragged zone goes back inside its mat', () => {
    const s = store();
    s.dispatch('mats.create', { x: 500, y: 300, w: 1000, h: 600 });
    const m = theMat(s);
    const zid = s.dispatch('mats.addZone', { mat: m.id, kind: 'free' }).select![0];
    s.dispatch('mats.resize', { id: zid, w: 400, h: 250 });
    expect([s.doc.get(zid)!.width, s.doc.get(zid)!.height]).toEqual([400, 250]);
    s.dispatch('core.move', { ids: [zid], dx: 5000, dy: -5000 });
    s.dispatch('mats.placeZones', { ids: [zid] });
    expect([s.doc.get(zid)!.x, s.doc.get(zid)!.y]).toEqual([m.x + 1000 - 400, m.y]);
    s.dispatch('mats.resize', { id: m.id, w: 10, h: 10 });
    expect(theMat(s).width).toBe(240);
  });

  it('delete a zone: its cards stay (a plain pile at the pile spot); remove mat keeps everything on it', () => {
    const s = store();
    s.dispatch('mats.create', {});
    const m = theMat(s);
    const zid = s.dispatch('mats.addZone', { mat: m.id, kind: 'stack' }).select![0];
    s.apply([{ op: 'add', node: loose('a', 3000, 0) }, { op: 'add', node: loose('b', 3200, 0) }]);
    s.dispatch('cards.drop', { target: zid, ids: ['a'] });
    s.dispatch('cards.drop', { target: zid, ids: ['b'] });
    const empty = s.dispatch('mats.addZone', { mat: m.id, kind: 'row' }).select![0];
    s.dispatch('mats.removeMat', { id: m.id });
    expect(s.doc.get(m.id)).toBeUndefined();
    expect(s.doc.get(empty)).toBeUndefined();
    const pile = s.doc.get(zid)!;
    expect(pile['x-mats']).toBeUndefined();
    expect(pile['x-cards']).not.toHaveProperty('area');
    expect(cardsIn(s.doc, zid)).toHaveLength(2);
  });

  it('poker preset: the table deck moves into the Deck zone (shuffled, face down, its home); seats for the players', () => {
    const s = store();
    s.dispatch('cards.setup', { x: 0, y: 0 }); // the starter table: a deck, spades on the table
    s.dispatch('mats.preset', { preset: 'poker', x: 0, y: 2000, players: [{ id: 'me', label: "Me's hand" }] });
    const m = theMat(s);
    const deck = zonesOf(s.doc, m.id, 'deck')[0];
    expect(isHomeDeck(deck)).toBe(true);
    expect(cardsIn(s.doc, deck.id)).toHaveLength(52);
    expect(cardsIn(s.doc, deck.id).every((c) => !card(c).faceUp)).toBe(true);
    expect(s.doc.nodes.filter(isHomeDeck)).toHaveLength(1);
    const seats = zonesOf(s.doc, m.id, 'seat');
    expect(seats).toHaveLength(6);
    expect(seats.filter((z) => z.owner === 'me')).toHaveLength(1);
    expect(zonesOf(s.doc, m.id, 'pot')[0]).toMatchObject({ type: 'group', 'x-mats': { free: true } });
    expect(zonesOf(s.doc, m.id, 'community')[0]['x-cards']).toMatchObject({ max: 5, enter: 'up' });
    // one undo step takes it all back
    s.undo();
    expect(s.doc.nodes.filter(isMat)).toHaveLength(0);
    expect(s.doc.nodes.filter(isHomeDeck)).toHaveLength(1);
  });

  it('a second deck preset while the deck sits on a mat: its deck zone stays an empty pile', () => {
    const s = store();
    s.dispatch('mats.preset', { preset: 'poker', x: 0, y: 0 });
    s.dispatch('mats.preset', { preset: 'solitaire', x: 0, y: 3000 });
    const sol = s.doc.nodes.filter(isMat).find((m) => m.label === 'Solitaire')!;
    const stock = zonesOf(s.doc, sol.id, 'stock')[0];
    expect(isHomeDeck(stock)).toBe(false);
    expect(cardsIn(s.doc, stock.id)).toHaveLength(0);
  });

  it('solitaire: Deal Klondike puts 1..7 cards in the columns, only the top face up; Reset gathers back into the stock', () => {
    const s = store();
    s.dispatch('mats.preset', { preset: 'solitaire', x: 0, y: 0 });
    const m = theMat(s);
    expect(zonesOf(s.doc, m.id, 'foundation')).toHaveLength(4);
    s.dispatch('mats.dealKlondike', { id: m.id });
    const cols = zonesOf(s.doc, m.id, 'tableau');
    expect(cols.map((c) => cardsIn(s.doc, c.id).length)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(cols.map((c) => cardsIn(s.doc, c.id).map((x) => card(x).faceUp).join())).toEqual(cols.map((_, k) => [...Array(k).fill(false), true].join()));
    const stock = zonesOf(s.doc, m.id, 'stock')[0];
    expect(cardsIn(s.doc, stock.id)).toHaveLength(24);
    expect(s.dispatch('mats.dealKlondike', { id: m.id }).changes).toEqual([]);
    s.dispatch('core.reset', {});
    expect(cardsIn(s.doc, stock.id)).toHaveLength(52);
  });

  it('player mat: a private hand row for the player, deck / play / discard public', () => {
    const s = store();
    s.dispatch('mats.preset', { preset: 'player', players: [{ id: 'me', label: "Alex's hand" }] });
    const m = theMat(s);
    expect(m.label).toBe("Alex's mat");
    expect(zonesOf(s.doc, m.id, 'hand')[0].owner).toBe('me');
    expect(zonesOf(s.doc, m.id, 'play')[0].owner).toBeUndefined();
  });

  it('JSON Canvas: mats and zones export as nested groups and come back the same', () => {
    const s = store();
    s.dispatch('mats.preset', { preset: 'poker', x: 0, y: 0, players: [{ id: 'me', label: "Me's hand" }] });
    const file = JSON.parse(serialize(s.exportDoc()));
    const m = file.nodes.find((n: any) => n['x-mats']?.kind === 'mat');
    const zones = file.nodes.filter((n: any) => typeof n['x-mats']?.zone === 'string');
    expect(m.type).toBe('group');
    expect(zones).toHaveLength(10);
    expect(zones.every((z: any) => z.type === 'group' && z.label && z.x >= m.x && z.x + z.width <= m.x + m.width && z.y >= m.y && z.y + z.height <= m.y + m.height)).toBe(true);
    // groups nest: the mat comes before its zones
    expect(file.nodes.indexOf(m)).toBeLessThan(Math.min(...zones.map((z: any) => file.nodes.indexOf(z))));
    const t = store();
    t.load(parse(JSON.stringify(file)));
    const m2 = theMat(t);
    expect(zonesOf(t.doc, m2.id).map((z) => [z.label, z.x, z.y, z.width, z.height])).toEqual(zonesOf(s.doc, m.id).map((z) => [z.label, z.x, z.y, z.width, z.height]));
    expect(cardsIn(t.doc, zonesOf(t.doc, m2.id, 'deck')[0].id)).toHaveLength(52);
    expect(zonesOf(t.doc, m2.id).every((z) => zone(z).zone === m2.id)).toBe(true);
  });

  it('two players: zone edits and drops sync, concurrent drops into the same zone both land', () => {
    const a = store(new Y.Doc());
    const b = store(new Y.Doc());
    const sync = () => {
      Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
      Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    };
    a.dispatch('mats.create', {});
    const zid = a.dispatch('mats.addZone', { mat: theMat(a).id, kind: 'row' }).select![0];
    a.apply([{ op: 'add', node: loose('x', 3000, 0) }, { op: 'add', node: loose('y', 3200, 0) }]);
    sync();
    a.dispatch('cards.drop', { target: zid, ids: ['x'] });
    b.dispatch('cards.drop', { target: zid, ids: ['y'] });
    b.dispatch('mats.configZone', { id: zid, enter: 'up' });
    sync();
    expect(cardsIn(a.doc, zid).map((c) => c.id).sort()).toEqual(['x', 'y']);
    expect(a.doc.get(zid)!['x-cards']).toMatchObject({ enter: 'up' });
    expect(serialize(a.exportDoc())).toBe(serialize(b.exportDoc()));
  });
});
