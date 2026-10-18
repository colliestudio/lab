// Headless check of the bridge experience against a local app + signaling Worker (wrangler dev).
//
//   node scripts/bridge-e2e.mjs [--app http://127.0.0.1:5241] [--signal ws://127.0.0.1:5243] [--bridge-port 5242] [--dir /tmp/canvas-demos/t315]
//
// 1. two browsers start a room;  2. a bridge joins it (`pnpm bridge join`);  3. an agent (CLI --as Claude)
// adds a note and chats: both browsers see them, the bridge saves the file;  4. a browser edits: the
// file follows;  5. the bridge leaves: the room carries on;  6. the Bridge… dialog connects to a bridge
// (second bridge, with a pairing token), remembers it, shows its health, disconnects.
// Needs the app (vite) and the signaling Worker running; starts and stops its own bridges.

import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const APP = opt('--app', 'http://127.0.0.1:5241');
const SIGNAL = opt('--signal', 'ws://127.0.0.1:5243');
const BPORT = Number(opt('--bridge-port', 5242));
const DIR = opt('--dir', '/tmp/canvas-demos/t315');
mkdirSync(DIR, { recursive: true });
const room = 'e2e' + Math.random().toString(36).slice(2, 7);
const FILE = `${DIR}/${room}.canvas`;
const link = `${APP}/?room=${room}&signal=${encodeURIComponent(SIGNAL)}`;

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const until = async (cond, what, ms = 15000) => {
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
    await new Promise((r) => setTimeout(r, 100));
  }
};
const children = [];
const start = (cmd, a, env = {}) => {
  const c = spawn(cmd, a, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  c.out = '';
  c.stdout.on('data', (d) => (c.out += d));
  c.stderr.on('data', (d) => (c.out += d));
  children.push(c);
  return c;
};
const stopAll = () => children.forEach((c) => c.kill('SIGINT'));
const cli = (...a) => execFileSync('node_modules/.bin/tsx', ['bridge/cli.ts', ...a, '--as', 'Claude'], { env: { ...process.env, CANVAS_BRIDGE: `http://127.0.0.1:${BPORT}` }, encoding: 'utf8' });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const player = (name, color) => `localStorage.setItem('canvas-poc:player', JSON.stringify({id:'${name.toLowerCase()}-id',name:'${name}',color:'${color}',named:true}))`;
  const open = async (name, color, url) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(player(name, color));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, `${name} page error: ${e.message}`));
    await page.goto(url);
    return page;
  };
  const texts = (p) => p.evaluate(() => window.app.store.doc.nodes.map((n) => n.text).filter(Boolean));
  const chat = (p) => p.evaluate(() => window.app.store.ydoc.getArray('chat').toArray().map((m) => `${m.from?.name ?? m.actor?.name ?? '?'}: ${m.text}`));
  // Bridge… lives in the main menu (top-left)
  const openBridgeDialog = async (p) => {
    await p.getByRole('button', { name: 'Main menu' }).click();
    await p.getByRole('menuitem', { name: /Bridge…/ }).click();
  };
  const roomText = (p) => p.evaluate(() => document.querySelector('.room-state')?.textContent ?? '');

  // 1. a room of two
  const a = await open('Alex', '#4363d8', link);
  const b = await open('Sam', '#3cb44b', link);
  await a.evaluate(() => window.app.dispatch('board.add', { type: 'text', text: 'made in the room', x: 0, y: 0 }));
  await until(async () => (await texts(b)).includes('made in the room'), 'Sam sees the note');
  check((await roomText(a)).includes('online') && !(await roomText(a)).includes('bridge'), 'room status: online, no bridge yet');

  // 2. the bridge joins
  const bridge = start('node_modules/.bin/tsx', ['bridge/server.ts', 'join', link, FILE, '--port', String(BPORT)]);
  await until(() => /Joined room/.test(bridge.out), 'bridge says it joined');
  await until(async () => (await roomText(a)).includes('· bridge'), 'status shows a bridge in the room');
  await until(() => existsSync(FILE) && readFileSync(FILE, 'utf8').includes('made in the room'), 'bridge saved the room to the file');

  // 3. the agent acts
  cli('add-node', 'agent note');
  cli('chat', 'say', 'hello from Claude');
  for (const [n, p] of [['Alex', a], ['Sam', b]]) {
    await until(async () => (await texts(p)).includes('agent note'), `${n} sees the agent's note`);
    await until(async () => (await chat(p)).some((m) => /Claude.*hello from Claude/.test(m)), `${n} sees the agent's chat message`);
    await until(() => p.evaluate(() => document.querySelector('.players')?.textContent.includes('Claude')), `${n} sees Claude among the players`);
  }
  await until(() => readFileSync(FILE, 'utf8').includes('agent note'), 'file has the agent note');
  const log = JSON.parse(execFileSync('curl', ['-s', `http://127.0.0.1:${BPORT}/log`], { encoding: 'utf8' }));
  check(log.some((e) => e.actor === 'Claude'), 'log attributes the edit to Claude');
  cli('undo');
  await until(async () => !(await texts(a)).includes('agent note'), 'agent undo reaches the browsers');

  // 4. a browser edits: the file follows
  await b.evaluate(() => window.app.dispatch('board.add', { type: 'text', text: 'from Sam', x: 200, y: 0 }));
  await until(() => readFileSync(FILE, 'utf8').includes('from Sam'), 'file has Sam’s note');
  await until(async () => (cli('list')).includes('from Sam'), 'the agent sees Sam’s note');

  // the Bridge… dialog in a room: the command to give an agent
  await openBridgeDialog(a);
  await until(() => a.locator('.bridge-cmd').textContent().then((t) => t.includes(`pnpm bridge join '${link}'`)), 'dialog shows the join command');
  check((await a.locator('.bridge-dialog .bridge-state').first().textContent()).startsWith('Bridge connected'), 'dialog says the bridge is connected');
  await a.keyboard.press('Escape');

  // 5. the bridge leaves; the room carries on
  bridge.kill('SIGINT');
  await until(async () => !(await roomText(a)).includes('· bridge'), 'status drops the bridge');
  await until(() => a.evaluate(() => !document.querySelector('.players')?.textContent.includes('Claude')), 'Claude leaves the player list');
  await a.evaluate(() => window.app.dispatch('board.add', { type: 'text', text: 'after the bridge', x: 0, y: 200 }));
  await until(async () => (await texts(b)).includes('after the bridge'), 'room still syncs without the bridge');

  // 5b. it comes back with the same file: nothing is lost, the missed edit arrives
  const again = start('node_modules/.bin/tsx', ['bridge/server.ts', 'join', link, FILE, '--port', String(BPORT)]);
  await until(() => /Joined room/.test(again.out), 'bridge rejoins');
  await until(() => readFileSync(FILE, 'utf8').includes('after the bridge'), 'rejoined bridge caught up on what it missed');
  again.kill('SIGINT');

  // 6. Bridge… dialog: connect to a shared bridge (token) through a proxy that behaves like a tunnel
  const fileB = `${DIR}/${room}-shared.canvas`;
  const SPORT = BPORT + 10;
  const PPORT = BPORT + 20;
  const shared = start('node_modules/.bin/tsx', ['bridge/server.ts', 'share', fileB, '--no-tunnel', '--port', String(SPORT), '--app', APP, '--token', 'pair-me']);
  await until(() => /Local link/.test(shared.out), 'shared bridge prints its link');
  // cloudflared and Caddy both add X-Forwarded-For; so does this stand-in
  const proxy = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: SPORT, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-for': '203.0.113.7' } }, (r) => (res.writeHead(r.statusCode, r.headers), r.pipe(res)));
    req.pipe(up);
  });
  proxy.on('upgrade', (req, sock, head) => {
    const up = net.connect(SPORT, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`), 'x-forwarded-for: 203.0.113.7', '', ''];
      up.write(lines.join('\r\n'));
      up.write(head);
      sock.pipe(up);
      up.pipe(sock);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  await new Promise((r) => proxy.listen(PPORT, '127.0.0.1', r));
  const get = (path, port = PPORT) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path }, (r) => (r.resume(), resolve(r.statusCode))));
  check((await get('/status')) === 403, 'through the proxy: no token, refused');
  check((await get('/status?token=pair-me')) === 200, 'through the proxy: with the token, served');
  check((await get('/status', SPORT)) === 200, 'directly on the machine: no token needed');

  const proxied = `ws://127.0.0.1:${PPORT}`;
  const c = await open('Alex', '#4363d8', APP + '/');
  await openBridgeDialog(c);
  await c.locator('.bridge-form input').fill(proxied);
  await c.locator('.bridge-form button[type=submit]').click();
  await until(async () => (await c.evaluate(() => location.search)).includes('bridge='), 'tab navigates to ?bridge=');
  await until(async () => /can’t reach the bridge/.test(await roomText(c)), 'without the token the status says it can’t reach the bridge', 20000);
  check(/refused WebSocket/.test(shared.out), 'the bridge logged the refusal');
  // the link the bridge prints carries the token (here: pointed at the proxy)
  const printed = /(http\S+\?bridge=\S+#token=\S+)/.exec(shared.out)?.[1];
  check(!!printed, 'printed link carries the token in the fragment');
  await c.goto(printed.replace(encodeURIComponent(`ws://localhost:${SPORT}`), encodeURIComponent(proxied)));
  if (!(await until(async () => /bridge .*online/.test(await roomText(c)), 'with the token: connected, status online'))) console.log(await c.url(), '|', await roomText(c), '\n', shared.out.split('\n').slice(-6).join('\n'));
  check(!(await c.evaluate(() => location.hash)), 'token is taken out of the address bar');
  await openBridgeDialog(c);
  check((await c.locator('.bridge-dialog .bridge-state').first().textContent()).startsWith('online'), 'dialog shows the active bridge online');
  await c.keyboard.press('Escape');
  // remembered: next time the list entry alone works (token saved)
  await c.goto(`${APP}/`);
  await openBridgeDialog(c);
  check((await c.locator('.bridge-list li').count()) === 1, 'bridge is in the remembered list (once)');
  await c.locator('.bridge-list li button', { hasText: /^Connect$/ }).click();
  await until(async () => /bridge .*online/.test(await roomText(c)), 'reconnect from the list (token remembered)');
  // disconnect
  await openBridgeDialog(c);
  await c.getByRole('button', { name: 'Disconnect' }).click();
  await until(async () => !(await c.evaluate(() => location.search)).includes('bridge='), 'disconnect leaves the bridge');
  proxy.close();
  shared.kill('SIGINT');
} catch (e) {
  check(false, `exception: ${e.stack}`);
} finally {
  stopAll();
  await browser.close();
  for (const f of [FILE, `${DIR}/${room}-shared.canvas`]) rmSync(f, { force: true });
  rmSync(`${DIR}/.canvas-bridge`, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
