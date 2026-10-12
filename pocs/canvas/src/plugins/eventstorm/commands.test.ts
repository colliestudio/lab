import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, parse, serialize, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerStormLogic } from './logic';
import { eventsOn, votesCast } from './commands';
import { toMarkdown } from './markdown';
import { COL, KINDS, PAD, ROW, board, eventY, isBoard, isSticky, kindOf, phaseOf, slotX, sticky, voteTotal } from './model';

function ctx(): CommandCtx {
  let n = 0;
  return { newId: () => `id${++n}`, random: () => 0.5, now: () => 1000 };
}
function store() {
  const s = new Store({ ctx: ctx() });
  registerCoreCommands(s);
  registerStormLogic(s);
  s.actor = () => ({ id: 'alex', name: 'Alex', color: '#e66' });
  return s;
}
const ALEX = { id: 'alex', name: 'Alex', color: '#e66' };
/** A board with its top-left at (0, 0). */
function withBoard(lanes?: string[]) {
  const s = store();
  const id = s.dispatch('storm.createBoard', { x: 0, y: 0, lanes }).select![0];
  const b = s.doc.get(id)!;
  s.dispatch('core.move', { ids: [id], dx: -b.x, dy: -b.y });
  return { s, b: id };
}
const add = (s: Store, b: string, kind: string, more: Record<string, unknown> = {}) => s.dispatch('storm.add', { board: b, kind, by: ALEX, ...more }).select![0];
const order = (s: Store, b: string) => eventsOn(s.doc, b).map((e) => e.text);

describe('event storm', () => {
  it('explore phase: events go where they are dropped, only events and hotspots are offered', () => {
    const { s, b } = withBoard();
    const e = add(s, b, 'event', { x: 600, y: 400, text: 'Order placed' });
    expect(s.doc.get(e)).toMatchObject({ x: 600 - 80, y: 400 - 55, text: 'Order placed', color: KINDS.event.color });
    expect(s.doc.carrierOf(e)).toBe(b);
    expect(s.dispatch('storm.add', { board: b, kind: 'command', x: 100, y: 100 }).changes).toEqual([]);
    expect(add(s, b, 'hotspot', { x: 300, y: 300 })).toBeTruthy();
  });

  it('switching to the timeline phase snaps events into one sequence by x, each into its lane', () => {
    const { s, b } = withBoard(['Customer', 'Warehouse']);
    add(s, b, 'event', { x: 900, y: 200, text: 'Shipped' });
    add(s, b, 'event', { x: 300, y: 800, text: 'Paid' });
    add(s, b, 'event', { x: 100, y: 300, text: 'Placed' });
    s.dispatch('storm.phase', { board: b, phase: 'timeline' });
    const B = s.doc.get(b)!;
    expect(phaseOf(B)).toBe('timeline');
    const evs = eventsOn(s.doc, b);
    expect(evs.map((e) => e.text)).toEqual(['Placed', 'Paid', 'Shipped']);
    expect(evs.map((e) => e.x)).toEqual([0, 1, 2].map((i) => slotX(B, i)));
    expect(evs.map((e) => e.y)).toEqual([eventY(B, 0), eventY(B, 1), eventY(B, 0)]);
    // one undo puts the chaos back
    s.undo();
    expect(eventsOn(s.doc, b).map((e) => e.x)).toEqual([20, 220, 820]);
  });

  it('a new event after another is slotted in right after it (Tab chaining)', () => {
    const { s, b } = withBoard();
    s.dispatch('storm.phase', { board: b, phase: 'timeline' });
    const a = add(s, b, 'event', { text: 'A' });
    const c = add(s, b, 'event', { after: a, text: 'C' });
    add(s, b, 'event', { after: a, text: 'B' });
    expect(order(s, b)).toEqual(['A', 'B', 'C']);
    expect(s.doc.get(c)!.x).toBe(slotX(s.doc.get(b)!, 2));
  });

  it('reorder by drag: drop an event between two others and the timeline re-packs', () => {
    const { s, b } = withBoard();
    s.dispatch('storm.phase', { board: b, phase: 'timeline' });
    const a = add(s, b, 'event', { text: 'A' });
    const bb = add(s, b, 'event', { after: a, text: 'B' });
    const c = add(s, b, 'event', { after: bb, text: 'C' });
    // drag C to between A and B
    s.dispatch('core.move', { ids: [c], dx: -(2 * COL) + COL / 2, dy: 37 });
    s.dispatch('storm.settle', { ids: [c] });
    expect(order(s, b)).toEqual(['A', 'C', 'B']);
    expect(s.doc.get(c)!.y).toBe(eventY(s.doc.get(b)!, 0));
  });

  it('process phase: commands stack above an event, policies below, and ride it when it moves', () => {
    const { s, b } = withBoard();
    s.dispatch('storm.phase', { board: b, phase: 'process' });
    const e = add(s, b, 'event', { text: 'Order placed' });
    const cmd = add(s, b, 'command', { on: e, text: 'Place order' });
    const act = add(s, b, 'actor', { on: e, text: 'Customer' });
    const pol = add(s, b, 'policy', { on: e, text: 'When placed, reserve stock' });
    const E = s.doc.get(e)!;
    expect(s.doc.carrierOf(cmd)).toBe(e);
    expect(s.doc.get(cmd)!.y).toBe(E.y - ROW);
    expect(s.doc.get(act)!.y).toBe(E.y - 2 * ROW + (E.height - KINDS.actor.h));
    expect(s.doc.get(pol)!.y).toBe(E.y + ROW);
    // moving the event takes them along
    s.dispatch('core.move', { ids: [e], dx: 10, dy: 0 });
    expect(s.doc.get(cmd)!.x).toBe(E.x + 10);
  });

  it('a sticky dropped into an event column attaches to it; dropped elsewhere it lets go', () => {
    const { s, b } = withBoard();
    s.dispatch('storm.phase', { board: b, phase: 'process' });
    const e1 = add(s, b, 'event', { text: 'A' });
    const e2 = add(s, b, 'event', { after: e1, text: 'B' });
    const r = add(s, b, 'read', { x: 900, y: 600, text: 'Order list' });
    expect(sticky(s.doc.get(r)!).on).toBeUndefined();
    const E2 = s.doc.get(e2)!;
    s.dispatch('core.move', { ids: [r], dx: E2.x + 20 - s.doc.get(r)!.x, dy: E2.y + ROW + 30 - s.doc.get(r)!.y });
    s.dispatch('storm.settle', { ids: [r] });
    expect(sticky(s.doc.get(r)!).on).toBe(e2);
    expect(s.doc.get(r)!).toMatchObject({ x: E2.x, y: E2.y + ROW });
    s.dispatch('core.move', { ids: [r], dx: 700, dy: 0 });
    s.dispatch('storm.settle', { ids: [r] });
    expect(sticky(s.doc.get(r)!).on).toBeUndefined();
  });

  it('dot voting stays within each person’s budget; two voters both count', () => {
    const { s, b } = withBoard();
    const x = add(s, b, 'event', { text: 'X' });
    const y = add(s, b, 'event', { text: 'Y', x: 500, y: 300 });
    for (let i = 0; i < 4; i++) s.dispatch('storm.vote', { id: x, voter: 'alex', delta: 1 });
    expect(votesCast(s.doc, b, 'alex')).toBe(3);
    s.dispatch('storm.vote', { id: y, voter: 'alex', delta: 1 });
    expect(voteTotal(s.doc.get(y)!)).toBe(0);
    s.dispatch('storm.vote', { id: x, voter: 'alex', delta: -1 });
    s.dispatch('storm.vote', { id: y, voter: 'alex', delta: 1 });
    s.dispatch('storm.vote', { id: y, voter: 'bo', delta: 1 });
    expect([voteTotal(s.doc.get(x)!), voteTotal(s.doc.get(y)!)]).toEqual([2, 2]);
    s.dispatch('core.reset', {});
    expect(voteTotal(s.doc.get(y)!)).toBe(0);
  });

  it('the log says who added what', () => {
    const { s, b } = withBoard();
    const e = add(s, b, 'event', { x: 300, y: 300 });
    s.dispatch('storm.text', { id: e, text: 'Cart abandoned' });
    s.dispatch('storm.text', { id: e, text: 'Cart expired' });
    const texts = s.log.toArray().map((l) => `${l.actor?.name} ${l.text}`);
    expect(texts).toContain('Alex added domain event “Cart abandoned”');
    expect(texts).toContain('Alex renamed domain event “Cart abandoned” to “Cart expired”');
  });

  it('the log names the sticky author when an agent adds it, not the acting player', () => {
    const { s, b } = withBoard();
    const CLAUDE = { id: 'claude', name: 'Claude', color: '#a6f' };
    s.dispatch('storm.add', { board: b, kind: 'event', x: 300, y: 300, text: 'Refund requested', by: CLAUDE });
    const e = s.dispatch('storm.add', { board: b, kind: 'event', x: 500, y: 300, by: CLAUDE }).select![0];
    s.dispatch('storm.text', { id: e, text: 'Refund paid' });
    s.dispatch('storm.text', { id: e, text: 'Refund done' });
    const texts = s.log.toArray().map((l) => `${l.actor?.name} ${l.text}`);
    expect(texts).toContain('Claude added domain event “Refund requested”');
    expect(texts).toContain('Claude added domain event “Refund paid”');
    expect(texts).toContain('Alex renamed domain event “Refund paid” to “Refund done”');
  });

  /** Two synced peers on one board in the timeline phase (lanes as given). */
  function twoPeers(lanes?: string[]) {
    const da = new Y.Doc();
    const db = new Y.Doc();
    const peer = (ydoc: Y.Doc, seed: string) => {
      const st = new Store({ ydoc, ctx: { ...ctx(), newId: (() => { let n = 0; return () => `${seed}${++n}`; })() } });
      registerCoreCommands(st);
      registerStormLogic(st);
      return st;
    };
    const A = peer(da, 'a');
    const B = peer(db, 'b');
    const id = A.dispatch('storm.createBoard', { x: 0, y: 0, lanes }).select![0];
    A.dispatch('storm.phase', { board: id, phase: 'timeline' });
    Y.applyUpdate(db, Y.encodeStateAsUpdate(da));
    const sync = () => {
      Y.applyUpdate(da, Y.encodeStateAsUpdate(db));
      Y.applyUpdate(db, Y.encodeStateAsUpdate(da));
    };
    return { A, B, id, sync };
  }

  it('two peers add an event at the same moment: both repair, the slots do not overlap', () => {
    const { A, B, id, sync } = twoPeers();
    A.dispatch('storm.add', { board: id, kind: 'event', text: 'One', by: ALEX });
    sync();
    // offline: each adds an event after "One", then they sync
    const one = eventsOn(A.doc, id)[0].id;
    A.dispatch('storm.add', { board: id, kind: 'event', text: 'From A', after: one, by: ALEX });
    B.dispatch('storm.add', { board: id, kind: 'event', text: 'From B', after: one, by: ALEX });
    sync();
    for (const st of [A, B]) {
      const evs = eventsOn(st.doc, id);
      expect(evs).toHaveLength(3);
      expect(new Set(evs.map((e) => `${e.x},${e.y}`)).size).toBe(3);
    }
    expect(eventsOn(A.doc, id).map((e) => e.x)).toEqual(eventsOn(B.doc, id).map((e) => e.x));
  });

  it('two peers add an event in two lanes at the same moment: one slot each', () => {
    const { A, B, id, sync } = twoPeers(['Buyer', 'Seller']);
    const b = A.doc.get(id)!;
    A.dispatch('storm.add', { board: id, kind: 'event', text: 'One', by: ALEX });
    sync();
    const x = slotX(b, 1) + 80;
    A.dispatch('storm.add', { board: id, kind: 'event', text: 'From A', x, y: eventY(b, 0) + 55, by: ALEX });
    B.dispatch('storm.add', { board: id, kind: 'event', text: 'From B', x, y: eventY(b, 1) + 55, by: ALEX });
    sync();
    for (const st of [A, B]) expect(new Set(eventsOn(st.doc, id).map((e) => e.x)).size).toBe(3);
  });

  it('repair leaves a remote drag alone while two loose stickies share a spot', () => {
    const { A, B, id, sync } = twoPeers();
    const b = A.doc.get(id)!;
    const e = A.dispatch('storm.add', { board: id, kind: 'event', text: 'One', by: ALEX }).select![0];
    A.dispatch('storm.add', { board: id, kind: 'hotspot', x: b.x + 600, y: b.y + 150, by: ALEX });
    A.dispatch('storm.add', { board: id, kind: 'hotspot', x: b.x + 600, y: b.y + 150, by: ALEX });
    sync();
    const at = A.doc.get(e)!.x;
    B.dispatch('core.move', { ids: [e], dx: 37, dy: 0 }); // mid-drag on B
    sync();
    expect(A.doc.get(e)!.x).toBe(at + 37);
    expect(B.doc.get(e)!.x).toBe(at + 37);
  });

  it('repair leaves an event alone while a remote player drags it over another column', () => {
    const { A, B, id, sync } = twoPeers();
    const e = A.dispatch('storm.add', { board: id, kind: 'event', text: 'One', by: ALEX }).select![0];
    A.dispatch('storm.add', { board: id, kind: 'event', text: 'Two', after: e, by: ALEX });
    sync();
    const at = A.doc.get(e)!;
    B.dispatch('core.move', { ids: [e], dx: COL, dy: 3 }); // mid-drag on B, right over "Two"'s column
    sync();
    expect(A.doc.get(e)).toMatchObject({ x: at.x + COL, y: at.y + 3 });
  });

  it('timer: start, pause keeps the time left, reset', () => {
    const { s, b } = withBoard();
    s.dispatch('storm.timer', { board: b, action: 'set', minutes: 5, now: 0 });
    s.dispatch('storm.timer', { board: b, action: 'start', now: 1000 });
    s.dispatch('storm.timer', { board: b, action: 'pause', now: 61_000 });
    expect(board(s.doc.get(b)!).timer).toEqual({ base: 300_000, left: 240_000 });
    s.dispatch('storm.timer', { board: b, action: 'reset', now: 0 });
    expect(board(s.doc.get(b)!).timer.left).toBe(300_000);
  });

  it('lanes resize the board; changing kind drops attachments', () => {
    const { s, b } = withBoard();
    s.dispatch('storm.phase', { board: b, phase: 'process' });
    const h0 = s.doc.get(b)!.height;
    s.dispatch('storm.lanes', { board: b, lanes: ['Buyer', 'Seller'] });
    expect(s.doc.get(b)!.height).toBeGreaterThan(h0);
    const e = add(s, b, 'event', { text: 'E' });
    const c = add(s, b, 'command', { on: e, text: 'C' });
    s.dispatch('storm.kind', { id: e, kind: 'hotspot' });
    expect(sticky(s.doc.get(c)!).on).toBeUndefined();
    expect(kindOf(s.doc.get(e)!)).toBe('hotspot');
  });

  it('exports the flow as Markdown in timeline order with attachments', () => {
    const { s, b } = withBoard();
    s.dispatch('storm.phase', { board: b, phase: 'process' });
    const e1 = add(s, b, 'event', { text: 'Order placed' });
    const e2 = add(s, b, 'event', { after: e1, text: 'Payment taken' });
    add(s, b, 'command', { on: e1, text: 'Place order' });
    add(s, b, 'actor', { on: e1, text: 'Customer' });
    add(s, b, 'policy', { on: e1, text: 'Whenever an order is placed, take payment' });
    add(s, b, 'external', { on: e2, text: 'Stripe' });
    add(s, b, 'hotspot', { x: 1000, y: 700, text: 'Partial payments?' });
    s.dispatch('storm.vote', { id: e2, voter: 'alex', delta: 1 });
    const md = toMarkdown(s.doc, s.doc.get(b)!, { authors: false });
    expect(md).toBe(
      [
        '# Event storm: Event storm',
        '',
        'Phase: Commands & policies.',
        '',
        '## Timeline',
        '',
        '1. **Order placed**',
        '   - Actor: Customer',
        '   - Command: Place order',
        '   - Policy: Whenever an order is placed, take payment',
        '2. **Payment taken** _(1 vote)_',
        '   - External system: Stripe',
        '',
        '## Hotspots not on an event',
        '',
        '- Partial payments?',
        '',
        '## Most votes',
        '',
        '- 1: Payment taken (domain event)',
        '',
      ].join('\n'),
    );
  });

  it('survives a JSON Canvas round trip (text nodes keep the words)', () => {
    const { s, b } = withBoard();
    s.dispatch('storm.phase', { board: b, phase: 'process' });
    const e = add(s, b, 'event', { text: 'E' });
    add(s, b, 'command', { on: e, text: 'C' });
    const file = parse(serialize(s.exportDoc()));
    expect(file.nodes.filter(isSticky).map((n) => n.type)).toEqual(['text', 'text']);
    const t = store();
    t.load(file);
    expect(t.doc.riders(e).map((n) => n.text)).toEqual(['C']);
    expect(t.doc.nodes.filter(isBoard)).toHaveLength(1);
    expect(PAD).toBeGreaterThan(0);
  });
});
