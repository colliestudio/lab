import { describe, expect, it } from 'vitest';
import { Host, makeActor } from '../../../bridge/host';

const claude = makeActor('Claude');
const run = (h: Host, name: string, args: Record<string, unknown> = {}) => h.run(claude, name, args);
const ok = (h: Host, name: string, args: Record<string, unknown> = {}) => {
  const r = run(h, name, args);
  if (!r.ok) throw new Error(r.error);
  return r.result as any;
};
const viewText = (h: Host, name: string, args: Record<string, unknown> = {}) => h.store.viewSpec(name)!.text!(h.view(claude, name, args));

describe('diagram through the bridge', () => {
  it('every command is described, with a guide and the diagram.graph view', () => {
    const h = new Host();
    const p = h.catalog.plugin('diagram')!;
    expect(p.undescribed).toEqual([]);
    expect(p.commands).toContain('diagram.resize');
    expect(p.guide).toBeTruthy();
    expect(p.guide!.split('\n').length).toBeLessThanOrEqual(15);
    expect(p.views).toContain('diagram.graph');
    expect(h.catalog.helpText('diagram')).not.toContain('Not described yet');
  });

  it('add with from returns the shape and the arrow id; the arrow id works with core.edge', () => {
    const h = new Host();
    ok(h, 'diagram.add', { kind: 'rect', text: 'Browser' });
    const r = ok(h, 'diagram.add', { from: 'Browser', text: 'API', label: 'HTTPS' });
    expect(r.id).toBeTruthy();
    expect(r.arrow).toBeTruthy();
    expect(h.store.doc.edge(r.arrow)?.label).toBe('HTTPS');
    expect(ok(h, 'core.edge', { arrow: r.arrow, label: 'REST' }).changed).toBe(1);
    expect(h.store.doc.edge(r.arrow)?.label).toBe('REST');
    expect(ok(h, 'diagram.add', { kind: 'ellipse', text: 'DB' }).arrow).toBeUndefined();
    expect(ok(h, 'diagram.addConnected', { from: 'API', text: 'Cache', label: 'reads' }).arrow).toBeTruthy();
  });

  it('resize sets the whole box by title', () => {
    const h = new Host();
    const id = ok(h, 'diagram.add', { kind: 'rect', text: 'Start', x: 10, y: 10 }).id;
    expect(ok(h, 'diagram.resize', { node: 'Start', x: 0, y: 5, width: 200, height: 100 })).toMatchObject({ id, changed: 4 });
    expect(h.store.doc.get(id)).toMatchObject({ x: 0, y: 5, width: 200, height: 100 });
    expect(run(h, 'diagram.resize', { node: 'Start', width: 200 }).ok).toBe(false);
  });

  it('diagram.graph reads as text, with the frame and the in filter', () => {
    const h = new Host();
    for (const t of ['Browser', 'API server', 'Database']) ok(h, 'diagram.add', { kind: 'rect', text: t });
    ok(h, 'diagram.add', { kind: 'rect', text: 'Elsewhere', x: 5000, y: 0 });
    ok(h, 'core.connect', { from: 'Browser', to: 'API server', label: 'HTTPS requests' });
    ok(h, 'core.connect', { from: 'API server', to: 'Database' });
    ok(h, 'frames.create', { around: ['Browser', 'API server', 'Database'], label: 'Architecture' });
    const t = viewText(h, 'diagram.graph');
    expect(t).toMatch(/^Diagram: 4 shapes, 2 arrows\nShapes:\n {2}rect “Browser” \(\w+\) · -?\d+,-?\d+ 160x80 · in Architecture/);
    expect(t).toMatch(/“Browser” \(\w+\) → “API server” \(\w+\): “HTTPS requests” \(\w+\)\n.*“API server” \(\w+\) → “Database” \(\w+\): no label/);
    const only = viewText(h, 'diagram.graph', { in: 'Architecture' });
    expect(only).toContain('Diagram: 3 shapes');
    expect(only).not.toContain('Elsewhere');
    expect(viewText(new Host(), 'diagram.graph')).toBe('No diagram shapes yet. diagram.add {kind, text} adds one.');
  });
});
