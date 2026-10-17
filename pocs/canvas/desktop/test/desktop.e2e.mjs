// Electron end to end against a scratch canvas serve (needs `pnpm build` at the repo root for the canvas UI):
//   pnpm --dir desktop test:e2e      (starts its own serve on 127.0.0.1:$CANVAS_E2E_PORT, default 5233, in a temp folder)
// Windows stay hidden (CANVAS_HIDE_WINDOWS); evidence screenshots go to $CANVAS_E2E_SHOTS when set.
// Pop-outs are separate processes this test spawns through the app; they end by CANVAS_TEST_TTL at the latest, and the test quits them over their sockets.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  electron.launch({ executablePath: electronPath, args: [desktop], env: { ...process.env, CANVAS_USER_DATA: userData, CANVAS_BACKEND: backend, CANVAS_HIDE_WINDOWS: '1', CANVAS_TEST: '1', CANVAS_TEST_TTL: '300' } });
const titles = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
const users = [];
const newUser = () => (users.push(mkdtempSync(join(tmpdir(), 'collie-e2e-user-'))), users.at(-1));
// the pop-outs of one main app's data folder, from their instance.json files
const instances = (user) => {
  const dir = join(user, 'popouts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((d) => { try { return [JSON.parse(readFileSync(join(dir, d, 'instance.json'), 'utf8'))]; } catch { return []; } });
};
const sockSend = (sock, msg) => new Promise((res) => {
  let buf = '';
  const c = connect(sock);
  const t = setTimeout(() => (c.destroy(), res(null)), 1500);
  c.on('error', () => (clearTimeout(t), res(null)));
  c.on('connect', () => c.write(JSON.stringify(msg) + '\n'));
  c.on('data', (d) => { buf += d; if (buf.includes('\n')) (clearTimeout(t), c.destroy(), res(JSON.parse(buf.split('\n')[0]))); });
});
const live = async (i) => !!i.sock && !!(await sockSend(i.sock, { cmd: 'ping' }));
const running = async (user) => (await Promise.all(instances(user).map(async (i) => ((await live(i)) ? i : null)))).filter(Boolean);
const popout = (user, name) => until(async () => { const i = instances(user).find((x) => x.canvas === name && x.url && x.icon); return i && (await live(i)) ? i : null; }, 25000);
const quitPopouts = async (user, forget = false) => { for (const i of await running(user)) await sockSend(i.sock, { cmd: 'quit', forget }); await until(async () => !(await running(user)).length, 8000); };
const psArgs = (pid) => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const labels = (items) => items.flatMap((i) => [i.label, ...(i.submenu ? labels(i.submenu.items) : [])]);
const shot = async (page, name) => SHOTS && writeFileSync(join(SHOTS, `${name}.png`), await page.screenshot());
const winByUrl = (app, re) => until(() => app.windows().find((p) => re.test(p.url())));
const mainPage = (app) => app.windows().find((p) => p.url().startsWith(BACKEND) || p.url().startsWith(DEADURL0));
const DEADURL0 = `http://127.0.0.1:${DEAD}`;
const mainWindows = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.getParentWindow()).map((w) => w.getTitle()));

const boards = mkdtempSync(join(tmpdir(), 'collie-e2e-boards-'));
const user = newUser();
const BACKEND = `http://127.0.0.1:${PORT}`;
serve(boards, PORT);
await up(PORT);
const api = (path, body) => fetch(BACKEND + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined).then((r) => r.json());
await api('/api/boards', { name: 'Roadmap' });
await api('/api/boards', { name: 'Retro' });
await api('/api/boards', { name: 'Plans' });

let app;
try {
  // ---- first launch: the canvas list in the one main window
  app = await launch(user, BACKEND);
  const home = await winByUrl(app, new RegExp(`^${BACKEND}/$`));
  check('first launch shows the canvas list', !!home);
  check('main window title', (await mainWindows(app)).join() === 'Canvases', (await mainWindows(app)).join());
  await until(async () => (await home.locator('body').innerText()).includes('Roadmap'));
  await shot(home, '1-canvases');
  check('canvas list shows the backend canvases', (await home.locator('body').innerText()).includes('Roadmap'));

  // ---- inline: opening a canvas navigates the main window; back / forward
  await app.evaluate(() => globalThis.__shell.openCanvas('Roadmap'));
  await until(() => /\/b\/Roadmap$/.test(home.url()));
  check('opening a canvas navigates the main window in place', /\/b\/Roadmap$/.test(home.url()) && (await mainWindows(app)).join() === 'Roadmap', `${home.url()} ${await mainWindows(app)}`);
  await until(() => home.locator('canvas, .cv-table, #table, [data-node-id]').first().isVisible().catch(() => false), 8000);
  await new Promise((r) => setTimeout(r, 1500));
  await shot(home, '2-canvas-inline');
  await app.evaluate(() => globalThis.__shell.openCanvas('Retro'));
  await until(() => /\/b\/Retro$/.test(home.url()));
  check('a second canvas replaces the first in the same window', (await mainWindows(app)).join() === 'Retro', (await mainWindows(app)).join());
  await app.evaluate(() => globalThis.__shell.goBack());
  await until(() => /\/b\/Roadmap$/.test(home.url()));
  check('back returns to the previous canvas (title follows)', (await mainWindows(app)).join() === 'Roadmap', (await mainWindows(app)).join());
  await app.evaluate(() => globalThis.__shell.goForward());
  await until(() => /\/b\/Retro$/.test(home.url()));
  check('forward goes on', (await mainWindows(app)).join() === 'Retro');
  const goMenu = await app.evaluate(() => globalThis.__shell.menu().items.find((i) => i.label === 'Go').submenu.items.map((i) => [i.label, i.accelerator, i.enabled]));
  check('Go menu has Back and Forward on Cmd+[ and Cmd+]', goMenu[0][0] === 'Back' && goMenu[0][1] === 'CmdOrCtrl+[' && goMenu[0][2] && goMenu[1][1] === 'CmdOrCtrl+]', JSON.stringify(goMenu));

  // ---- links: a canvas link or window.open navigates in place; external goes to the browser
  await home.evaluate(() => window.open('/b/Roadmap', '_blank'));
  await until(() => /\/b\/Roadmap$/.test(home.url()));
  check('window.open of a canvas link navigates the main window (no new window)', (await mainWindows(app)).join() === 'Roadmap', (await mainWindows(app)).join());
  await home.evaluate(() => (location.href = '/'));
  await until(() => new URL(home.url()).pathname === '/');
  check('the list link goes home in the same window', (await mainWindows(app)).join() === 'Canvases');
  await home.evaluate(() => window.open('https://example.com/x', '_blank'));
  await until(async () => (await app.evaluate(() => globalThis.__opened ?? [])).length);
  check('external link goes to the default browser', (await app.evaluate(() => globalThis.__opened))[0] === 'https://example.com/x');
  check('no window for the external link', (await titles(app)).length === 1, (await titles(app)).join());

  // ---- Cmd+N path
  await app.evaluate(() => globalThis.__shell.newCanvas());
  await until(() => /\/b\/Untitled$/.test(mainPage(app)?.url() ?? ''));
  await app.evaluate(() => globalThis.__shell.newCanvas());
  await until(() => /\/b\/Untitled%202$/.test(mainPage(app)?.url() ?? ''));
  check('new canvas makes Untitled, then Untitled 2, opened in the main window', (await mainWindows(app)).join() === 'Untitled 2', (await mainWindows(app)).join());
  check('the new canvases exist on the backend', (await api('/api/boards')).some((b) => b.name === 'Untitled 2') && (await api('/api/boards')).some((b) => b.name === 'Untitled'));

  // ---- menus say canvas
  const menu = await app.evaluate(() => {
    const m = globalThis.__shell.menu();
    const sub = (l) => m.items.find((i) => i.label === l).submenu.items.map((i) => i.label);
    return { file: sub('File'), window: sub('Window') };
  });
  check('File menu has New Canvas, Open Canvas, Quick Switcher, Open in Own Window, Open Recent', ['New Canvas', 'Open Canvas…', 'Quick Switcher…', 'Open in Own Window', 'Open Recent'].every((n) => menu.file.includes(n)), menu.file.join());
  const all = await app.evaluate(() => { const walk = (items) => items.flatMap((i) => [i.label, ...(i.submenu ? walk(i.submenu.items) : [])]); return walk(globalThis.__shell.menu().items); });
  check('no menu item says board', !all.some((l) => /board/i.test(l)), all.filter((l) => /board/i.test(l)).join());

  // ---- quick switcher: Enter opens here
  await app.evaluate(() => globalThis.__shell.openSwitcher());
  const sw = await winByUrl(app, /ui\.html\?mode=switcher/);
  await until(async () => (await sw.locator('#list li').count()) > 2);
  await sw.fill('#q', 'road');
  await shot(sw, '3-switcher');
  check('switcher filters the serve canvases', (await sw.locator('#list li').allInnerTexts()).join('|') === 'Roadmap|Create "road"', (await sw.locator('#list li').allInnerTexts()).join('|'));
  check('switcher placeholder and hint say canvas', (await sw.getAttribute('#q', 'placeholder')).includes('canvas') && (await sw.locator('#keys').innerText()).includes('own window'));
  await sw.keyboard.press('Enter').catch(() => {}); // the switcher closes itself
  await until(() => !app.windows().includes(sw));
  await until(() => /\/b\/Roadmap$/.test(mainPage(app)?.url() ?? ''));
  check('Enter in the switcher opens the canvas in the main window', (await mainWindows(app)).join() === 'Roadmap' && !(await titles(app)).includes('Open canvas'), (await titles(app)).join());

  // ---- Alt+Enter in the switcher: a pop-out
  await app.evaluate(() => globalThis.__shell.openSwitcher());
  const sw1 = await winByUrl(app, /ui\.html\?mode=switcher/);
  await until(async () => (await sw1.locator('#list li').count()) > 2);
  await sw1.fill('#q', 'retro');
  await sw1.keyboard.press('Alt+Enter').catch(() => {});
  await until(() => !app.windows().includes(sw1));
  const retro = await popout(user, 'Retro');
  check('Alt+Enter spawns a pop-out instance for the canvas', !!retro);
  check('it is a second process of the app, started with --canvas', !!retro && retro.pid !== app.process().pid && psArgs(retro.pid).includes('--canvas=Retro'), `${retro?.pid} ${psArgs(retro?.pid)}`);
  check('its window is titled with the canvas and shows only that canvas', retro?.title === 'Retro' && /\/b\/Retro$/.test(retro?.url ?? ''), JSON.stringify(retro));
  check('it has its own Dock icon (letter and color from the name)', retro?.icon?.letter === 'R' && Number.isInteger(retro?.icon?.hue), JSON.stringify(retro?.icon));
  check('the main window stayed on its canvas', (await mainWindows(app)).join() === 'Roadmap' && /\/b\/Roadmap$/.test(mainPage(app).url()));

  // ---- opening a popped-out canvas focuses it: no duplicate, the main window does not navigate
  const f0 = (instances(user).find((i) => i.canvas === 'Retro')?.focused ?? 0);
  await app.evaluate(() => globalThis.__shell.openCanvas('Retro'));
  await until(() => (instances(user).find((i) => i.canvas === 'Retro')?.focused ?? 0) > f0);
  check('opening a popped-out canvas focuses its instance', (instances(user).find((i) => i.canvas === 'Retro')?.focused ?? 0) === f0 + 1);
  check('no duplicate: still one Retro instance, same process, main window not navigated', (await running(user)).filter((i) => i.canvas === 'Retro').length === 1 && instances(user).find((i) => i.canvas === 'Retro').pid === retro.pid && /\/b\/Roadmap$/.test(mainPage(app).url()));
  await app.evaluate(() => globalThis.__shell.popOut('Retro'));
  check('popping out an already popped-out canvas focuses it too', (await until(() => (instances(user).find((i) => i.canvas === 'Retro')?.focused ?? 0) === f0 + 2)) !== false && (await running(user)).length === 1);
  const mp = mainPage(app);
  await mp.evaluate(() => (location.href = '/b/Retro'));
  await until(() => (instances(user).find((i) => i.canvas === 'Retro')?.focused ?? 0) >= f0 + 3);
  check('a link to a popped-out canvas focuses it and the main window stays', (instances(user).find((i) => i.canvas === 'Retro')?.focused ?? 0) === f0 + 3 && /\/b\/Roadmap$/.test(mainPage(app).url()) && (await mainWindows(app)).join() === 'Roadmap', `${mainPage(app).url()}`);

  // ---- Open in Own Window (the main window's canvas): the main window goes to the list
  await app.evaluate(() => globalThis.__shell.popOut('Roadmap'));
  const road = await popout(user, 'Roadmap');
  check('Open in Own Window pops out the canvas shown in the main window', !!road && road.title === 'Roadmap' && road.icon?.letter === 'R');
  await until(() => new URL(mainPage(app).url()).pathname === '/');
  check('the main window leaves it (goes to the list)', (await mainWindows(app)).join() === 'Canvases');
  check('the two pop-outs are separate processes with different colors', !!road && road.pid !== retro.pid && road.icon.hue !== retro.icon.hue, `${road?.icon?.hue} ${retro?.icon?.hue}`);
  const g0 = instances(user).find((i) => i.canvas === 'Roadmap').focused ?? 0;
  await app.evaluate(() => globalThis.__shell.goBack()); // history: back onto the popped-out canvas
  await until(() => (instances(user).find((i) => i.canvas === 'Roadmap')?.focused ?? 0) > g0);
  await until(() => new URL(mainPage(app).url()).pathname === '/');
  check('back onto a popped-out canvas focuses it instead and the main window returns to the list', (instances(user).find((i) => i.canvas === 'Roadmap').focused ?? 0) > g0 && new URL(mainPage(app).url()).pathname === '/');
  const mnames = await app.evaluate(() => globalThis.__shell.menu().items.find((i) => i.label === 'Window').submenu.items.map((i) => i.label));
  check('Window menu lists the pop-outs', (await until(async () => (await app.evaluate(() => globalThis.__shell.menu().items.find((i) => i.label === 'Window').submenu.items.map((i) => i.label))).some((l) => l.startsWith('Retro')), 6000)) !== false, mnames.join());

  // ---- a pop-out hands another canvas to the main app (over the main socket)
  const mainSock = join(retro.sock, '..', 'main.sock');
  check('the main app answers on its socket', !!(await sockSend(mainSock, { cmd: 'ping' })));
  await sockSend(mainSock, { cmd: 'open', canvas: 'Plans' });
  await until(() => /\/b\/Plans$/.test(mainPage(app).url()));
  check('a pop-out asking for another canvas opens it in the main window', (await mainWindows(app)).join() === 'Plans', (await mainWindows(app)).join());

  // ---- the app's Cmd+O / Cmd+K win over the canvas page's own
  for (const key of ['o', 'k']) {
    await app.evaluate(({ BrowserWindow }, k) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Plans');
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['meta'] });
    }, key);
    const s = await winByUrl(app, /ui\.html\?mode=switcher/);
    check(`Cmd+${key.toUpperCase()} in the canvas window opens the switcher`, !!s);
    if (s) {
      await s.keyboard.press('Escape').catch(() => {});
      await until(() => !app.windows().includes(s));
    }
  }
  // Cmd+[ / Cmd+] go back and forward
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Plans').webContents.sendInputEvent({ type: 'keyDown', keyCode: '[', modifiers: ['meta'] }));
  await until(() => new URL(mainPage(app).url()).pathname === '/');
  check('Cmd+[ goes back in the main window', new URL(mainPage(app).url()).pathname === '/');

  // ---- create from the switcher
  await app.evaluate(() => globalThis.__shell.openSwitcher());
  const sw2 = await winByUrl(app, /ui\.html\?mode=switcher/);
  await sw2.fill('#q', 'Brand new');
  await until(async () => (await sw2.locator('#list li.new').count()) === 1);
  await sw2.keyboard.press('Enter').catch(() => {}); // the switcher closes itself
  await until(() => /\/b\/Brand%20new$/.test(mainPage(app).url()));
  check('switcher creates a canvas from the typed name and opens it', (await mainWindows(app)).join() === 'Brand new' && (await api('/api/boards')).some((b) => b.name === 'Brand new'));

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
  check('the dialog text says canvas', !/board/i.test(await bd.locator('body').innerText()));
  await bd.click('#cancel');

  // ---- relaunch: the main app restores its canvas; the pop-outs keep running on their own
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Brand new').setBounds({ x: 40, y: 50, width: 900, height: 600 }));
  await new Promise((r) => setTimeout(r, 900));
  const proc = app.process();
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await until(() => proc.exitCode !== null, 8000);
  const saved = JSON.parse(readFileSync(join(user, 'state.json'), 'utf8'));
  check('state.json has the main window (canvas, bounds) and the backend', saved.main?.canvas === 'Brand new' && saved.main.bounds?.width === 900 && saved.backend === BACKEND, JSON.stringify(saved));
  check('quitting the main app leaves the pop-outs running', (await running(user)).length === 2, String((await running(user)).length));
  const pids = (await running(user)).map((i) => i.pid).sort();
  app = await launch(user, BACKEND);
  await until(async () => (await mainWindows(app)).length === 1);
  await until(() => /\/b\/Brand%20new$/.test(mainPage(app)?.url() ?? ''));
  check('relaunch restores the main window on its canvas', (await mainWindows(app)).join() === 'Brand new');
  const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
  check('and its bounds', b.x === 40 && b.y === 50 && b.width === 900 && b.height === 600, JSON.stringify(b));
  await new Promise((r) => setTimeout(r, 1500));
  check('pop-outs that are still running are not started twice', JSON.stringify((await running(user)).map((i) => i.pid).sort()) === JSON.stringify(pids));
  check('Open Recent keeps the canvases', JSON.parse(readFileSync(join(user, 'state.json'), 'utf8')).recent.includes('Roadmap'));

  // ---- pop-outs are restored: quit (kept) comes back, closed by the user (forgotten) does not
  await sockSend(instances(user).find((i) => i.canvas === 'Retro').sock, { cmd: 'quit', forget: true }); // as if its window was closed
  await sockSend(instances(user).find((i) => i.canvas === 'Roadmap').sock, { cmd: 'quit' }); // as if the app was quit
  await until(async () => !(await running(user)).length, 8000);
  check('both pop-outs ended', !(await running(user)).length);
  check('instance.json remembers which to bring back', instances(user).find((i) => i.canvas === 'Roadmap').keep === true && instances(user).find((i) => i.canvas === 'Retro').keep === false);
  const mproc = app.process();
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await until(() => mproc.exitCode !== null, 8000);
  app = await launch(user, BACKEND);
  const back2 = await popout(user, 'Roadmap');
  check('relaunch brings back the pop-out that was kept', !!back2 && back2.pid !== road.pid, JSON.stringify([back2?.pid, road.pid, instances(user)]));
  await new Promise((r) => setTimeout(r, 1200));
  check('and not the one the user closed', (await running(user)).map((i) => i.canvas).join() === 'Roadmap', (await running(user)).map((i) => i.canvas).join());
  await quitPopouts(user);
  await app.close();

  // ---- a 0.2 state file (list of windows) still opens: its first window becomes the main window
  const old = newUser();
  writeFileSync(join(old, 'state.json'), JSON.stringify({ backend: BACKEND, windows: [{ board: 'Roadmap', bounds: { x: 10, y: 10, width: 800, height: 600 } }, { board: 'Retro' }], recent: ['Roadmap'] }));
  app = await launch(old, BACKEND);
  await until(() => /\/b\/Roadmap$/.test(mainPage(app)?.url() ?? ''));
  check('a 0.2 state file opens its first window as the main window', (await mainWindows(app)).join() === 'Roadmap');
  await app.close();

  // ---- changing the backend closes the pop-outs (they showed the old one's canvases) and forgets them
  const user3 = newUser();
  app = await launch(user3, BACKEND);
  await app.evaluate(() => globalThis.__shell.popOut('Plans'));
  await popout(user3, 'Plans');
  await app.evaluate(() => globalThis.__shell.openBackendDialog());
  const bd2 = await winByUrl(app, /ui\.html\?mode=backend/);
  await until(async () => (await bd2.inputValue('#url')) === BACKEND);
  await bd2.fill('#url', BACKEND.replace('127.0.0.1', 'localhost'));
  await bd2.click('#save');
  await until(async () => !(await running(user3)).length, 8000);
  check('changing the backend closes the pop-outs and does not bring them back', !(await running(user3)).length && instances(user3)[0]?.keep === false);
  await app.close();

  // ---- backend unreachable, then back
  const user2 = newUser();
  const DEADURL = DEADURL0;
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
  await app.evaluate(() => globalThis.__shell.openCanvas('Roadmap'));
  await new Promise((r) => setTimeout(r, 900));
  await app.close();
  check('a session-only backend writes no state.json', !existsSync(join(fakeHome, 'Library', 'Application Support', 'Collie Canvas', 'state.json')));

  // ---- a prototype page renders in the window (srcdoc frame; the load watch must not remove it)
  const pageBoard = {
    nodes: [{ id: 'p1', type: 'text', text: '### Page', x: 0, y: 0, width: 640, height: 426, 'x-page': { title: 'Page', html: '<h1 id="hi">Hello page</h1>', vw: 1280 } }],
    edges: [],
  };
  await api('/api/boards', { name: 'Pages', text: JSON.stringify(pageBoard) });
  app = await launch(newUser(), BACKEND);
  await app.evaluate(() => globalThis.__shell.openCanvas('Pages'));
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
  for (const u of users) await quitPopouts(u).catch(() => {});
  for (const c of children) c.kill();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
