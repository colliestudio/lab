import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { WebSocket } from 'ws';
import { freePort, root, until } from '../bridge/process.test-util';
import { registerCoreCommands } from '../src/core/commands';
import { Store } from '../src/core/store';
import { registerPluginLogic } from '../src/plugins/logic';
import { CLI_CONFIG } from '../src/plugins/kanban/fixtures';
import { newTaskFile, parseTask, stamp } from '../src/plugins/kanban/markdown';
import { FIELD, board as boardField, column, isBoard, isTask, task, tasksOf } from '../src/plugins/kanban/model';

// The kanban node on a served board, end to end: a real `canvas serve` process on scratch folders (the
// boards, a Backlog.md project, a canary project it was not given), viewers over WebSocket, agents over
// HTTP, outside edits on the files. Ports are free ones, folders are temp; nothing real is touched.

const day = 86_400_000;
const when = (daysAgo: number) => new Date(Date.now() - daysAgo * day);
const mk = (id: string, title: string, over: Partial<Parameters<typeof newTaskFile>[1]> = {}, at = when(10)) => newTaskFile(id, { title, status: 'To Do', ...over }, at);

function project(dir: string, extra: Record<string, string> = {}) {
  mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(dir, 'backlog', 'archive', 'tasks'), { recursive: true });
  mkdirSync(join(dir, 'backlog', 'completed'), { recursive: true });
  writeFileSync(join(dir, 'backlog.config.yml'), CLI_CONFIG);
  const files: Record<string, string> = {
    'task-1 - First.md': mk('TASK-1', 'First', { labels: ['canvas'], ordinal: 1000, description: 'about first', ac: [{ text: 'one', done: false }, { text: 'two', done: false }] }),
    'task-2 - Second.md': mk('TASK-2', 'Second', { ordinal: 2000 }),
    'task-3 - Third.md': mk('TASK-3', 'Third', { status: 'In Progress', ordinal: 3000, priority: 'high', assignee: ['@claude'] }),
    'task-3.1 - Sub.md': mk('TASK-3.1', 'Sub of third', { parent: 'TASK-3', ordinal: 3500 }),
    'task-4 - Fresh done.md': mk('TASK-4', 'Fresh done', { status: 'Done', ordinal: 4000 }, when(2)),
    'task-5 - Old done.md': mk('TASK-5', 'Old done', { status: 'Done', ordinal: 5000 }, when(40)),
    ...extra,
  };
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, 'backlog', 'tasks', n), t);
  writeFileSync(join(dir, 'backlog', 'archive', 'tasks', 'task-9 - Archived.md'), mk('TASK-9', 'Archived'));
  writeFileSync(join(dir, 'backlog', 'completed', 'task-8 - Completed.md'), mk('TASK-8', 'Completed'));
  return join(dir, 'backlog', 'tasks');
}

let tmp: string;
const procs: ChildProcess[] = [];
const providers: WebsocketProvider[] = [];

interface Serve {
  url: string;
  proc: ChildProcess;
  boards: string;
  get(path: string): Promise<{ status: number; json: any }>;
  post(path: string, body?: unknown): Promise<{ status: number; json: any }>;
  stop(): Promise<number | null>;
}
async function startServe(boards: string, args: string[]): Promise<Serve> {
  const port = await freePort();
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server/serve.ts', boards, '--port', String(port), '--idle-ms', '60000', ...args], { cwd: root, stdio: 'ignore', env: { ...process.env, CANVAS_KANBAN: '' } });
  procs.push(proc);
  const exited = new Promise<number | null>((r) => proc.once('exit', r));
  const url = `http://127.0.0.1:${port}`;
  await until(async () => !!(await fetch(url + '/api/info').catch(() => null))?.ok);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  return {
    url,
    proc,
    boards,
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    stop: async () => {
      proc.kill('SIGTERM');
      return Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    },
  };
}

/** A browser stand-in on /ws/<name>. */
async function viewer(s: Serve, name: string) {
  const doc = new Y.Doc();
  const store = new Store({ ydoc: doc });
  registerCoreCommands(store);
  registerPluginLogic(store);
  const provider = new WebsocketProvider(`ws://${s.url.slice(7)}/ws/${encodeURIComponent(name)}`, 'canvas', doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  providers.push(provider);
  await until(() => provider.synced);
  return { store, doc, leave: () => provider.destroy(), board: () => store.doc.nodes.find(isBoard), tasks: () => tasksOf(store.doc, store.doc.nodes.find(isBoard)?.id ?? '') };
}
type Viewer = Awaited<ReturnType<typeof viewer>>;

const titles = (v: Viewer, status: string) => column(v.store.doc, v.board()!.id, status).map((t) => task(t).taskId);
const run = (s: Serve, name: string, args: unknown, as = 'Claude') => s.post('/api/boards/kb/agent/run', { as, name, args });
const look = async (s: Serve, args: object = {}) => (await s.get(`/api/boards/kb/view/kanban.board?args=${encodeURIComponent(JSON.stringify(args))}`)).json as string;
const read = (dir: string, id: string) => {
  const f = readdirSync(dir).find((n) => n.startsWith(`${id.toLowerCase()} - `))!;
  return readFileSync(join(dir, f), 'utf8');
};
const lineDiff = (a: string, b: string) => {
  const x = a.split('\n');
  const y = b.split('\n');
  return y.filter((l) => !x.includes(l)).concat(x.filter((l) => !y.includes(l)).map((l) => `-${l}`));
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-e2e-'));
});
afterAll(() => {
  for (const p of providers) p.destroy();
  for (const p of procs) p.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
});

describe('a kanban node on a served board', () => {
  let s: Serve;
  let a: Viewer;
  let b: Viewer;
  let dir: string;
  let proj: string;
  let canary: string;
  let canaryBefore: string;
  let boards: string;

  beforeAll(async () => {
    proj = join(tmp, 'proj');
    dir = project(proj);
    const other = join(tmp, 'other');
    canary = project(other, { 'task-1 - First.md': mk('TASK-1', 'CANARY do not touch') });
    canaryBefore = JSON.stringify(readdirSync(canary).map((n) => readFileSync(join(canary, n), 'utf8')));
    boards = join(tmp, 'boards');
    mkdirSync(boards);
    s = await startServe(boards, ['--kanban', `demo=${proj}`]);
    expect((await s.post('/api/boards', { name: 'kb' })).status).toBe(201);
    a = await viewer(s, 'kb');
    b = await viewer(s, 'kb');
  }, 60000);

  it('lists the folder names the serve was given, never their paths (C76)', async () => {
    const info = (await s.get('/api/info')).json;
    expect(info.kanban).toEqual(['demo']);
    expect(JSON.stringify(info)).not.toContain(tmp);
  });

  it('adding a node shows the columns and a card per task of the folder; archive and completed never (C4)', async () => {
    a.store.dispatch('kanban.addBoard', { x: 0, y: 0, source: 'demo' });
    await until(() => !!a.board() && boardField(a.board()!).state?.live === true && a.tasks().length === 6);
    expect(boardField(a.board()!)).toMatchObject({ name: 'demo', columns: ['To Do', 'In Progress', 'Done'], doneColumn: 'Done' });
    expect(titles(a, 'To Do')).toEqual(['TASK-1', 'TASK-2', 'TASK-3.1']);
    expect(titles(a, 'In Progress')).toEqual(['TASK-3']);
    expect(titles(a, 'Done')).toEqual(['TASK-4', 'TASK-5']);
    expect(a.tasks().map((t) => task(t).taskId)).not.toContain('TASK-9');
    await until(() => b.tasks().length === 6);
    // Done shows only the recent one
    expect(a.store.doc.isVisible(a.tasks().find((t) => task(t).taskId === 'TASK-4')!.id)).toBe(true);
    expect(a.store.doc.isVisible(a.tasks().find((t) => task(t).taskId === 'TASK-5')!.id)).toBe(false);
  });

  it('a drag by A reaches B; only the serve writes the file, with status and updated_date changed (C19)', async () => {
    const before = read(dir, 'TASK-2');
    const t2 = a.tasks().find((t) => task(t).taskId === 'TASK-2')!;
    a.store.dispatch('kanban.move', { board: a.board()!.id, ids: [t2.id], status: 'In Progress', index: 0 });
    await until(() => task(b.tasks().find((t) => task(t).taskId === 'TASK-2')!).status === 'In Progress');
    await until(() => read(dir, 'TASK-2') !== before);
    const diff = lineDiff(before, read(dir, 'TASK-2'));
    expect(diff.filter((l) => !l.startsWith('updated_date'))).toEqual(['status: In Progress', '-status: To Do']);
    expect(diff.some((l) => l.startsWith('updated_date'))).toBe(true);
    // the card keeps its old ordinal slot: In Progress order was fine, so no ordinal write
    expect(read(dir, 'TASK-2')).toContain('ordinal: 2000');
  });

  it('undo by A puts the status back in the file; B\'s undo stack is its own', async () => {
    const t2 = a.tasks().find((t) => task(t).taskId === 'TASK-2')!;
    b.store.undo(); // nothing of B's to undo
    expect(task(a.store.doc.get(t2.id)!).status).toBe('In Progress');
    a.store.undo();
    await until(() => parseTask(read(dir, 'TASK-2'))!.status === 'To Do');
    await until(() => task(b.tasks().find((t) => task(t).taskId === 'TASK-2')!).status === 'To Do');
  });

  it('quick add and a paste of three lines make files with the CLI naming and the next ids, past archive and completed (C16, C17)', async () => {
    const id = a.board()!.id;
    a.store.dispatch('kanban.create', { board: id, titles: ['Quick one'] });
    await until(() => existsSync(join(dir, 'task-10 - Quick-one.md')));
    a.store.dispatch('kanban.create', { board: id, titles: ['p1', '', 'p2', 'p3'], status: 'In Progress' });
    await until(() => ['task-11 - p1.md', 'task-12 - p2.md', 'task-13 - p3.md'].every((f) => existsSync(join(dir, f))));
    expect(parseTask(read(dir, 'TASK-11'))).toMatchObject({ status: 'In Progress', title: 'p1' });
    await until(() => b.tasks().filter((t) => !task(t).pending).length === 10 && b.tasks().every((t) => !task(t).pending));
    expect(b.tasks().map((t) => task(t).taskId)).toEqual(expect.arrayContaining(['TASK-10', 'TASK-11', 'TASK-12', 'TASK-13']));
    expect(read(dir, 'TASK-10')).toMatch(/^---\nid: TASK-10\ntitle: Quick one\nstatus: To Do\n/);
  });

  it('outside edits show on every viewer within 2 s: a hand edit, a new file, a removed file, an archived file (C32, C33)', async () => {
    const within = async (cond: () => boolean, ms = 2000) => {
      const t0 = Date.now();
      await until(cond, ms + 500);
      expect(Date.now() - t0).toBeLessThan(ms);
    };
    const f1 = join(dir, readdirSync(dir).find((n) => n.startsWith('task-1 -'))!);
    writeFileSync(f1, readFileSync(f1, 'utf8').replace('status: To Do', 'status: In Progress'));
    await within(() => [a, b].every((v) => task(v.tasks().find((t) => task(t).taskId === 'TASK-1')!).status === 'In Progress'));
    writeFileSync(join(dir, 'task-20 - Made outside.md'), mk('TASK-20', 'Made outside', { ordinal: 20000 }, new Date()));
    await within(() => [a, b].every((v) => v.tasks().some((t) => task(t).taskId === 'TASK-20')));
    rmSync(join(dir, 'task-20 - Made outside.md'));
    await within(() => [a, b].every((v) => !v.tasks().some((t) => task(t).taskId === 'TASK-20')));
    const arch = join(proj, 'backlog', 'archive', 'tasks');
    writeFileSync(join(arch, 'task-13 - p3.md'), readFileSync(join(dir, 'task-13 - p3.md')));
    rmSync(join(dir, 'task-13 - p3.md'));
    await within(() => [a, b].every((v) => !v.tasks().some((t) => task(t).taskId === 'TASK-13')));
    // the log says who did it
    expect(a.store.log.toArray().some((e) => e.actor?.name === 'Backlog.md' && /TASK-1 /.test(e.text))).toBe(true);
  });

  it('the backlog CLI changes show up too (C32)', async () => {
    if (spawnSync('backlog', ['--version']).status !== 0) return console.warn('kanban.e2e: backlog not on PATH, CLI case skipped');
    const r = spawnSync('backlog', ['task', 'edit', '2', '-s', 'In Progress', '-a', '@dev'], { cwd: proj, encoding: 'utf8' });
    expect(r.status).toBe(0);
    await until(() => {
      const t = a.tasks().find((x) => task(x).taskId === 'TASK-2')!;
      return task(t).status === 'In Progress' && task(t).assignee.includes('@dev');
    }, 3000);
  });

  it('a conflict: the file wins, one notice, nothing written back (C36)', async () => {
    const t = a.tasks().find((x) => task(x).taskId === 'TASK-3')!;
    // block the serve's write window: an edit and a file change in the same breath
    const f = join(dir, readdirSync(dir).find((n) => n.startsWith('task-3 -'))!);
    const orig = readFileSync(f, 'utf8');
    a.store.dispatch('kanban.edit', { id: t.id, patch: { title: 'Board title' } });
    writeFileSync(f, orig.replace('title: Third', 'title: File title'));
    await until(() => task(a.store.doc.get(t.id)!).title === 'File title' || parseTask(read(dir, 'TASK-3'))!.title === 'Board title', 3000);
    await new Promise((r) => setTimeout(r, 600));
    const final = parseTask(read(dir, 'TASK-3'))!.title;
    const shown = task(a.store.doc.get(t.id)!).title;
    expect(shown).toBe(final); // whoever won, the board and the file agree
    if (final === 'File title') expect(a.store.log.toArray().some((e) => e.type === 'kanban.conflict')).toBe(true);
  });

  it('a burst of 50 file edits ends in a consistent board (C34)', async () => {
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `task-${100 + i} - Burst ${i}.md`), mk(`TASK-${100 + i}`, `Burst ${i}`, { ordinal: 100000 + i }, new Date()));
    await until(() => [a, b].every((v) => v.tasks().filter((t) => task(t).taskId?.startsWith('TASK-1') && Number(task(t).taskId!.slice(5)) >= 100).length === 50), 5000);
    for (let i = 0; i < 50; i++) rmSync(join(dir, `task-${100 + i} - Burst ${i}.md`));
    await until(() => [a, b].every((v) => !v.tasks().some((t) => Number(task(t).taskId!.slice(5)) >= 100)), 5000);
  });

  it('agents: move, create, edit, comment and the board as text; answers say pending (C60 to C66)', async () => {
    const m = await run(s, 'kanban.move', { task: 'TASK-1', status: 'done' });
    expect(m).toMatchObject({ status: 200, json: { ok: true, result: { status: 'Done', pending: true } } });
    await until(() => parseTask(read(dir, 'TASK-1'))!.status === 'Done');
    const c = await run(s, 'kanban.create', { title: 'From an agent', labels: ['canvas'], priority: 'low' });
    expect(c.json.result).toMatchObject({ pending: true, id: expect.stringMatching(/^TASK-\d+$/) });
    const newId = c.json.result.id as string;
    await until(() => existsSync(join(dir, `${newId.toLowerCase()} - From-an-agent.md`)));
    expect(parseTask(read(dir, newId))).toMatchObject({ title: 'From an agent', priority: 'low', labels: ['canvas'], status: 'To Do' });
    const e = await run(s, 'kanban.edit', { task: 'From an agent', assignee: ['@claude'], description: 'hello', ac: { add: ['first'], check: [1] } });
    expect(e.status).toBe(200);
    await until(() => parseTask(read(dir, newId))!.ac.length === 1);
    expect(parseTask(read(dir, newId))).toMatchObject({ assignee: ['@claude'], description: 'hello', ac: [{ text: 'first', done: true }] });
    const cm = await run(s, 'kanban.comment', { task: newId, text: 'on it' }, 'Claude · task-3.48');
    expect(cm.status).toBe(200);
    await until(() => parseTask(read(dir, newId))!.comments.length === 1);
    expect(parseTask(read(dir, newId))!.comments[0]).toMatchObject({ author: '@claude', text: 'on it' });
    const text = await look(s);
    expect(text).toMatch(/^demo \(demo\) · live/);
    expect(text).toContain('To Do (');
    expect(text.length).toBeLessThan(4000);
    expect(await look(s, { task: newId })).toContain('Acceptance criteria:\n1. [x] first');
    expect(await look(s, { all: true })).toContain('TASK-5 Old done');
    expect(text).not.toContain('TASK-5 Old done');
    expect(text).toMatch(/\+1 older/);
  });

  it('agent errors name the valid values and write nothing (C61, C63, C66, C68)', async () => {
    const before = readdirSync(dir).map((n) => read(dir, n.split(' ')[0].toUpperCase()));
    const bad = await run(s, 'kanban.move', { task: 'TASK-2', status: 'Shipped' });
    expect(bad.json.error).toMatch(/no column "Shipped"; columns: To Do, In Progress, Done/);
    expect((await run(s, 'kanban.move', { task: 'TASK-777', status: 'Done' })).json.error).toMatch(/no task "TASK-777"/);
    expect((await run(s, 'kanban.edit', { task: 'TASK-1' })).json.error).toMatch(/nothing to change/);
    expect((await run(s, 'kanban.edit', { task: 'TASK-1', ac: { check: [9] } })).json.error).toMatch(/criterion #9 does not exist/);
    for (const extra of [{ path: '/tmp/other' }, { dir: '../x' }, { folder: canary }, { root: '/' }]) {
      const r = await run(s, 'kanban.create', { title: 'x', ...extra });
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toMatch(/unknown field/);
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(readdirSync(dir).map((n) => read(dir, n.split(' ')[0].toUpperCase()))).toEqual(before);
  });

  it('an agent move is undone by that agent alone, and the file follows (C67)', async () => {
    await run(s, 'kanban.move', { task: 'TASK-2', status: 'Done' }, 'Undoer');
    await until(() => parseTask(read(dir, 'TASK-2'))!.status === 'Done');
    const u = await s.post('/api/boards/kb/undo', { as: 'Undoer' });
    expect(u.json.ok).toBe(true);
    await until(() => parseTask(read(dir, 'TASK-2'))!.status !== 'Done');
    const logs = (await s.get('/api/boards/kb/log?limit=40')).json as { actor: string | null; text: string }[];
    expect(logs.some((l) => l.actor === 'Undoer' && /moved TASK-2 to Done/.test(l.text))).toBe(true);
  });

  it('two kanban nodes: commands must name one; none: a clear error (C66)', async () => {
    const first = a.board()!.id;
    a.store.dispatch('kanban.addBoard', { x: 3000, y: 0, source: 'demo' });
    await until(() => a.store.doc.nodes.filter(isBoard).length === 2);
    const r = await run(s, 'kanban.move', { task: 'TASK-1', status: 'To Do' });
    expect(r.json.error).toMatch(/there are 2 kanban nodes; say which one with board:/);
    expect((await run(s, 'kanban.move', { task: 'TASK-1', status: 'To Do', board: first })).json.ok).toBe(true);
    // remove the second node: its sync stops; the first keeps working
    const second = a.store.doc.nodes.filter(isBoard).find((n) => n.id !== first)!;
    a.store.dispatch('core.delete', { ids: [second.id] });
    await until(() => a.store.doc.nodes.filter(isBoard).length === 1);
    expect((await run(s, 'kanban.move', { task: 'TASK-1', status: 'To Do' })).json.ok).toBe(true);
  });

  it('the filter is saved on the node and a second viewer sees it (C5)', async () => {
    a.store.dispatch('kanban.filter', { board: a.board()!.id, labels: ['canvas'] });
    await until(() => boardField(b.board()!).filter?.labels?.[0] === 'canvas');
    expect(await look(s)).toContain('filter: label canvas');
  });

  it('never reads or writes a folder it was not given: the canary stays as it was (C76, C77)', async () => {
    expect(JSON.stringify(readdirSync(canary).map((n) => readFileSync(join(canary, n), 'utf8')))).toBe(canaryBefore);
    expect(JSON.stringify(a.store.doc.nodes)).not.toContain('CANARY');
    // an edit that tries to carry a path into the node: dropped
    const t = a.tasks()[0];
    a.store.dispatch('kanban.edit', { id: t.id, patch: { path: canary, folder: canary, source: 'other', taskId: '../../x' } });
    expect(JSON.stringify(task(a.store.doc.get(t.id)!))).not.toContain(canary);
    await new Promise((r) => setTimeout(r, 400));
    expect(JSON.stringify(readdirSync(canary).map((n) => readFileSync(join(canary, n), 'utf8')))).toBe(canaryBefore);
  });

  it('stops on SIGTERM promptly (watchers and timers released)', async () => {
    a.leave();
    b.leave();
    const t0 = Date.now();
    expect(await s.stop()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});

describe('after a restart and from a hand-edited board file', () => {
  it('the saved filter survives a restart; a node with a hostile path field and an unknown source name stays harmless (C5, C77, C79)', async () => {
    const proj = join(tmp, 'proj2');
    const dir = project(proj);
    const other = join(tmp, 'other2');
    const canary = project(other, { 'task-1 - First.md': mk('TASK-1', 'CANARY2') });
    const canaryBefore = JSON.stringify(readdirSync(canary).map((n) => readFileSync(join(canary, n), 'utf8')));
    const boards = join(tmp, 'boards2');
    mkdirSync(boards);
    // a board file written by hand: one node for a configured name carrying path-like fields, one for a name the serve lacks
    const node = (id: string, source: string, extra: object = {}) => ({ id, type: 'group', label: source, x: id === 'k1' ? 0 : 2000, y: 0, width: 800, height: 400, [FIELD]: { kind: 'board', source, name: source, columns: ['To Do'], defaultColumn: 'To Do', labels: [], filter: { labels: ['canvas'] }, path: canary, dir: canary, root: other, ...extra } });
    writeFileSync(join(boards, 'kb.canvas'), JSON.stringify({ 'x-canvas-format': 1, nodes: [node('k1', 'demo'), node('k2', 'nowhere'), node('k3', '../other2')], edges: [] }, null, '\t') + '\n');
    let s = await startServe(boards, ['--kanban', `demo=${proj}`]);
    let v = await viewer(s, 'kb');
    await until(() => boardField(v.store.doc.get('k1')!).state?.live === true && tasksOf(v.store.doc, 'k1').length === 6);
    expect(boardField(v.store.doc.get('k1')!).filter).toEqual({ labels: ['canvas'] });
    expect(tasksOf(v.store.doc, 'k1').map((t) => task(t).taskId)).not.toContain('CANARY2');
    await until(() => !!boardField(v.store.doc.get('k2')!).state?.error);
    expect(boardField(v.store.doc.get('k2')!).state!.error).toMatch(/no kanban folder named "nowhere" \(it has: demo\)/);
    expect(boardField(v.store.doc.get('k3')!).state!.error).toMatch(/no kanban folder named/);
    expect(tasksOf(v.store.doc, 'k2')).toHaveLength(0);
    // move something, restart, the node and its filter are still there and the card is where the file says
    v.store.dispatch('kanban.move', { board: 'k1', ids: [tasksOf(v.store.doc, 'k1').find((t) => task(t).taskId === 'TASK-2')!.id], status: 'To Do', index: 0 });
    v.store.dispatch('kanban.filter', { board: 'k1', parent: 'TASK-3' });
    await until(() => JSON.stringify(readFileSync(join(boards, 'kb.canvas'), 'utf8')).includes('TASK-3'));
    v.leave();
    expect(await s.stop()).toBe(0);
    s = await startServe(boards, ['--kanban', `demo=${proj}`]);
    v = await viewer(s, 'kb');
    await until(() => tasksOf(v.store.doc, 'k1').length === 6);
    expect(boardField(v.store.doc.get('k1')!).filter).toEqual({ labels: ['canvas'], parent: 'TASK-3' });
    // the board file holds cards for a node that is not live (stored fields), no sections, no paths, no hashes
    const saved = readFileSync(join(boards, 'kb.canvas'), 'utf8');
    expect(saved).not.toContain('"base"');
    expect(saved).not.toContain('about first');
    expect(JSON.stringify(readdirSync(canary).map((n) => readFileSync(join(canary, n), 'utf8')))).toBe(canaryBefore);
    v.leave();
    await s.stop();
    void dir;
  }, 60000);

  it('a serve with no kanban folder starts, serves other boards, and says so on a kanban node (C11, C79)', async () => {
    const boards = join(tmp, 'boards3');
    mkdirSync(boards);
    const s = await startServe(boards, []);
    expect((await s.get('/api/info')).json.kanban).toEqual([]);
    expect((await s.post('/api/boards', { name: 'kb' })).status).toBe(201);
    const v = await viewer(s, 'kb');
    v.store.dispatch('kanban.addBoard', { x: 0, y: 0, source: 'demo' });
    await until(() => !!boardField(v.store.doc.nodes.find(isBoard)!).state?.error);
    expect(boardField(v.store.doc.nodes.find(isBoard)!).state!.error).toMatch(/start it with --kanban name=path/);
    expect((await s.post('/api/boards/kb/agent/run', { as: 'x', name: 'board.add', args: { text: 'still works' } })).json.ok).toBe(true);
    v.leave();
    await s.stop();
  }, 40000);

  it('a bad --kanban value ends the start with a clear message (nothing served)', async () => {
    const boards = join(tmp, 'boards4');
    mkdirSync(boards);
    for (const [arg, msg] of [['nofolder=/nonexistent/path', /kanban nofolder: .*(no such file|not a Backlog\.md folder)/i], ['Bad Name=/tmp', /lowercase letters/], ['justaname', /expected name=path/]] as const) {
      const r = spawnSync(process.execPath, ['--import', 'tsx', 'server/serve.ts', boards, '--port', String(await freePort()), '--kanban', arg], { cwd: root, encoding: 'utf8', timeout: 20000 });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(msg);
    }
    expect(statSync(boards).isDirectory()).toBe(true);
  }, 60000);
});

describe('kanban commands write what `backlog task edit` writes (C14)', () => {
  const haveCli = spawnSync('backlog', ['--version']).status === 0;
  if (!haveCli) console.warn('kanban.e2e: `backlog` is not on PATH; the CLI equivalence tests are skipped');
  const norm = (t: string) => t.replace(/updated_date: '[^']*'/g, "updated_date: 'T'").replace(/^created: .*$/gm, 'created: T');
  const noOrdinal = (t: string) => t.replace(/^ordinal: .*\n/m, '');
  // [agent command, args, CLI args (after `task edit <n>`)]; the ordinal line is left out of the comparison: a drag writes one, the CLI's -s does not
  const OPS: [string, object, string[]][] = [
    ['kanban.move', { task: 'TASK-2', status: 'In Progress' }, ['-s', 'In Progress']],
    ['kanban.edit', { task: 'TASK-2', title: "A: new 'title' #3" }, ['-t', "A: new 'title' #3"]],
    ['kanban.edit', { task: 'TASK-2', assignee: ['@claude'] }, ['-a', '@claude']],
    ['kanban.edit', { task: 'TASK-2', labels: ['canvas', 'ui'] }, ['-l', 'canvas,ui']],
    ['kanban.edit', { task: 'TASK-2', priority: 'high' }, ['--priority', 'high']],
    ['kanban.edit', { task: 'TASK-2', description: 'First line\nsecond line' }, ['-d', 'First line\nsecond line']],
    ['kanban.edit', { task: 'TASK-2', plan: 'step 1' }, ['--plan', 'step 1']],
    ['kanban.edit', { task: 'TASK-2', notes: 'a note' }, ['--notes', 'a note']],
    ['kanban.edit', { task: 'TASK-2', ac: { add: ['first', 'second'] } }, ['--ac', 'first', '--ac', 'second']],
    ['kanban.edit', { task: 'TASK-2', ac: { check: [2] } }, ['--check-ac', '2']],
    ['kanban.edit', { task: 'TASK-2', ac: { uncheck: [2] } }, ['--uncheck-ac', '2']],
    ['kanban.edit', { task: 'TASK-2', ac: { remove: [1] } }, ['--remove-ac', '1']],
    ['kanban.comment', { task: 'TASK-2', text: 'looks good' }, ['--comment', 'looks good', '--comment-author', '@claude']],
    ['kanban.edit', { task: 'TASK-1', plan: '' }, ['--plan', '']],
  ];
  it.skipIf(!haveCli)('the same ops on a copy through the serve and on an oracle copy through the CLI end in equal files', { timeout: 90000 }, async () => {
    const a = join(tmp, 'eq-a');
    const b = join(tmp, 'eq-b');
    const dirA = project(a, { 'task-1 - First.md': mk('TASK-1', 'First', { labels: ['canvas'], ordinal: 1000, description: 'd', plan: 'p', ac: [{ text: 'one', done: false }] }) });
    const dirB = project(b, { 'task-1 - First.md': mk('TASK-1', 'First', { labels: ['canvas'], ordinal: 1000, description: 'd', plan: 'p', ac: [{ text: 'one', done: false }] }) });
    // the two copies start byte-equal (dates fixed by `mk`'s clock: rewrite B from A)
    for (const n of readdirSync(dirA)) writeFileSync(join(dirB, n), readFileSync(join(dirA, n)));
    const boards = join(tmp, 'eq-boards');
    mkdirSync(boards);
    const s = await startServe(boards, ['--kanban', `demo=${a}`]);
    expect((await s.post('/api/boards', { name: 'kb' })).status).toBe(201);
    const v = await viewer(s, 'kb');
    v.store.dispatch('kanban.addBoard', { x: 0, y: 0, source: 'demo' });
    await until(() => v.tasks().length === 6);
    for (const [name, args, cli] of OPS) {
      const id = String((args as { task: string }).task).replace('TASK-', '');
      const r = await run(s, name, args);
      expect(r.json.ok, `${name} ${JSON.stringify(args)}: ${r.json.error}`).toBe(true);
      const o = spawnSync('backlog', ['task', 'edit', id, ...cli], { cwd: b, encoding: 'utf8' });
      expect(o.status, `${cli.join(' ')}: ${o.stderr}`).toBe(0);
      const files = () => [read(dirA, `TASK-${id}`), read(dirB, `TASK-${id}`)].map((t) => noOrdinal(norm(t)));
      await until(() => files()[0] === files()[1], 4000).catch(() => {});
      const [x, y] = files();
      expect(x, `${name} ${JSON.stringify(args)}`).toBe(y);
    }
    // and every other file is still as it was
    for (const n of readdirSync(dirA).filter((n) => !/^task-[12] /.test(n))) expect(readFileSync(join(dirA, n), 'utf8'), n).toBe(readFileSync(join(dirB, n), 'utf8'));
    v.leave();
    await s.stop();
  });
});

describe('stamps', () => {
  it('the fixtures are dated by UTC like the CLI', () => {
    expect(stamp(new Date(Date.UTC(2026, 9, 16, 1, 2)))).toBe('2026-10-16 01:02');
    expect(isTask(undefined)).toBe(false);
  });
});
