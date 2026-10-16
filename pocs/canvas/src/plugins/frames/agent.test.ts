import { describe, expect, it } from 'vitest';
import { JOBS } from '../../../agent-eval/jobs';
import { Host, makeActor } from '../../../bridge/host';
import { isFrame } from './model';

const claude = makeActor('Claude');
const run = (h: Host, name: string, args: Record<string, unknown> = {}) => h.run(claude, name, args);
const ok = (h: Host, name: string, args: Record<string, unknown> = {}) => {
  const r = run(h, name, args);
  if (!r.ok) throw new Error(r.error);
  return r.result as any;
};
const error = (h: Host, name: string, args: Record<string, unknown> = {}) => {
  const r = run(h, name, args);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
};
const viewText = (h: Host, name: string, args: Record<string, unknown> = {}) => h.store.viewSpec(name)!.text!(h.view(claude, name, args));
const PARTS = ['Browser', 'API server', 'Postgres database', 'Redis cache'];

describe('frames through the bridge', () => {
  it('every command is described, with title, summary, guide and the frames.outline view', () => {
    const h = new Host();
    const p = h.catalog.plugin('frames')!;
    expect(p.undescribed).toEqual([]);
    expect(p.commands).toEqual(expect.arrayContaining(['frames.create', 'frames.include', 'frames.createPortal', 'frames.retarget']));
    expect(p.title).toBe('Frames');
    expect(p.summary).toBeTruthy();
    expect(p.guide!.split('\n').length).toBeLessThanOrEqual(15);
    expect(p.views).toContain('frames.outline');
    expect(h.catalog.helpText('frames')).not.toContain('Not described yet');
    expect(h.catalog.helpText()).not.toMatch(/frames[^\n]*Not described yet/);
  });

  it('the harness flow: shapes by title, arrows, frame around them, and the arch grader passes', () => {
    const h = new Host();
    for (const t of PARTS) ok(h, 'diagram.add', { kind: 'rect', text: t });
    for (const [a, b, l] of [[0, 1, 'HTTPS requests'], [1, 2, 'SQL queries'], [1, 3, 'cached reads']] as const) ok(h, 'core.connect', { from: PARTS[a], to: PARTS[b], label: l });
    const r = ok(h, 'frames.create', { around: PARTS, label: 'Architecture' });
    expect(r).toMatchObject({ label: 'Architecture', n: 1, inside: 4 });
    expect(r.id).toBeTruthy();
    expect(JOBS.arch.grade(h.store.doc).filter((c) => !c.pass)).toEqual([]);
  });

  it('frame first, shapes later: create without a position, include grows it, the outline lists them', () => {
    const h = new Host();
    ok(h, 'diagram.add', { kind: 'rect', text: 'Existing', x: 0, y: 0 });
    const f = ok(h, 'frames.create', { label: 'Architecture' });
    const frame = h.store.doc.get(f.id)!;
    expect(frame.x).toBeGreaterThan(160);
    expect(f.inside).toBe(0);
    ok(h, 'diagram.add', { kind: 'rect', text: 'Cache' });
    ok(h, 'diagram.add', { kind: 'rect', text: 'DB' });
    expect(h.store.doc.riders(f.id)).toHaveLength(0);
    const g = ok(h, 'frames.include', { id: 'Architecture', nodes: ['Cache', 'DB'] });
    expect(g.inside).toBe(2);
    expect(g.changed).toBeGreaterThan(0);
    const t = viewText(h, 'frames.outline');
    expect(t).toContain('1. Architecture');
    expect(t).toContain('2 inside: “Cache”');
    expect(t).toContain('Not in a frame: “Existing”');
  });

  it('refuses with a reason', () => {
    const h = new Host();
    ok(h, 'diagram.add', { kind: 'rect', text: 'Box', x: 0, y: 0 });
    ok(h, 'frames.create', { label: 'Area' });
    expect(error(h, 'frames.include', { id: 'Box', nodes: ['Box'] })).toMatch(/“Box” \(\w+\) is not a frame; frames: “Area”/);
    expect(error(h, 'frames.include', { id: 'Area', nodes: ['Area'] })).toMatch(/cannot be put in itself/);
    expect(error(h, 'frames.rename', { id: 'Box', label: 'x' })).toMatch(/not a frame or portal/);
    expect(error(h, 'frames.retarget', { id: 'Area', room: 'r' })).toMatch(/not a portal/);
    expect(error(h, 'frames.reorder', { id: 'Area', to: 0 })).toMatch(/to/);
    expect(error(h, 'frames.create', { around: [] })).toMatch(/around/);
    expect(error(h, 'frames.create', { around: ['nothing-here'] })).toMatch(/no node|nothing-here/);
    expect(error(h, 'frames.create', { x: 5 })).toMatch(/both x and y/);
    expect(error(h, 'frames.createPortal', { room: 'Bad Room' })).toMatch(/room/);
  });

  it('reorder is 1-based as the outline numbers it; skip twice is not an error', () => {
    const h = new Host();
    for (const l of ['A', 'B', 'C']) ok(h, 'frames.create', { label: l });
    expect(ok(h, 'frames.reorder', { id: 'C', to: 1 })).toMatchObject({ n: 1 });
    const lines = viewText(h, 'frames.outline').split('\n');
    expect(lines[1]).toContain('1. C');
    expect(lines[2]).toContain('2. A');
    expect(ok(h, 'frames.skip', { id: 'A' })).toMatchObject({ skipped: true });
    expect(ok(h, 'frames.skip', { id: 'A' })).toMatchObject({ skipped: true, changed: 0 });
    expect(viewText(h, 'frames.outline')).toContain('2. A') ;
    expect(viewText(h, 'frames.outline')).toContain('skipped');
    expect(ok(h, 'frames.skip', { id: 'A', skip: false }).changed).toBeGreaterThan(0);
  });

  it('rename, resize, unframe, portals', () => {
    const h = new Host();
    ok(h, 'diagram.add', { kind: 'rect', text: 'Inner', x: 0, y: 0 });
    const f = ok(h, 'frames.create', { around: ['Inner'] }).id;
    expect(ok(h, 'frames.rename', { id: f, label: 'Plan' })).toMatchObject({ label: 'Plan', changed: 1 });
    expect(ok(h, 'frames.resize', { id: 'Plan', width: 1000, height: 700 })).toMatchObject({ width: 1000, height: 700 });
    const p = ok(h, 'frames.createPortal', { room: 'sprint-12', label: 'Sprint 12' }).id;
    expect(ok(h, 'frames.retarget', { id: 'Sprint 12', room: 'sprint-13' })).toMatchObject({ room: 'sprint-13', changed: 2 });
    expect(viewText(h, 'frames.outline')).toContain('Portals outside frames: “Sprint 12”');
    expect(p).toBeTruthy();
    expect(ok(h, 'frames.unframe', { id: 'Plan' }).changed).toBe(1);
    expect(h.store.doc.nodes.some((n) => isFrame(n))).toBe(false);
    expect(h.store.doc.nodes.some((n) => n.text === 'Inner')).toBe(true);
    expect(ok(h, 'frames.pin').changed).toBe(0);
    expect(ok(h, 'frames.sink').changed).toBe(0);
  });

  it('after the frame moves, its contents go along', () => {
    const h = new Host();
    ok(h, 'diagram.add', { kind: 'rect', text: 'A', x: 0, y: 0 });
    const f = ok(h, 'frames.create', { around: ['A'] }).id;
    ok(h, 'diagram.add', { kind: 'rect', text: 'B', x: 3000, y: 0 });
    ok(h, 'frames.include', { id: f, nodes: ['B'] });
    ok(h, 'core.move', { ids: [f], dx: 100, dy: 0 });
    expect(h.store.doc.nodes.find((n) => n.text === 'B')!.x).toBe(3100);
  });
});
