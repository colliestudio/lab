import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, parse, serialize, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerCardsLogic } from '../cards';
import { card, cardsIn, isHand } from '../cards/deck';
import { registerClockLogic } from '../clock';
import { clock, isClock } from '../clock/model';
import { registerMatsLogic } from '../mats/logic';
import { isZone, zoneName } from '../mats/model';
import { registerAutomationLogic, resolve } from './commands';
import { buttonOf, isButton, parseTarget, targetText, validateSteps, validateTrigger, type Step } from './model';

function ctx(seed = 1): CommandCtx {
  let n = 0;
  let s = seed;
  return { newId: () => `id${++n}`, random: () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646, now: () => 1_000_000 };
}
function store(ydoc?: Y.Doc) {
  const s = new Store({ ctx: ctx(), ydoc });
  registerCoreCommands(s);
  registerCardsLogic(s);
  registerClockLogic(s);
  registerMatsLogic(s);
  registerAutomationLogic(s);
  return s;
}
const ME = { id: 'me', label: "Me's hand", color: '#c33' };
const YOU = { id: 'you', label: "You's hand", color: '#33c' };
const zoneNamed = (s: Store, name: string) => s.doc.nodes.find((n) => isZone(n) && zoneName(n) === name)!;
const button = (s: Store, name: string) => s.doc.nodes.find((n) => isButton(n) && buttonOf(n).name === name)!;
const run = (s: Store, name: string, players = [ME, YOU]) => s.dispatch('auto.run', { id: button(s, name).id, players, now: 5000 });
const lastLog = (s: Store) => s.log.get(s.log.length - 1).text;

function tienlen(players = [ME, YOU]) {
  const s = store();
  s.dispatch('auto.tienlen', { x: 0, y: 0, players });
  s.undoManager.clear();
  return s;
}

describe('step schema', () => {
  it('accepts the demo buttons and rejects unknown verbs, fields and bad args', () => {
    expect(validateSteps([{ do: 'shuffle', target: { name: 'Main' } }])).toEqual([]);
    expect(validateSteps([{ do: 'eval', code: 'x' }])[0]).toMatch(/unknown "do"/);
    expect(validateSteps([{ do: 'shuffle', target: { name: 'Main' }, extra: 1 }])[0]).toMatch(/unknown field "extra"/);
    expect(validateSteps([{ do: 'deal', from: { name: 'Main' }, count: 99 }])[0]).toMatch(/count must be 1–52/);
    expect(validateSteps([{ do: 'move', what: { kind: 'dragon' }, to: { name: 'X' } }])[0]).toMatch(/kind must be/);
    expect(validateSteps([{ do: 'stop', when: { target: { name: 'P' }, is: 'full' } }])[0]).toMatch(/is must be/);
    expect(validateSteps('nope')).toEqual(['steps must be a list']);
    expect(validateTrigger({ on: 'enter', zone: { name: 'Pile' } })).toEqual([]);
    expect(validateTrigger({ on: 'timer' })).toHaveLength(1);
  });
  it('targets round-trip through their short text', () => {
    for (const t of [{ name: 'Main' }, { kind: 'hand' as const }, { kind: 'card' as const, in: 'Pile' }, { kind: 'clock' as const, name: 'Timer' }, { in: 'Done' }, { kind: 'text' as const, name: 'Phase' }])
      expect(parseTarget(targetText(t))).toEqual(t);
  });
  it('an invalid edit changes nothing; create refuses invalid steps', () => {
    const s = tienlen();
    const b = button(s, 'New round');
    expect(s.dispatch('auto.edit', { id: b.id, steps: [{ do: 'rm -rf' }] }).changes).toEqual([]);
    expect(s.dispatch('auto.create', { x: 0, y: 0, name: 'X', steps: [{ do: 'shuffle' }] as unknown as Step[] }).changes).toEqual([]);
    expect(s.dispatch('auto.create', { x: 0, y: 0, name: 'X', steps: [{ do: 'log', text: 'hi' }] }).changes).toHaveLength(1);
  });
});

describe('Tiến Lên buttons', () => {
  it('Deal: shuffle Main, 13 to each player, the rest set aside: one undo step, one log line', () => {
    const s = tienlen();
    const logBefore = s.log.length;
    expect(run(s, 'Deal Tiến Lên').ok).toBe(true);
    const hands = s.doc.nodes.filter(isHand);
    expect(hands.map((h) => cardsIn(s.doc, h.id).length)).toEqual([13, 13]);
    expect(hands.every((h) => isZone(h))).toBe(true); // dealt into their seats
    expect(cardsIn(s.doc, zoneNamed(s, 'Main').id)).toHaveLength(0);
    expect(cardsIn(s.doc, zoneNamed(s, 'Set aside').id)).toHaveLength(26);
    expect(s.log.length).toBe(logBefore + 1);
    expect(lastLog(s)).toMatch(/^ran ▶ Deal Tiến Lên: shuffled .*; dealt/);
    expect(s.undoManager.undoStack.length).toBe(1);
    s.undo();
    expect(cardsIn(s.doc, zoneNamed(s, 'Main').id)).toHaveLength(52);
  });
  it('New round: everything back into Main, face down, shuffled', () => {
    const s = tienlen();
    run(s, 'Deal Tiến Lên');
    const seat = s.doc.nodes.find(isHand)!;
    const played = cardsIn(s.doc, seat.id).slice(0, 3).map((c) => c.id);
    s.dispatch('cards.drop', { target: zoneNamed(s, 'Pile').id, ids: played });
    expect(cardsIn(s.doc, zoneNamed(s, 'Pile').id).every((c) => card(c).faceUp)).toBe(true);
    const order = cardsIn(s.doc, zoneNamed(s, 'Set aside').id).map((c) => c.id);
    run(s, 'New round');
    const main = cardsIn(s.doc, zoneNamed(s, 'Main').id);
    expect(main).toHaveLength(52);
    expect(main.every((c) => !card(c).faceUp)).toBe(true);
    expect(main.slice(0, order.length).map((c) => c.id)).not.toEqual(order);
  });
  it('Clear the pile: stops on an empty pile; else moves it face down and logs', () => {
    const s = tienlen();
    expect(run(s, 'Clear the pile').changes).toEqual([]);
    expect(lastLog(s)).toBe('ran ▶ Clear the pile (nothing to do)');
    run(s, 'Deal Tiến Lên');
    const seat = s.doc.nodes.find(isHand)!;
    s.dispatch('cards.drop', { target: zoneNamed(s, 'Pile').id, ids: [cardsIn(s.doc, seat.id)[0].id] });
    run(s, 'Clear the pile');
    expect(cardsIn(s.doc, zoneNamed(s, 'Pile').id)).toHaveLength(0);
    expect(cardsIn(s.doc, zoneNamed(s, 'Set aside').id).every((c) => !card(c).faceUp)).toBe(true);
    expect(lastLog(s)).toMatch(/everyone passed/);
  });
  it('a missing target is skipped and told, the other steps still run', () => {
    const s = tienlen();
    const b = button(s, 'New round');
    s.dispatch('auto.edit', { id: b.id, steps: [{ do: 'shuffle', target: { name: 'Nope' } }, { do: 'log', text: 'still here' }] });
    run(s, 'New round');
    expect(lastLog(s)).toBe('ran ▶ New round: still here; (step 1: nothing matches “Nope”)');
  });
  it('rule: "Someone went out" holds while every hand has cards, fires when one empties', () => {
    const s = tienlen([ME]);
    s.dispatch('auto.edit', { id: button(s, 'Deal Tiến Lên').id, steps: [{ do: 'deal', from: { name: 'Main' }, count: 2 }] });
    run(s, 'Deal Tiến Lên', [ME]);
    const seat = s.doc.nodes.find(isHand)!;
    const [a, b] = cardsIn(s.doc, seat.id);
    run(s, 'Someone went out');
    expect(lastLog(s)).toBe('ran ▶ Someone went out (nothing to do)');
    s.dispatch('cards.drop', { target: zoneNamed(s, 'Pile').id, ids: [a.id, b.id] });
    run(s, 'Someone went out');
    expect(lastLog(s)).toMatch(/played their last card/);
  });
});

describe('retro board', () => {
  it('Next phase cycles the phase note and restarts the timebox (clock not undone)', () => {
    const s = store();
    s.dispatch('auto.retro', { x: 0, y: 0 });
    const phase = () => resolve(s.doc, { kind: 'text', name: 'Phase' })[0].text;
    expect(phase()).toBe('Brainstorm');
    run(s, 'Next phase');
    expect(phase()).toBe('Group');
    const c = clock(s.doc.nodes.find(isClock)!);
    expect(c.run).toBe(0);
    expect(c.since).toBe(5000);
    s.undo();
    expect(phase()).toBe('Brainstorm');
    expect(clock(s.doc.nodes.find(isClock)!).run).toBe(0); // time doesn't go back
    for (let i = 0; i < 4; i++) run(s, 'Next phase');
    expect(phase()).toBe('Brainstorm'); // wraps around
  });
  it('Park moves notes from one area into another, laid out inside it', () => {
    const s = store();
    s.dispatch('auto.retro', { x: 0, y: 0 });
    expect(resolve(s.doc, { kind: 'text', in: 'To improve' })).toHaveLength(3);
    run(s, 'Park “To improve”');
    expect(resolve(s.doc, { kind: 'text', in: 'To improve' })).toHaveLength(0);
    const parked = resolve(s.doc, { kind: 'text', in: 'Parked' });
    expect(parked).toHaveLength(3);
    expect(new Set(parked.map((n) => `${n.x},${n.y}`)).size).toBe(3);
    expect(lastLog(s)).toMatch(/moved 3 to Parked/);
  });
});

describe('as data', () => {
  it('buttons survive a save/load and sync to another peer as plain JSON', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u));
    const s1 = store(a);
    const s2 = store(b);
    s1.dispatch('auto.tienlen', { x: 0, y: 0, players: [ME] });
    expect(s2.doc.nodes.filter(isButton)).toHaveLength(4);
    const file = JSON.parse(serialize(s1.exportDoc()));
    const deal = file.nodes.find((n: any) => n['x-auto']?.name === 'Deal Tiến Lên');
    expect(deal.text).toBe('▶ Deal Tiến Lên');
    expect(deal['x-auto'].steps[1]).toEqual({ do: 'deal', from: { name: 'Main' }, count: 13 });
    const s3 = store();
    s3.load(parse(JSON.stringify(file)));
    run(s3, 'Deal Tiến Lên', [ME]);
    expect(cardsIn(s3.doc, zoneNamed(s3, 'Set aside').id)).toHaveLength(39);
  });
});
