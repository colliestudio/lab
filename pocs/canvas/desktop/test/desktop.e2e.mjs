// Electron end to end against a scratch canvas serve (needs `pnpm build` at the repo root for the board UI):
//   pnpm --dir desktop test:e2e      (starts its own serve on 127.0.0.1:$CANVAS_E2E_PORT, default 5233, in a temp folder)
// Windows stay hidden (CANVAS_HIDE_WINDOWS); evidence screenshots go to $CANVAS_E2E_SHOTS when set.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const root = join(desktop, '..');
const PORT = Number(process.env.CANVAS_E2E_PORT) || 5233;
const DEAD = PORT + 6;
const SHOTS = process.env.CANVAS_E2E_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const electronPath = createRequire(import.meta.url)('electron'); // desktop/node_modules, not the repo root
const children = [];
// a serve that is already there would silently become the backend (or hide that ours failed to start): refuse
const listening = (port) => new Promise((res) => {
  const c = connect(port, '127.0.0.1');
  c.once('connect', () => (c.destroy(), res(true)));
  c.once('error', () => res(false));
});
for (const port of [PORT, DEAD]) if (await listening(port)) throw new Error(`port ${port} is already in use; pick a free one with CANVAS_E2E_PORT`);
function serve(dir, port) {
  const c = spawn('perl', ['-e', 'alarm shift; exec @ARGV', '600', process.execPath, '--import', 'tsx', 'server/serve.ts', dir, '--port', String(port), '--app', 'dist'], { cwd: root, stdio: 'ignore' });
  children.push(c);
  return c;
}
async function up(port) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/info`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`serve on ${port} did not start`);
}
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`);
  if (!ok) failed++;
};
const until = async (fn, ms = 10000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
};
const launch = (userData, backend) =>
  electron.launch({ executablePath: electronPath, args: [desktop], env: { ...process.env, CANVAS_USER_DATA: userData, CANVAS_BACKEND: backend, CANVAS_HIDE_WINDOWS: '1', CANVAS_TEST: '1' } });
const titles = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
const shot = async (page, name) => SHOTS && writeFileSync(join(SHOTS, `${name}.png`), await page.screenshot());
const winByUrl = (app, re) => until(() => app.windows().find((p) => re.test(p.url())));

const boards = mkdtempSync(join(tmpdir(), 'collie-e2e-boards-'));
const user = mkdtempSync(join(tmpdir(), 'collie-e2e-user-'));
const BACKEND = `http://127.0.0.1:${PORT}`;
serve(boards, PORT);
await up(PORT);
const api = (path, body) => fetch(BACKEND + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined).then((r) => r.json());
await api('/api/boards', { name: 'Roadmap' });
await api('/api/boards', { name: 'Retro' });

let app;
try {
  // ---- first launch: Boards window
  app = await launch(user, BACKEND);
  const home = await winByUrl(app, new RegExp(`^${BACKEND}/$`));
  check('first launch shows the Boards window', !!home);
  check('Boards window title', (await titles(app)).join() === 'Boards', (await titles(app)).join());
  await until(async () => (await home.locator('body').innerText()).includes('Roadmap'));
  await shot(home, '1-boards');
  check('Boards page lists the backend boards', (await home.locator('body').innerText()).includes('Roadmap'));

  // ---- one window per board; opening an open board focuses it
  await app.evaluate(() => globalThis.__shell.openBoard('Roadmap'));
  await app.evaluate(() => globalThis.__shell.openBoard('Roadmap'));
  const roadmap = await winByUrl(app, /\/b\/Roadmap$/);
  check('board window title is the board name', (await titles(app)).includes('Roadmap'));
  check('opening a board twice keeps one window', (await titles(app)).filter((t) => t === 'Roadmap').length === 1);
  await until(() => roadmap.locator('canvas, .cv-table, #table, [data-node-id]').first().isVisible().catch(() => false), 8000);
  await new Promise((r) => setTimeout(r, 1500));
  await shot(roadmap, '2-board-window');

  // ---- links: same-backend board link opens or focuses a window; external goes to the browser
  await home.evaluate(() => (location.href = '/b/Roadmap'));
  await home.evaluate(() => window.open('/b/Retro', '_blank'));
  await until(async () => (await titles(app)).includes('Retro'));
  check('window.open of a board link opens that board window', (await titles(app)).includes('Retro'));
  check('navigating to an open board does not duplicate it', (await titles(app)).filter((t) => t === 'Roadmap').length === 1);
  check('the Boards window stayed on the list', new URL(home.url()).pathname === '/');
  await home.evaluate(() => window.open('https://example.com/x', '_blank'));
  await until(async () => (await app.evaluate(() => globalThis.__opened ?? [])).length);
  check('external link goes to the default browser', (await app.evaluate(() => globalThis.__opened))[0] === 'https://example.com/x');
  check('no window for the external link', !(await titles(app)).includes('Example Domain') && (await titles(app)).length === 3, (await titles(app)).join());

  // ---- Cmd+N path
  await app.evaluate(() => globalThis.__shell.newBoard());
  await app.evaluate(() => globalThis.__shell.newBoard());
  await until(async () => (await titles(app)).includes('Untitled 2'));
  check('new board makes Untitled, then Untitled 2, each in its window', (await titles(app)).includes('Untitled') && (await titles(app)).includes('Untitled 2'), (await titles(app)).join());
  check('the new boards exist on the backend', (await api('/api/boards')).some((b) => b.name === 'Untitled 2'));

  // ---- menus
  const menu = await app.evaluate(() => {
    const m = globalThis.__shell.menu();
    const sub = (l) => m.items.find((i) => i.label === l).submenu.items.map((i) => i.label);
    return { file: sub('File'), window: sub('Window') };
  });
  check('Window menu lists the open boards', ['Boards', 'Roadmap', 'Retro', 'Untitled'].every((n) => menu.window.includes(n)), menu.window.join());
  check('File menu has New, Open, Quick Switcher, Recent', ['New Board', 'Open Board…', 'Quick Switcher…', 'Open Recent'].every((n) => menu.file.includes(n)), menu.file.join());

  // ---- quick switcher
  await app.evaluate(() => globalThis.__shell.openSwitcher());
  const sw = await winByUrl(app, /ui\.html\?mode=switcher/);
  await until(async () => (await sw.locator('#list li').count()) > 2);
  await sw.fill('#q', 'road');
  await shot(sw, '3-switcher');
  check('switcher filters the serve boards', (await sw.locator('#list li').allInnerTexts()).join('|') === 'Roadmap|Create "road"', (await sw.locator('#list li').allInnerTexts()).join('|'));
  await sw.keyboard.press('Enter').catch(() => {}); // the switcher closes itself
  await until(() => !app.windows().includes(sw));
  check('Enter in the switcher closes it and focuses the board (no extra window)', (await titles(app)).filter((t) => t === 'Roadmap').length === 1 && !(await titles(app)).includes('Open board'));
  await app.evaluate(() => globalThis.__shell.openSwitcher());
  const sw2 = await winByUrl(app, /ui\.html\?mode=switcher/);
  await sw2.fill('#q', 'Brand new');
  await until(async () => (await sw2.locator('#list li.new').count()) === 1);
  await sw2.keyboard.press('Enter').catch(() => {}); // the switcher closes itself
  await until(async () => (await titles(app)).includes('Brand new'));
  check('switcher creates a board from the typed name', (await titles(app)).includes('Brand new') && (await api('/api/boards')).some((b) => b.name === 'Brand new'));

  // ---- the app's Cmd+O / Cmd+K win over the board page's own
  for (const key of ['o', 'k']) {
    await app.evaluate(({ BrowserWindow }, k) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Roadmap');
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['meta'] });
    }, key);
    const s = await winByUrl(app, /ui\.html\?mode=switcher/);
    check(`Cmd+${key.toUpperCase()} in a board window opens the switcher`, !!s);
    if (s) {
      await s.keyboard.press('Escape').catch(() => {});
      await until(() => !app.windows().includes(s));
    }
  }

  // ---- Backend dialog
  await app.evaluate(() => globalThis.__shell.openBackendDialog());
  const bd = await winByUrl(app, /ui\.html\?mode=backend/);
  await until(async () => (await bd.inputValue('#url')) === BACKEND);
  check('Backend dialog shows the current backend', (await bd.inputValue('#url')) === BACKEND);
  await bd.fill('#url', `127.0.0.1:${DEAD}`);
  await bd.click('#save');
  await until(async () => (await bd.locator('#err').innerText()).length);
  await shot(bd, '4-backend-dialog');
  check('an address with no serve is refused, with a way to force it', (await bd.locator('#err').innerText()).includes('No canvas serve') && (await bd.locator('#force').isVisible()));
  await bd.fill('#url', 'file:///etc');
  await bd.click('#save');
  await until(async () => (await bd.locator('#err').innerText()).includes('Not a web address'));
  check('a non-web address is refused', (await bd.locator('#err').innerText()).includes('Not a web address'));
  await bd.click('#cancel');

  // ---- relaunch restores windows
  const before = (await titles(app)).filter((t) => !['Open board', 'Backend'].includes(t)).sort();
  const boundsBefore = await app.evaluate(() => globalThis.__shell.state().windows.find((w) => w.board === 'Roadmap')?.bounds);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Roadmap').setBounds({ x: 40, y: 50, width: 900, height: 600 }));
  await new Promise((r) => setTimeout(r, 900));
  const proc = app.process();
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await until(() => proc.exitCode !== null, 8000);
  const saved = JSON.parse(readFileSync(join(user, 'state.json'), 'utf8'));
  check('state.json has the windows and the backend', saved.windows.length === before.length && saved.backend === BACKEND, JSON.stringify(saved.windows));
  app = await launch(user, BACKEND);
  await until(async () => (await titles(app)).length >= before.length);
  const after = (await titles(app)).sort();
  check('relaunch restores the same windows', JSON.stringify(after) === JSON.stringify(before), `${after} vs ${before}`);
  const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Roadmap').getNormalBounds());
  check('and their bounds', b.x === 40 && b.y === 50 && b.width === 900 && b.height === 600, JSON.stringify(b));
  check('Open Recent keeps the boards', JSON.parse(readFileSync(join(user, 'state.json'), 'utf8')).recent.includes('Roadmap'));
  await app.close();

  // ---- backend unreachable, then back
  const user2 = mkdtempSync(join(tmpdir(), 'collie-e2e-user-'));
  const DEADURL = `http://127.0.0.1:${DEAD}`;
  app = await launch(user2, DEADURL);
  const err = await winByUrl(app, /ui\.html\?mode=error/);
  check('unreachable backend shows the error screen', !!err);
  await until(async () => (await err.locator('#eurl').innerText()) === DEADURL);
  await shot(err, '5-unreachable');
  check('with the backend URL and a Retry button', (await err.locator('#eurl').innerText()) === DEADURL && (await err.locator('#retry').isVisible()));
  const boards2 = mkdtempSync(join(tmpdir(), 'collie-e2e-boards-'));
  serve(boards2, DEAD);
  await up(DEAD);
  const back = await until(async () => app.windows().find((p) => p.url() === `${DEADURL}/`), 12000);
  check('reconnects by itself when the backend comes back', !!back);
  if (back) await shot(back, '6-reconnected');
  await app.close();

  // ---- CANVAS_BACKEND without CANVAS_USER_DATA is for this run only
  const fakeHome = mkdtempSync(join(tmpdir(), 'collie-e2e-fakeHome-'));
  const env = { ...process.env, HOME: fakeHome, CANVAS_BACKEND: BACKEND, CANVAS_HIDE_WINDOWS: '1', CANVAS_TEST: '1' };
  delete env.CANVAS_USER_DATA;
  app = await electron.launch({ executablePath: electronPath, args: [desktop], env });
  await app.evaluate(() => globalThis.__shell.openBoard('Roadmap'));
  await new Promise((r) => setTimeout(r, 900));
  await app.close();
  check('a session-only backend writes no state.json', !existsSync(join(fakeHome, 'Library', 'Application Support', 'Collie Canvas', 'state.json')));

  // ---- a prototype page renders in the window (srcdoc frame; the load watch must not remove it)
  const pageBoard = {
    nodes: [{ id: 'p1', type: 'text', text: '### Page', x: 0, y: 0, width: 640, height: 426, 'x-page': { title: 'Page', html: '<h1 id="hi">Hello page</h1>', vw: 1280 } }],
    edges: [],
  };
  await api('/api/boards', { name: 'Pages', text: JSON.stringify(pageBoard) });
  app = await launch(mkdtempSync(join(tmpdir(), 'collie-e2e-user-')), BACKEND);
  await app.evaluate(() => globalThis.__shell.openBoard('Pages'));
  const pages = await winByUrl(app, /\/b\/Pages$/);
  await until(() => pages.locator('iframe.pg-frame').count().then((n) => n > 0), 10000);
  await new Promise((r) => setTimeout(r, 3500)); // past the 2 s handshake of the load watch
  check('a prototype page renders in its window', (await pages.locator('iframe.pg-frame').count()) === 1 && (await pages.frameLocator('iframe.pg-frame').locator('#hi').innerText().catch(() => '')) === 'Hello page');
  check('and is not replaced by the "left the canvas" placeholder', (await pages.locator('.pg-gone').count()) === 0, await pages.locator('.pg-gone').first().getAttribute('data-why').catch(() => ''));
  await shot(pages, '7-page');
  await app.close();
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await app?.close().catch(() => {});
  for (const c of children) c.kill();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
