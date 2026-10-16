import { describe, expect, it } from 'vitest';
import { Store, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { eventsOn } from './commands';
import { flowOf, flowText } from './flow';
import { registerStormLogic } from './logic';

function build(lanes?: string[]) {
  let n = 0;
  const ctx: CommandCtx = { newId: () => `i${++n}`, random: () => 0.5, now: () => 1000 };
  const s = new Store({ ctx });
  registerCoreCommands(s);
  registerStormLogic(s);
  const b = s.dispatch('storm.createBoard', { x: 0, y: 0, lanes, label: 'Checkout' }).select![0];
  const add = (kind: string, text: string, more: Record<string, unknown> = {}) => s.dispatch('storm.add', { board: b, kind, text, ...more }).select![0];
  const flow = () => flowOf(s.doc, s.doc.get(b)!);
  return { s, b, add, flow };
}

describe('storm flow', () => {
  it('one lane: numbered timeline, attachments in flow order, ids, no lane tags', () => {
    const { s, b, add, flow } = build();
    const e1 = add('event', 'Item added to cart');
    add('event', 'Checkout started');
    s.dispatch('storm.phase', { board: b, phase: 'process' });
    const pol = add('policy', 'Take payment', { on: e1 });
    const cmd = add('command', 'Add item', { on: e1 });
    const act = add('actor', 'Shopper', { on: e1 });
    const t = flowText(flow());
    expect(t).toContain(`Event storm “Checkout” (${b}) · phase process · offers event, hotspot, command, actor, policy, read, external`);
    expect(t.split('\n').filter((l) => /^\s+(actor|command|policy):/.test(l))).toEqual([`      actor: Shopper (${act})`, `      command: Add item (${cmd})`, `      policy: Take payment (${pol})`]);
    expect(t).toContain(` 1. Item added to cart (${e1})\n`);
    expect(t).not.toMatch(/\[Timeline\]|By lane/);
  });

  it('three lanes: lane tags, a By lane line, loose stickies with their lane', () => {
    const { add, flow } = build(['Customer', 'Shop', 'Warehouse']);
    add('event', 'A', { lane: 0 });
    add('event', 'B', { lane: 0 });
    add('event', 'C', { lane: 1 });
    add('event', 'D', { lane: 2 });
    const h = add('hotspot', 'Guest checkout?', { lane: 0 });
    const t = flowText(flow());
    expect(t).toContain('Lanes: Customer | Shop | Warehouse');
    expect(t).toContain('By lane: Customer 1-2 · Shop 3 · Warehouse 4');
    expect(t).toMatch(/ 3\. C \(i\d+\) \[Shop\]/);
    expect(t).toContain(`Not on an event:\n  hotspot: Guest checkout? (${h}) [Customer]`);
  });

  it('next step per phase, and nothing when done', () => {
    const { s, b, add, flow } = build();
    expect(flowText(flow())).toContain('Timeline: none yet');
    expect(flow().next).toBeUndefined();
    const e1 = add('event', 'A');
    const e2 = add('event', 'B');
    expect(flow().next).toMatch(/switch to timeline/);
    s.dispatch('storm.phase', { board: b, phase: 'timeline' });
    expect(flow().next).toMatch(/storm\.phase.*process/);
    s.dispatch('storm.phase', { board: b, phase: 'process' });
    add('command', 'Do A', { on: e1 });
    expect(flow().next).toBe('1 event has no command yet: B.');
    add('command', 'Do B', { on: e2 });
    expect(flow().next).toBeUndefined();
    expect(eventsOn(s.doc, b)).toHaveLength(2);
  });
});
