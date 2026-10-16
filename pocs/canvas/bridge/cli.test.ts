import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_CLI } from '../src/plugins/cli';
import { catalog } from './catalog';
import { cliArgs, coerce, parseArgv } from './flags';
import { buildForms, findForm } from './forms';
import { Host, makeActor } from './host';

// Every line the CLI offered before the generic rewrite still reaches the same command with the
// same args. A line is parsed as the CLI does, run through Host.run, and the command that the store
// finally saw is compared.

const cat = catalog();
const forms = buildForms(cat);
const claude = makeActor('Claude');

function setup() {
  const h = new Host();
  const id = (r: ReturnType<Host['run']>) => (r as { result: { id: string } }).result.id;
  const col = id(h.run(claude, 'board.add', { text: 'Doing', type: 'group', x: 0, y: 0 }));
  const n = id(h.run(claude, 'board.add', { text: 'Nnn', x: 400, y: 0 }));
  const m = id(h.run(claude, 'board.add', { text: 'Mmm', x: 400, y: 300 }));
  const s = id(h.run(claude, 'diagram.add', { text: 'Sss', x: 800, y: 0, width: 160, height: 90 }));
  const e = id(h.run(claude, 'core.connect', { from: 'Nnn', to: 'Mmm' }));
  const seen: { name: string; args: any }[] = [];
  const dispatch = h.dispatch.bind(h);
  vi.spyOn(h, 'dispatch').mockImplementation((actor, name, args) => {
    seen.push({ name, args });
    return dispatch(actor, name, args);
  });
  return { h, col, n, m, s, e, seen };
}

/** Run a command line the way bin/cli does and return the last command the store ran. */
function line(h: Host, seen: { name: string; args: any }[], text: string) {
  const { pos, flags } = parseArgv(text.split(' '));
  const f = findForm(forms, pos);
  if (!f) throw new Error(`no form for ${text}`);
  const spec = f.kind === 'command' ? cat.spec(f.name)! : cat.viewSpec(f.name)!;
  const args = cliArgs(cat.jsonSchema(spec.args), f.form, pos.slice(f.words.length), flags);
  if (f.kind === 'view') return { view: f.name, args };
  seen.length = 0;
  const r = h.run(claude, f.name, args);
  if (!r.ok) throw new Error(r.error);
  return { ...seen.at(-1)!, r };
}

describe('CLI lines reach the same commands', () => {
  it('board: add-node, add-column, update, move, connect, disconnect, rm', () => {
    const { h, seen, col, n, m } = setup();
    expect(line(h, seen, 'add-node Hello --column Doing --near Nnn --color 3 --url U')).toMatchObject({ name: 'board.add', args: { text: 'Hello', url: 'U', color: '3', column: col, near: n } });
    expect(line(h, seen, 'add-node Plain --x 5 --y 6')).toMatchObject({ name: 'board.add', args: { text: 'Plain', x: 5, y: 6 } });
    expect(line(h, seen, 'add-column Done --x 900 --y 5')).toMatchObject({ name: 'board.add', args: { type: 'group', label: 'Done', x: 900, y: 5 } });
    expect(line(h, seen, 'update Nnn --text a\\nb --label L --color none')).toMatchObject({ name: 'board.update', args: { id: n, text: 'a\nb', label: 'L', color: null } });
    expect(line(h, seen, `move ${m} --dx 5 --dy 6`)).toMatchObject({ name: 'board.update', args: { id: m, dx: 5, dy: 6 } });
    expect(line(h, seen, `move ${m} --column Doing`)).toMatchObject({ name: 'board.update', args: { id: m, column: col } });
    expect(line(h, seen, `connect ${n} ${m} --label next`)).toMatchObject({ name: 'board.connect', args: { from: n, to: m, label: 'next' } });
    expect(line(h, seen, `disconnect ${n} ${m}`)).toMatchObject({ name: 'board.disconnect', args: { from: n, to: m } });
    expect(line(h, seen, `rm ${n} ${m}`)).toMatchObject({ name: 'board.remove', args: { ids: [n, m] } });
  });

  it('diagram and arrows: shape (beside, from), style, arrow, arrow-edit, arrow-rm', () => {
    const { h, seen, s, n, e } = setup();
    expect(line(h, seen, 'shape rect Hi --near Sss --side right')).toMatchObject({ name: 'diagram.add', args: { kind: 'rect', text: 'Hi', x: 800 + 160 + 90, y: 0 + 45 - 45 } });
    expect(line(h, seen, 'shape diamond Q --from Sss --x 10 --y 20 --label go')).toMatchObject({ name: 'diagram.addConnected', args: { from: s, kind: 'diamond', text: 'Q', at: { x: 10, y: 20 }, label: 'go' } });
    expect(line(h, seen, 'shape ellipse E --fill none --stroke 2 --dashed --size 20')).toMatchObject({ name: 'diagram.add', args: { kind: 'ellipse', fill: 'none', stroke: '2', dashed: true, size: 20 } });
    expect(line(h, seen, `style ${s} --text T --fill none --stroke none --dashed false --size 20 --dx 5`)).toMatchObject({ name: 'diagram.update', args: { id: s, text: 'T', fill: 'none', stroke: null, dashed: false, size: 20, dx: 5 } });
    expect(line(h, seen, `arrow ${s} ${n} --from-side top --end none --dashed --curve --color 2 --label none`)).toMatchObject({ name: 'core.connect', args: { from: s, to: n, fromSide: 'top', toEnd: 'none', dashed: true, curve: true, color: '2', label: null } });
    expect(line(h, seen, `arrow-edit ${e} --label none`)).toMatchObject({ name: 'core.edge', args: { id: e, label: null } });
    expect(line(h, seen, `arrow-rm ${e}`)).toMatchObject({ name: 'core.unedge', args: { ids: [e] } });
  });

  it('chess: new, sit, move, wait, state, takeback, resign', () => {
    const { h, seen } = setup();
    expect(line(h, seen, 'chess new --x 3 --y 4')).toMatchObject({ name: 'chess.newgame', args: { x: 3, y: 4 } });
    const board = (h.view(claude, 'chess.state', {}) as { board: string }).board;
    expect(line(h, seen, 'chess new')).toMatchObject({ name: 'chess.newgame', args: { id: board } });
    expect(line(h, seen, 'chess sit white')).toMatchObject({ name: 'chess.sit', args: { id: board, color: 'w' } });
    expect(line(h, seen, 'chess move e4')).toMatchObject({ name: 'chess.move', args: { id: board, move: 'e4' } });
    expect(line(h, seen, 'chess wait --timeout 3')).toEqual({ view: 'chess.turn', args: {} });
    expect(line(h, seen, 'chess state')).toEqual({ view: 'chess.state', args: {} });
    expect(line(h, seen, 'chess')).toEqual({ view: 'chess.state', args: {} });
    expect(line(h, seen, 'chess state --board B1')).toEqual({ view: 'chess.state', args: { board: 'B1' } });
    expect(line(h, seen, 'chess sit white --leave')).toMatchObject({ name: 'chess.sit', args: { id: board, color: 'w', leave: true } });
    h.run(claude, 'chess.sit', { color: 'white' });
    h.run(claude, 'chess.move', { move: 'd4' });
    expect(line(h, seen, 'chess takeback')).toMatchObject({ name: 'chess.takeback', args: { id: board } });
    expect(line(h, seen, 'chess resign')).toMatchObject({ name: 'chess.resign', args: { id: board } });
  });

  it('mistakes are named: unknown flag, not a number, leftover words', () => {
    const { h, seen } = setup();
    expect(() => line(h, seen, 'update Nnn --colour 3')).toThrow(/unknown flag --colour \(flags: --text/);
    expect(() => line(h, seen, 'add-node x --x abc')).toThrow(/--x: "abc" is not a number/);
    expect(() => line(h, seen, 'connect Nnn Mmm extra')).toThrow(/unexpected argument extra/);
    expect(() => line(h, seen, 'chess sit purple')).toThrow(/args\.color/);
  });
});

describe('plugin CLI extras', () => {
  it('sync-backlog and bot chess are registered, with the actor names they used before', () => {
    expect(PLUGIN_CLI.map((x) => x.verb)).toEqual(['sync-backlog', 'bot chess']);
    expect(PLUGIN_CLI[0]).toMatchObject({ as: 'Backlog.md', kind: 'tool' });
    expect(PLUGIN_CLI[1]).toMatchObject({ as: 'Bot' });
  });

  it('sync-backlog reads `backlog task list --plain` and calls board.sync', async () => {
    vi.resetModules();
    const exec = vi.fn(() => '\nTo Do:\n  [HIGH] TASK-1 - First\n');
    vi.doMock('node:child_process', () => ({ execFileSync: exec }));
    const { syncBacklog } = await import('../src/plugins/board/cli');
    const run = vi.fn(async () => ({ result: { changed: 0 } }));
    const out: string[] = [];
    await syncBacklog.run({ run, view: vi.fn(), wait: vi.fn(), log: vi.fn() } as never, { pos: [], flags: { dir: '/tmp' }, rest: ['--status', 'x'], say: (l) => out.push(l) });
    expect(exec).toHaveBeenCalledWith('backlog', ['task', 'list', '--plain', '--status', 'x'], expect.objectContaining({ cwd: '/tmp' }));
    expect(run).toHaveBeenCalledWith('board.sync', expect.objectContaining({ items: expect.any(Array) }));
    expect(out[0]).toMatch(/already up to date/);
    vi.doUnmock('node:child_process');
  });

  it('bot chess rejects a bad color before touching the bridge', async () => {
    const api = { run: vi.fn(), view: vi.fn(), wait: vi.fn(), log: vi.fn() };
    await expect(PLUGIN_CLI[1].run(api as never, { pos: [], flags: { color: 'purple' }, rest: [], say() {} })).rejects.toThrow(/--color/);
    expect(api.view).not.toHaveBeenCalled();
  });
});

describe('flag coercion', () => {
  const nullable = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  it('numbers, booleans, none, newlines, lists and JSON', () => {
    expect(coerce('x', '3', { type: 'number' })).toBe(3);
    expect(() => coerce('x', 'a', { type: 'number' })).toThrow();
    expect(coerce('dashed', 'true', { type: 'boolean' })).toBe(true);
    expect(coerce('dashed', 'false', { type: 'boolean' })).toBe(false);
    expect(() => coerce('dashed', 'maybe', { type: 'boolean' })).toThrow();
    expect(coerce('color', 'none', nullable)).toBeNull();
    expect(coerce('color', 'none', nullable, true)).toBe('none');
    expect(coerce('text', 'none', { type: 'string' })).toBe('none');
    expect(coerce('text', 'a\\nb', { type: 'string' })).toBe('a\nb');
    expect(coerce('ids', 'a,b', { type: 'array', items: { type: 'string' } })).toEqual(['a', 'b']);
    expect(coerce('at', '{"x":1,"y":2}', { type: 'object' })).toEqual({ x: 1, y: 2 });
    expect(coerce('size', 'none', { type: ['number', 'null'] })).toBeNull();
  });

  it('flag names map to snake and camel case args', () => {
    const schema = { properties: { from_side: { type: 'string' }, fromEnd: { type: 'string' } } };
    expect(cliArgs(schema, { verb: 'v' }, [], { 'from-side': 'top', 'from-end': 'none' })).toEqual({ from_side: 'top', fromEnd: 'none' });
  });

  it('parseArgv: values, bare flags, -n, and words after --', () => {
    expect(parseArgv(['a', 'b', '--x', '1', '-n', '5', '--leave', '--', 'f', 'g'])).toEqual({ pos: ['a', 'b'], flags: { x: '1', leave: 'true', n: '5' }, rest: ['f', 'g'] });
    expect(parseArgv(['--y', '-5']).flags.y).toBe('-5');
  });
});

describe('draw verbs', () => {
  it('reach the excalidraw commands with the same args as before', () => {
    const { h, seen } = setup();
    expect(line(h, seen, 'draw new --title T --x 10 --y 20')).toMatchObject({ name: 'excalidraw.create', args: { title: 'T', x: 10, y: 20 } });
    expect(line(h, seen, 'draw box Start --ref a')).toMatchObject({ name: 'excalidraw.add', args: { shapes: [expect.objectContaining({ type: 'rectangle', label: 'Start', ref: 'a' })] } });
    expect(line(h, seen, 'draw box End --type ellipse --ref b')).toMatchObject({ name: 'excalidraw.add' });
    expect(line(h, seen, 'draw arrow a b --label go')).toMatchObject({ name: 'excalidraw.add' });
    expect(line(h, seen, 'draw add [{"type":"text","text":"hi"}]')).toMatchObject({ name: 'excalidraw.add' });
    expect(line(h, seen, 'draw rm a')).toMatchObject({ name: 'excalidraw.remove', args: { ids: ['a'] } });
    expect(line(h, seen, 'draw lock')).toMatchObject({ name: 'excalidraw.frame', args: { locked: true } });
    expect(line(h, seen, 'draw fit')).toMatchObject({ name: 'excalidraw.frame', args: { view: null } });
    expect(line(h, seen, 'draw title New name')).toMatchObject({ name: 'excalidraw.frame', args: { title: 'New name' } });
    expect(line(h, seen, 'draw shapes')).toEqual({ view: 'excalidraw.shapes', args: {} });
  });
});
