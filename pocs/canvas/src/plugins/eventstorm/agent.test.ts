import { describe, expect, it } from 'vitest';
import { JOBS } from '../../../agent-eval/jobs';
import { Host, makeActor } from '../../../bridge/host';
import { queryNodes } from '../../core/query';
import { toMarkdown } from './markdown';
import { isBoard } from './model';

const claude = makeActor('Claude');
const EVENTS = ['Item added to cart', 'Checkout started', 'Order placed', 'Payment received', 'Order packed', 'Order shipped'];

function run(h: Host, name: string, args: Record<string, unknown> = {}) {
  return h.run(claude, name, args);
}
function error(h: Host, name: string, args: Record<string, unknown>) {
  const r = run(h, name, args);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
}
function storm(h = new Host()) {
  const r = run(h, 'storm.createBoard', {});
  expect(r.ok).toBe(true);
  return { h, b: (r as any).result.id as string };
}

describe('event storm through the bridge', () => {
  it('every command is described, with a guide and a view', () => {
    const h = new Host();
    const p = h.catalog.plugin('eventstorm')!;
    expect(p.undescribed).toEqual([]);
    expect(p.guide).toBeTruthy();
    expect(p.views).toContain('storm.flow');
    expect(h.catalog.helpText('eventstorm')).not.toContain('Not described yet');
    expect(p.commands).toEqual(expect.arrayContaining(['storm.move', 'storm.attach']));
  });

  it('an agent runs the whole storm without positions and passes the harness grader', () => {
    const { h, b } = storm();
    expect(h.store.doc.get(b)).toBeTruthy();
    for (const t of EVENTS) expect(run(h, 'storm.add', { kind: 'event', text: t }).ok).toBe(true);
    expect((run(h, 'storm.phase', { phase: 'timeline' }) as any).result.phase).toBe('timeline');
    run(h, 'storm.phase', { phase: 'process' });
    const c = run(h, 'storm.add', { kind: 'command', text: 'Place order', on: 'Order placed' }) as any;
    expect(c.ok).toBe(true);
    expect(c.result.on).toBe(h.store.doc.nodes.find((n) => n.text === 'Order placed')!.id);
    run(h, 'storm.add', { kind: 'command', text: 'Start checkout', on: 'Checkout started' });
    run(h, 'storm.add', { kind: 'command', text: 'Add to cart', on: 'Item added to cart' });
    const bad = JOBS.storm.grade(h.store.doc).filter((x) => !x.pass);
    expect(bad).toEqual([]);
  });

  it('refuses with a reason', () => {
    const h = new Host();
    expect(error(h, 'storm.add', { kind: 'event', text: 'x' })).toMatch(/storm\.createBoard/);
    const { b } = storm(h);
    expect(error(h, 'storm.add', { kind: 'command', text: 'x' })).toMatch(/phase process.*explore.*storm\.phase/);
    run(h, 'storm.add', { kind: 'event', text: 'Order placed' });
    run(h, 'storm.phase', { phase: 'process' });
    const cmd = (run(h, 'storm.add', { kind: 'command', text: 'Place order', on: 'Order placed' }) as any).result.id;
    expect(error(h, 'storm.add', { kind: 'policy', text: 'p', on: cmd })).toMatch(/is a command, not a domain event/);
    expect(error(h, 'storm.add', { kind: 'event', text: 'e', on: 'Order placed' })).toMatch(/events don't attach/);
    expect(error(h, 'storm.add', { kind: 'event', text: 'e', lane: 'Ops' })).toMatch(/no lane “Ops”; lanes: Timeline/);
    expect(error(h, 'storm.move', { id: cmd, first: true })).toMatch(/storm\.attach/);
    expect(error(h, 'storm.move', { id: 'Order placed' })).toMatch(/one of after, before, first or lane/);
    expect(error(h, 'storm.attach', { id: 'Order placed', on: 'Order placed' })).toMatch(/domain event/);
    const q = (run(h, 'storm.add', { kind: 'hotspot', text: 'Q?' }) as any).result.id;
    expect(error(h, 'storm.add', { kind: 'event', text: 'e', after: q })).toMatch(/not on an event; give an event/);
    run(h, 'storm.dots', { dots: 1 });
    expect(run(h, 'storm.vote', { id: 'Order placed' }).ok).toBe(true);
    expect(error(h, 'storm.vote', { id: 'Order placed' })).toMatch(/no votes left on this board \(1 each\)/);
    const second = run(h, 'storm.createBoard', { label: 'Second' }) as any;
    expect(second.ok).toBe(true);
    const e = error(h, 'storm.phase', { phase: 'timeline' });
    expect(e).toContain(b);
    expect(e).toContain(second.result.id);
    expect(e).toMatch(/Pass board/);
    // a sticky ref picks its board
    expect(run(h, 'storm.add', { kind: 'command', text: 'Other', on: 'Order placed' }).ok).toBe(true);
  });

  it('results carry ids; the same phase twice changes nothing and is not an error', () => {
    const { h } = storm();
    const r = run(h, 'storm.add', { kind: 'event', text: 'A' }) as any;
    expect(h.store.doc.get(r.result.id)?.text).toBe('A');
    expect((run(h, 'storm.phase', { phase: 'timeline' }) as any).result.changed).toBeGreaterThanOrEqual(0);
    const again = run(h, 'storm.phase', { phase: 'timeline' }) as any;
    expect(again.ok).toBe(true);
    expect(again.result).toMatchObject({ phase: 'timeline', changed: 0 });
  });

  it('move reorders and reports the position; attach and lanes work by names', () => {
    const { h } = storm();
    run(h, 'storm.lanes', { lanes: ['Customer', 'Shop'] });
    for (const t of ['A', 'B', 'C']) run(h, 'storm.add', { kind: 'event', text: t });
    run(h, 'storm.phase', { phase: 'process' });
    expect((run(h, 'storm.move', { id: 'C', first: true }) as any).result.position).toBe(1);
    expect((run(h, 'storm.move', { id: 'A', after: 'B', lane: 'shop' }) as any).result.position).toBe(3);
    const hs = (run(h, 'storm.add', { kind: 'hotspot', text: 'Why?' }) as any).result.id;
    expect(run(h, 'storm.attach', { id: hs, on: 'B' }).ok).toBe(true);
    const t = h.view(claude, 'storm.flow', {}) as any;
    expect(t.events.map((e: any) => e.text)).toEqual(['C', 'B', 'A']);
    expect(t.events[2].lane).toBe('Shop');
    expect(t.events[1].attached[0].text).toBe('Why?');
  });

  it('the agent is the author in the log and the export', () => {
    const { h, b } = storm();
    run(h, 'storm.add', { kind: 'event', text: 'Order placed' });
    const entry = h.store.log.toArray().find((e) => e.type === 'storm.add')!;
    expect(entry.actor?.name).toBe('Claude');
    expect(toMarkdown(h.store.doc, h.store.doc.get(b)!)).toContain('by Claude');
  });

  it('storm.flow reads as text; listings show a sticky\'s kind', () => {
    const { h, b } = storm();
    run(h, 'storm.add', { kind: 'event', text: 'Order placed' });
    const v = h.view(claude, 'storm.flow', {});
    const text = h.store.viewSpec('storm.flow')!.text!(v);
    expect(text).toContain(`Event storm “Event storm” (${b}) · phase explore`);
    expect(text).toContain('1. Order placed (');
    const list = queryNodes(h.store.doc, {}, h.store.summaryExt);
    expect(list.find((n) => n.text === 'Order placed')!.data).toMatchObject({ 'x-storm': { st: 'event' } });
    expect(h.store.doc.nodes.some(isBoard)).toBe(true);
  });

  it('bad args name the field and show the example', () => {
    const { h } = storm();
    const e = error(h, 'storm.add', { kind: 'evnt', text: 'x' });
    expect(e).toMatch(/kind/);
    expect(e).toMatch(/Example: \{/);
  });
});
