import * as z from 'zod/mini';
import { describe, expect, it } from 'vitest';
import { queryNodes } from '../src/core/query';
import { buildCatalog } from './catalog';
import { Host, makeActor } from './host';

const cat = buildCatalog();
const all = cat.plugins();
const described = all.flatMap((p) => p.commands.filter((n) => cat.spec(n)));
const claude = makeActor('Claude');
const err = (r: { ok: boolean }) => (r as unknown as { error: string }).error;

describe('every spec', () => {
  it('has a description, an example that parses, and cli names that exist in its schema', () => {
    for (const name of described) {
      const s = cat.spec(name)!;
      expect(s.description.length, name).toBeGreaterThan(10);
      expect(cat.validate(name, s.example).ok, `${name} example`).toBe(true);
      const props = Object.keys(cat.jsonSchema(s.args).properties ?? {});
      for (const f of s.cli ?? []) for (const n of [...(f.pos ?? []), ...(f.rest ? [f.rest] : []), ...(f.keepNone ?? [])]) expect(props, `${name} cli ${f.verb}: ${n}`).toContain(n);
    }
    for (const v of all.flatMap((p) => p.views)) {
      const s = cat.viewSpec(v)!;
      if (s.example !== undefined) expect(cat.validate(v, s.example, 'view').ok, v).toBe(true);
    }
  });

  it('tool names are unique', () => {
    const tools = [...described.map((n) => cat.spec(n)!.tool), ...all.flatMap((p) => p.views.map((v) => cat.viewSpec(v)!.tool))].filter(Boolean);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('board, chess and the core arrows are described; every plugin that has a guide keeps it short', () => {
    for (const n of ['board.add', 'board.update', 'board.connect', 'board.disconnect', 'board.remove', 'board.sync', 'chess.move', 'chess.sit', 'chess.newgame', 'chess.takeback', 'chess.resign', 'core.connect', 'core.edge', 'core.delete', 'core.unedge', 'diagram.add']) expect(cat.spec(n), n).toBeTruthy();
    for (const id of ['board', 'chess']) {
      const p = cat.plugin(id)!;
      expect(p.title && p.summary && p.guide).toBeTruthy();
      expect(p.guide!.split('\n').length).toBeLessThanOrEqual(15);
    }
  });

  it('kanban describes move, create, edit, comment, filter, addBoard and the kanban.board view, with a short guide', () => {
    const p = cat.plugin('kanban')!;
    expect(p.title && p.summary && p.guide).toBeTruthy();
    expect(p.guide!.split('\n').length).toBeLessThanOrEqual(15);
    for (const n of ['kanban.move', 'kanban.create', 'kanban.edit', 'kanban.comment', 'kanban.filter', 'kanban.addBoard']) {
      expect(cat.spec(n), n).toBeTruthy();
      expect(cat.owner(n)).toBe('kanban');
    }
    expect(p.views).toEqual(['kanban.board']);
    expect(p.undescribed).toEqual(['kanban.expand']);
    const t = cat.helpText('kanban');
    for (const n of ['kanban.move', 'kanban.create', 'kanban.edit', 'kanban.comment']) expect(t).toContain(JSON.stringify(cat.spec(n)!.example));
    expect(t).toContain('kanban.board');
    expect(cat.helpText()).toContain('kanban -');
  });

  it('kanban commands take no path: a path-like extra field is an unknown field', () => {
    for (const [n, a] of [['kanban.create', { title: 'x' }], ['kanban.move', { task: 'TASK-1', status: 'Done' }], ['kanban.edit', { task: 'TASK-1', title: 'x' }], ['kanban.comment', { task: 'TASK-1', text: 'x' }], ['kanban.addBoard', { source: 'demo' }]] as const) {
      expect(cat.validate(n, a).ok, n).toBe(true);
      for (const extra of ['path', 'dir', 'folder', 'root', 'file']) {
        const r = cat.validate(n, { ...a, [extra]: '/tmp/other' });
        expect(r.ok, `${n} ${extra}`).toBe(false);
        expect((r as { error: string }).error).toMatch(/unknown field/);
      }
    }
    expect(cat.validate('kanban.addBoard', { source: '../x' }).ok).toBe(false);
    expect(cat.validate('kanban.addBoard', { source: '/etc' }).ok).toBe(false);
  });

  it('owners come from registration: chess.* belongs to chess, core.* to core', () => {
    expect(cat.owner('chess.move')).toBe('chess');
    expect(cat.owner('core.connect')).toBe('core');
    expect(cat.owner('chess.state')).toBe('chess');
    expect(cat.plugin('chess')!.undescribed).toContain('chess.repair');
  });
});

describe('validation errors', () => {
  const run = (name: string, args: unknown) => new Host().run(claude, name, args);

  it('a missing field is named, with the example', () => {
    const e = err(run('chess.move', {}));
    expect(e).toContain('chess.move: args.move: expected string, received undefined');
    expect(e).toContain('Example: {"move":"Nf3"}');
  });

  it('a wrong type names the field', () => {
    expect(err(run('board.add', { text: 'a', x: '1' }))).toContain('args.x: expected number, received string');
  });

  it('an unknown key is named with the known ones', () => {
    const e = err(run('chess.sit', { color: 'white', colour: 'x' }));
    expect(e).toContain('args.colour: unknown field');
    expect(e).toContain('fields: color, leave, board');
  });

  it('an unknown command lists its namespace', () => {
    const e = err(run('chess.mvoe', {}));
    expect(e).toMatch(/unknown command "chess\.mvoe"; chess has: .*chess\.move/);
    expect(err(run('nope.x', {}))).toContain('plugins: ');
  });

  it('a stray key in a nested object lists the fields of that object', () => {
    const e = err(run('board.sync', { source: 's', columns: [], items: [{ key: 'k', column: 'c', text: 't', bogus: 1 }] }));
    expect(e).toContain('args.items.0.bogus: unknown field (fields: key, column, text, color, data)');
    expect(err(run('board.sync', { source: 's', columns: [], items: [], at: { x: 1, y: 2, z: 3 } }))).toContain('args.at.z: unknown field (fields: x, y)');
  });

  it('several issues are all listed', () => {
    const e = err(run('board.add', { x: 'a', y: 'b' }));
    expect(e).toContain('args.text');
    expect(e).toContain('args.x');
    expect(e).toContain('args.y');
  });
});

describe('node references', () => {
  const h = new Host();
  h.run(claude, 'board.add', { text: 'Doing', type: 'group' });
  h.run(claude, 'board.add', { text: 'Todo thing one' });
  h.run(claude, 'board.add', { text: 'Todo thing two' });

  it('a column by title becomes its id', () => {
    const col = h.store.doc.nodes.find((n) => n.type === 'group')!;
    const r = h.run(claude, 'board.add', { text: 'Fresh', column: 'Doing' });
    expect(r.ok).toBe(true);
    const id = (r as { result: { id: string } }).result.id;
    expect(h.store.doc.carrierOf(id)).toBe(col.id);
  });

  it('an ambiguous title says how many it matches', () => {
    expect(err(h.run(claude, 'board.connect', { from: 'Todo', to: 'Doing' }))).toMatch(/"Todo" matches 2 nodes/);
  });

  it('remove takes titles', () => {
    expect(h.run(claude, 'board.remove', { nodes: ['Todo thing one'] })).toMatchObject({ ok: true, result: { changed: 1 } });
    expect(h.store.doc.nodes.some((n) => n.text === 'Todo thing one')).toBe(false);
  });
});

describe('core arrows', () => {
  it('connect, edit and remove an arrow through the specs; unedge refuses node ids', () => {
    const h = new Host();
    const a = (h.run(claude, 'diagram.add', { text: 'A' }) as { result: { id: string } }).result.id;
    const r = h.run(claude, 'diagram.add', { text: 'B', from: 'A' });
    expect(r.ok).toBe(true);
    const arrow = h.store.doc.edges[0];
    expect(arrow.fromNode).toBe(a);
    const c = h.run(claude, 'core.connect', { from: 'A', to: 'B', label: 'x', from_side: 'top' }) as { ok: true; result: { id: string } };
    expect(c.ok).toBe(true);
    expect(h.run(claude, 'core.edge', { arrow: c.result.id, label: 'y' })).toMatchObject({ ok: true });
    expect(h.store.doc.edge(c.result.id)).toMatchObject({ label: 'y', fromSide: 'top' });
    expect(err(h.run(claude, 'core.unedge', { arrows: [a] }))).toMatch(/no arrow/);
    expect(h.run(claude, 'core.unedge', { arrows: [c.result.id] })).toMatchObject({ ok: true, result: { changed: 1 } });
    expect(h.store.doc.edge(c.result.id)).toBeUndefined();
  });
});

describe('node listings', () => {
  it('carry only the plugin fields a plugin marked, as data', () => {
    const h = new Host();
    h.run(claude, 'diagram.add', { text: 'S', fill: '#fff' });
    h.run(claude, 'chess.newgame', {});
    const list = queryNodes(h.store.doc, {}, h.store.summaryExt);
    expect(list.find((n) => n.text === 'S')!.data).toMatchObject({ 'x-shape': { kind: 'rect', fill: '#fff' } });
    expect(list.filter((n) => n.data && !('x-shape' in n.data))).toEqual([]);
    expect(list.find((n) => n.ext?.includes('x-chess'))!.data).toBeUndefined();
  });
});

describe('help', () => {
  it('a plugin page has the guide, every described command with its example, the views and the undescribed list', () => {
    const t = cat.helpText('chess');
    expect(t).toContain('Sit first, then loop wait -> move.');
    for (const n of cat.plugin('chess')!.commands.filter((c) => cat.spec(c))) {
      expect(t).toContain(n);
      expect(t).toContain(JSON.stringify(cat.spec(n)!.example));
    }
    expect(t).toContain('chess.state');
    expect(t).toContain('chess.turn');
    expect(t).toContain('chess.repair');
    expect(cat.helpText()).toContain('chess -');
    expect(cat.helpText('chess', 'chess.move')).toContain('run: canvas_do');
  });

  it('json help carries the JSON Schema and example', () => {
    const j = cat.helpJson('chess') as { guide: string; commands: { name: string; args: { properties: object }; example: unknown }[]; views: unknown[] };
    expect(j.guide).toContain('Sit first');
    expect(j.commands.find((c) => c.name === 'chess.move')).toMatchObject({ example: { move: 'Nf3' }, args: { properties: { move: { type: 'string' } } } });
    expect(j.views).toHaveLength(2);
  });

  it('the locale is loaded: messages are not just "Invalid input"', () => {
    expect(z.safeParse(z.string(), 1).error!.issues[0].message).toMatch(/expected string/);
  });
});
