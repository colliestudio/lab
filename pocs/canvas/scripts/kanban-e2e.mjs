// Headless check of the kanban node in a real browser against a scratch canvas serve.
//
//   node --import tsx scripts/kanban-e2e.mjs [--port 5321] [--dir /tmp/kb-e2e] [--fixture <a Backlog.md project>]
//
// Needs `pnpm build` (the serve serves dist/). Everything happens in --dir: a copy of the fixture (the
// fixture is only read; the default one is generated here), the boards folder, a git repo around the copy
// so the file diffs can be read. Never use the real backlog as --dir; the script refuses a --dir inside
// the fixture. It starts its own serve (killed at the end) and never touches port 5310 or 5222.
//
//  1. two pages A and B open the board; the kanban node is added from the kit; columns and cards show
//  2. a drag in A moves the card in B, and the copy's git diff is status + updated_date (+ordinal)
//  3. quick add, and a paste of three lines
//  4. the panel: ticking a criterion changes one line of the file
//  5. an outside edit (backlog CLI or sed) shows on both pages within 2 s
//  6. a conflict: the file wins, a notice comes up
//  7. an agent (`canvas kanban move`, `canvas kanban`) works through the serve
//  8. undo in A puts the status back in the file
//  9. a page that is not a serve board shows the node as not live

import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { newTaskFile } from '../src/plugins/kanban/markdown.ts';
import { CLI_CONFIG } from '../src/plugins/kanban/fixtures.ts';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const PORT = Number(opt('--port', 5321));
const DIR = resolve(opt('--dir', '/tmp/kb-e2e'));
const FIXTURE = opt('--fixture', '');
if (PORT === 5310 || PORT === 5222 || PORT === 5231) throw new Error(`port ${PORT} belongs to a real serve or bridge`);
if (FIXTURE && (DIR === resolve(FIXTURE) || DIR.startsWith(resolve(FIXTURE) + '/'))) throw new Error('--dir must not be inside the fixture');
const PROJ = join(DIR, 'proj');
const TASKS = join(PROJ, 'backlog', 'tasks');
const BOARDS = join(DIR, 'boards');
const URL = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await cond()) return true;
    } catch {
      /* retry */
    }
    if (Date.now() > end) {
      check(false, `timed out: ${what}`);
      return false;
    }
    await sleep(80);
  }
};

// ---- scratch folders
rmSync(DIR, { recursive: true, force: true });
mkdirSync(BOARDS, { recursive: true });
if (FIXTURE) cpSync(FIXTURE, PROJ, { recursive: true });
else {
  mkdirSync(TASKS, { recursive: true });
  mkdirSync(join(PROJ, 'backlog', 'archive', 'tasks'), { recursive: true });
  writeFileSync(join(PROJ, 'backlog.config.yml'), CLI_CONFIG);
  const day = 86_400_000;
  const mk = (id, title, over = {}, ago = 10) => newTaskFile(id, { title, status: 'To Do', ...over }, new Date(Date.now() - ago * day));
  const files = {
    'task-1 - First.md': mk('TASK-1', 'First task', { labels: ['canvas'], ordinal: 1000, description: 'About the first', ac: [{ text: 'one', done: false }, { text: 'two', done: false }] }),
    'task-2 - Second.md': mk('TASK-2', 'Second task', { ordinal: 2000, priority: 'high' }),
    'task-3 - Third.md': mk('TASK-3', 'Third task', { status: 'In Progress', ordinal: 3000, assignee: ['@claude'] }),
    'task-4 - Fresh.md': mk('TASK-4', 'Fresh done', { status: 'Done', ordinal: 4000 }, 2),
    'task-5 - Old.md': mk('TASK-5', 'Old done', { status: 'Done', ordinal: 5000 }, 40),
  };
  for (const [n, t] of Object.entries(files)) writeFileSync(join(TASKS, n), t);
  writeFileSync(join(PROJ, 'backlog', 'archive', 'tasks', 'task-9 - Archived.md'), mk('TASK-9', 'Archived'));
}
const git = (...a) => execFileSync('git', a, { cwd: PROJ, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'e2e@example.com');
git('config', 'user.name', 'e2e');
git('add', '-A');
git('commit', '-qm', 'fixture');
const file = (id) => join(TASKS, readdirSync(TASKS).find((n) => n.toLowerCase().startsWith(`${id.toLowerCase()} - `)));
const diff = () => git('diff', '-U0', '--no-color').split('\n').filter((l) => (l[0] === '+' || l[0] === '-') && !l.startsWith('+++') && !l.startsWith('---'));
const commit = () => (git('add', '-A'), git('commit', '-qm', 'step', '--allow-empty'));

// ---- the serve
const children = [];
const spawnKilled = (cmd, a, env = {}) => {
  const c = spawn(cmd, a, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  c.out = '';
  c.stdout.on('data', (d) => (c.out += d));
  c.stderr.on('data', (d) => (c.out += d));
  children.push(c);
  return c;
};
const stopAll = () => children.forEach((c) => c.kill('SIGTERM'));
const free = (p) => new Promise((r) => net.createServer().once('error', () => r(false)).listen(p, '127.0.0.1', function () { this.close(() => r(true)); }));
if (!(await free(PORT))) throw new Error(`port ${PORT} is in use`);
// exits on its own after 10 minutes (the Mini has no `timeout`)
const serve = spawnKilled('perl', ['-e', 'alarm shift; exec @ARGV', '600', process.execPath, '--import', 'tsx', 'server/serve.ts', BOARDS, '--port', String(PORT), '--kanban', `demo=${PROJ}`, '--app', 'dist']);
await until(async () => (await fetch(`${URL}/api/info`).catch(() => null))?.ok, 'the serve answers', 20000);
const info = await (await fetch(`${URL}/api/info`)).json();
check(JSON.stringify(info.kanban) === '["demo"]' && !JSON.stringify(info).includes(DIR), '/api/info lists the folder name, not its path');
await fetch(`${URL}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'kb' }) });

const env = { CANVAS_SERVE: URL, CANVAS_BRIDGE: URL };
const canvas = (...a) => execFileSync('node', ['--import', 'tsx', 'bridge/cli.ts', '--canvas', 'kb', '--as', 'Claude', ...a], { env: { ...process.env, ...env }, encoding: 'utf8' });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let staticSrv;
try {
  const open = async (name, url) => {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    await ctx.addInitScript(`localStorage.setItem('canvas-poc:player', JSON.stringify({id:'${name.toLowerCase()}-id',name:'${name}',color:'#3b5bdb',named:true}))`);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, `${name} page error: ${e.message}`));
    await page.goto(url);
    await page.waitForFunction(() => window.app?.hosted === 'served' && window.app.store.doc.nodes.length >= 0, null, { timeout: 15000 });
    await page.evaluate(() => {
      window.__told = [];
      window.app.onNotify((m) => window.__told.push(m));
    });
    return page;
  };
  const A = await open('Alice', `${URL}/b/kb`);
  const B = await open('Bob', `${URL}/b/kb`);
  const tasks = (p) => p.evaluate(() => window.app.store.doc.nodes.filter((n) => n['x-kanban']?.kind === 'task').map((n) => ({ id: n.id, ...n['x-kanban'] })));
  const status = async (p, tid) => (await tasks(p)).find((t) => t.taskId === tid)?.status;
  const nodeId = async (p, tid) => (await tasks(p)).find((t) => t.taskId === tid)?.id;

  // 1. the node
  const kits = await A.evaluate(() => window.app.kits.map((k) => k.label));
  check(kits.includes('Kanban board (Backlog.md)'), 'the Add menu has a kanban kit');
  await A.evaluate(() => window.app.kits.find((k) => k.id === 'kanban.board').create(window.app, window.app.viewCenter()));
  await until(async () => (await tasks(A)).length === 5 && (await tasks(B)).length === 5, 'A and B have the five tasks');
  await A.evaluate(() => window.app.view.fit());
  await B.evaluate(() => window.app.view.fit());
  await A.waitForSelector('.kb-card');
  const names = await A.$$eval('.kb-col-name', (e) => e.map((x) => x.textContent));
  check(JSON.stringify(names) === '["To Do","In Progress","Done"]', `columns from the config: ${names}`);
  check((await A.$$('.kb-card')).length === 3, 'three cards (To Do 2, In Progress 1); Done is rows');
  check((await A.$$('.kb-row')).length === 1 && (await A.textContent('.kb-board')).includes('+1 older'), 'Done shows the recent task as a row and "+1 older"');
  check((await A.textContent('.kb-board')).includes('live · demo'), 'the node says live');
  check(!(await A.content()).match(/showDirectoryPicker|Open folder/), 'no folder picker anywhere');
  await A.screenshot({ path: join(DIR, '1-board.png') });
  commit();

  // 2. a drag
  const card = async (p, tid) => (await p.evaluate((id) => window.app.view.boxOf(id)?.getBoundingClientRect().toJSON(), await nodeId(p, tid)));
  const drag = async (p, from, to) => {
    await p.mouse.move(from.x, from.y);
    await p.mouse.down();
    await p.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await p.mouse.move(to.x, to.y, { steps: 8 });
    await sleep(120);
    await p.mouse.up();
  };
  const c2 = await card(A, 'TASK-2');
  const c3 = await card(A, 'TASK-3');
  await drag(A, { x: c2.x + 40, y: c2.y + 30 }, { x: c3.x + 40, y: c3.y + c3.height + 20 });
  await until(async () => (await status(A, 'TASK-2')) === 'In Progress' && (await status(B, 'TASK-2')) === 'In Progress', 'the drag shows on A and B');
  await until(() => diff().length > 0, 'the file changed');
  const d = diff();
  check(d.includes('+status: In Progress') && d.includes('-status: To Do') && d.some((l) => l.startsWith('+updated_date')) && d.every((l) => /status|updated_date|ordinal/.test(l)), `the file diff is status + updated_date (+ordinal): ${d.join(' | ')}`);
  commit();

  // 3. quick add and a paste
  const colAddBtn = async (p, i) => p.locator(`[data-action="add:${i}"]`).first();
  await (await colAddBtn(A, 0)).click();
  await A.waitForSelector('[data-quick]', { timeout: 4000 }).catch(async () => {
    check(false, `the quick-add field did not open (head: ${await A.evaluate(() => document.querySelector('.kb-col-head')?.outerHTML)}, active: ${await A.evaluate(() => document.activeElement?.className)})`);
  });
  await A.keyboard.type('Quick one');
  await A.keyboard.press('Enter');
  await until(() => readdirSync(TASKS).some((n) => /^task-10 - Quick-one\.md$/.test(n)), 'quick add made task-10 (past the archived 9) with the CLI file name');
  await until(async () => (await tasks(B)).some((t) => t.taskId === 'TASK-10' && !t.pending), 'B sees the new task');
  await (await colAddBtn(A, 1)).click();
  await A.waitForSelector('[data-quick]');
  await A.keyboard.insertText('p one\n\np two\np three');
  await A.keyboard.press('Enter');
  await until(() => ['task-11 - p-one.md', 'task-12 - p-two.md', 'task-13 - p-three.md'].every((n) => existsSync(join(TASKS, n))), 'a paste of three lines made three tasks (ids 11, 12, 13)');
  commit();

  // 4. the panel
  const c1 = await card(A, 'TASK-1');
  await A.mouse.click(c1.x + 40, c1.y + 30);
  await A.waitForSelector('.kb-panel');
  check((await A.inputValue('.kb-panel [name=description]')) === 'About the first', 'the panel shows the description');
  await A.locator('.kb-p-ac-row input[type=checkbox]').first().check();
  await until(() => /- \[x\] #1 one/.test(readFileSync(file('TASK-1'), 'utf8')), 'ticking a criterion writes the file');
  const d4 = diff().filter((l) => !l.startsWith('+updated_date') && !l.startsWith('-updated_date'));
  check(d4.length === 2 && d4.includes('+- [x] #1 one') && d4.includes('-- [ ] #1 one'), `one checkbox line changed: ${d4.join(' | ')}`);
  await until(async () => (await B.evaluate(() => window.app.store.doc.nodes.find((n) => n['x-kanban']?.taskId === 'TASK-1')?.['x-kanban'].ac[0].done)) === true, 'B sees the tick');
  await A.screenshot({ path: join(DIR, '4-panel.png') });
  await A.keyboard.press('Escape');
  await A.evaluate(() => document.activeElement?.blur());
  await sleep(100);
  check((await A.$$('.kb-panel')).length === 0, `Esc closes the panel (${(await A.$$('.kb-panel')).length} left)`);
  commit();

  // 5. an outside edit
  const t0 = Date.now();
  const haveCli = spawnSync('backlog', ['--version']).status === 0;
  if (haveCli) execFileSync('backlog', ['task', 'edit', '3', '-s', 'Done'], { cwd: PROJ });
  else writeFileSync(file('TASK-3'), readFileSync(file('TASK-3'), 'utf8').replace('status: In Progress', 'status: Done'));
  await until(async () => (await status(A, 'TASK-3')) === 'Done' && (await status(B, 'TASK-3')) === 'Done', 'an outside status change shows on both');
  check(Date.now() - t0 < 2500, `outside edit within ~2 s (${Date.now() - t0} ms)${haveCli ? ' via the backlog CLI' : ' via sed'}`);
  commit();

  // 6. a conflict
  const id1 = await nodeId(A, 'TASK-2');
  await A.evaluate((id) => window.app.dispatch('kanban.edit', { id, patch: { title: 'Mine' } }), id1);
  writeFileSync(file('TASK-2'), readFileSync(file('TASK-2'), 'utf8').replace(/^title: .*$/m, 'title: Theirs'));
  await until(async () => (await A.evaluate((id) => window.app.node(id)['x-kanban'].title, id1)) === 'Theirs', 'the file value wins on A');
  await until(async () => (await A.evaluate(() => window.__told.some((m) => /changed in the file meanwhile/.test(m)))) && (await B.evaluate(() => window.__told.some((m) => /changed in the file meanwhile/.test(m)))), 'both pages got the notice');
  await sleep(600);
  check(/^title: Theirs$/m.test(readFileSync(file('TASK-2'), 'utf8')), 'nothing was written over the file');
  commit();

  // 7. an agent
  const before7 = readFileSync(file('TASK-1'), 'utf8');
  canvas('kanban', 'move', 'TASK-1', 'In Progress');
  await until(async () => (await status(A, 'TASK-1')) === 'In Progress' && /status: In Progress/.test(readFileSync(file('TASK-1'), 'utf8')), 'canvas kanban move works');
  const text = canvas('kanban');
  check(/^demo \(demo\) · live/.test(text) && text.includes('TASK-1') && text.includes('In Progress ('), `canvas kanban reads the board:\n${text.split('\n').slice(0, 4).join('\n')}`);
  check(before7 !== readFileSync(file('TASK-1'), 'utf8'), 'the agent move reached the file');

  // 8. undo in A (its own steps): the drag of TASK-2 from step 2 is the last of A's undoable steps (the conflict and edits came after)
  await A.evaluate(() => {
    while (window.app.store.undoManager.undoStack.length > 0 && !window.app.store.undoManager.undoStack.at(-1).meta.get('events')?.some?.((e) => /moved TASK-2/.test(e.text))) window.app.store.undoManager.undoStack.pop();
  });
  await A.evaluate(() => window.app.store.undo());
  await until(async () => (await status(B, 'TASK-2')) === 'To Do' && /status: To Do/.test(readFileSync(file('TASK-2'), 'utf8')), 'undo puts the status back in the file and on B');

  await B.screenshot({ path: join(DIR, '8-b.png') });

  // 9. a page that is not a serve board
  staticSrv = http.createServer((req, res) => {
    const p = req.url === '/' || !req.url.includes('.') ? '/index.html' : req.url.split('?')[0];
    try {
      const body = readFileSync(join('dist', p));
      res.setHeader('content-type', p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  const sport = await new Promise((r) => staticSrv.listen(0, '127.0.0.1', () => r(staticSrv.address().port)));
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
  const L = await ctx.newPage();
  L.on('pageerror', (e) => check(false, `local page error: ${e.message}`));
  await L.goto(`http://127.0.0.1:${sport}/`);
  await L.waitForFunction(() => window.app?.hosted === null && !!window.app.kits.length);
  await L.evaluate(() => (window.__told = [], window.app.onNotify((m) => window.__told.push(m))));
  await L.evaluate(() => window.app.kits.find((k) => k.id === 'kanban.board').create(window.app, window.app.viewCenter()));
  await sleep(300);
  check(await L.evaluate(() => window.__told.some((m) => /needs a canvas serve/.test(m))), 'adding a kanban node on a local board says it needs a serve');
  await L.evaluate(() => window.app.dispatch('kanban.addBoard', { x: 0, y: 0, source: 'demo' }));
  await L.waitForSelector('.kb-board');
  check((await L.textContent('.kb-board')).includes('not live here') && !(await L.$('.kb-add')), 'a kanban node on a local board is read-only and says so');
  await ctx.close();
} finally {
  await browser.close();
  staticSrv?.close();
  stopAll();
  await sleep(400);
}
console.log(failed ? `\n${failed} check(s) failed (scratch: ${DIR}, serve output below)\n${serve.out.slice(-1500)}` : `\nall checks passed (screenshots in ${DIR})`);
process.exit(failed ? 1 : 0);
