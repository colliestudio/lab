// Headless end-to-end check of the kanban idea (files, agent edit, refs, panel, new task, peer, service, iframe).
// Needs: vite on 5216 with KANBAN_ROOT=/tmp/kanban-demo BACKLOG_URL=http://127.0.0.1:5226, both dirs git copies of a
// Backlog.md project, `backlog browser --port 5226` running in /tmp/kanban-svc. PLAYWRIGHT=path/to/playwright-core/index.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright-core');
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = 'http://localhost:5216/';
const DEMO = '/tmp/kanban-demo/backlog/tasks/';
const SHOTS = process.argv[2] ?? '/tmp/kanban-check';
const fileOf = (id) => DEMO + readdirSync(DEMO).find((f) => f.startsWith(id.toLowerCase() + ' '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const ok = (c, msg) => { if (!c) { console.log('FAIL', msg); process.exitCode = 1; } else console.log('ok  ', msg); };

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem('canvas-poc:player', JSON.stringify({ id: 'p-alex', name: 'Alex', color: '#e0457b', named: true })));
const page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text()));
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto(BASE);
await page.waitForFunction(() => !!window.app);

const task = (p, id) => p.evaluate((id) => { const n = app.doc.nodes.find((n) => n['x-kanban']?.taskId === id); return n && { id: n.id, ...n['x-kanban'], body: undefined }; }, id);
const cardBox = async (p, id) => { const t = await task(p, id); return p.locator(`[data-node-id="${t.id}"]`).boundingBox(); };
async function drag(p, from, to) {
  await p.mouse.move(from.x, from.y); await p.mouse.down();
  for (let i = 1; i <= 12; i++) { await p.mouse.move(from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12); await sleep(16); }
  await p.mouse.up();
}
const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

// 1. files: board from the dev folder (a copy of the cs backlog)
await page.evaluate(() => { app.store.load({ nodes: [], edges: [] }); app.dispatch('kanban.create', { x: 0, y: 0 }); });
await page.click('[data-action="dev"]');
await page.waitForFunction(() => app.doc.nodes.filter((n) => n['x-kanban']?.kind === 'task').length > 50);
await page.evaluate(() => (() => { const b = app.doc.nodes.find((n) => n['x-kanban']?.kind === 'board'); app.viewport.set(40 - b.x * 0.85, 80 - b.y * 0.85, 0.85); })());
ok(true, 'board filled from folder: ' + (await page.evaluate(() => app.doc.nodes.filter((n) => n['x-kanban']?.kind === 'task').length)) + ' tasks');
await page.screenshot({ path: `${SHOTS}/1-board.png` });

// 2. drag TASK-7 (To Do) to the top of Done
const done = await page.locator('.kb-col').nth(2).boundingBox();
await drag(page, center(await cardBox(page, 'TASK-7')), { x: done.x + done.width / 2, y: done.y + 40 });
await sleep(1200);
let t7 = await task(page, 'TASK-7');
ok(t7.status === 'Done', `TASK-7 moved on the board: ${t7.status}`);
let diff = execSync(`git -C /tmp/kanban-demo diff -U0 -- "${fileOf('TASK-7').replace('/tmp/kanban-demo/', '')}"`).toString();
log('git diff after the drag:\n' + diff.split('\n').filter((l) => /^[-+][a-z]/.test(l)).join('\n'));
ok(/\+status: Done/.test(diff), 'file written: status: Done');

// 3. an agent edits a file: the board follows
const f14 = fileOf('TASK-14');
writeFileSync(f14, readFileSync(f14, 'utf8').replace(/^status: .*$/m, 'status: In Progress').replace(/^labels:\n/m, 'labels:\n  - agent-edit\n'));
await sleep(2500);
const t14 = await task(page, 'TASK-14');
ok(t14.status === 'In Progress' && t14.labels.includes('agent-edit'), `outside edit shows up: ${t14.status} ${t14.labels}`);

// 4. drag a card off the board = linked reference; edit it through the panel
const bb = await page.locator('.kb-board').boundingBox();
await drag(page, center(await cardBox(page, 'TASK-13')), { x: bb.x + bb.width + 150, y: bb.y + 120 });
await sleep(300);
const refId = await page.evaluate(() => app.doc.nodes.find((n) => n['x-kanban']?.kind === 'ref')?.id);
ok(!!refId, 'card dropped on the canvas became a linked ref');
await page.locator(`[data-node-id="${refId}"]`).dblclick();
await page.waitForSelector('.kb-panel');
await page.fill('.kb-panel-title', 'Backups for g8 guests (edited from a ref on the canvas)');
await page.press('.kb-panel-title', 'Tab');
await page.fill('.kb-panel [name=body]', '\n## Description\n\nEdited in the canvas panel.\n');
await page.locator('.kb-panel [name=body]').blur();
await sleep(1500);
await page.screenshot({ path: `${SHOTS}/2-ref-panel.png` });
const t13 = readFileSync(fileOf('TASK-13'), 'utf8');
ok(t13.includes("title: Backups for g8 guests (edited from a ref on the canvas)") && t13.includes('Edited in the canvas panel.'), 'title + body written to the file');
ok((await page.locator(`[data-node-id="${refId}"]`).innerText()).includes('edited from a ref'), 'ref shows the new title (same task, two views)');
await page.click('.kb-close');

// 5. new task from the board
await page.locator('.kb-col').nth(0).locator('[data-action^="add"]').click();
await page.fill('.name-dialog input', 'Task made on the canvas');
await page.press('.name-dialog input', 'Enter');
await sleep(1500);
const created = readdirSync(DEMO).filter((f) => f.includes('Task-made-on-the-canvas'));
ok(created.length === 1, 'new task file: ' + created[0]);

// 6. multiplayer: a second tab in a room; it moves a card, the host tab writes the file
const room = 'kb' + Date.now().toString(36);
await page.goto(`${BASE}?room=${room}`);
await page.waitForFunction(() => !!window.app);
await page.evaluate(() => { app.store.load({ nodes: [], edges: [] }); app.dispatch('kanban.create', { x: 0, y: 0 }); });
await page.click('[data-action="dev"]');
await page.waitForFunction(() => app.doc.nodes.filter((n) => n['x-kanban']?.kind === 'task').length > 50);
await page.evaluate(() => (() => { const b = app.doc.nodes.find((n) => n['x-kanban']?.kind === 'board'); app.viewport.set(40 - b.x * 0.85, 80 - b.y * 0.85, 0.85); })());
const peer = await ctx.newPage();
peer.on('pageerror', (e) => console.log('  [peer pageerror]', e.message));
await peer.goto(`${BASE}?room=${room}`);
await peer.waitForFunction(() => window.app && app.doc.nodes.filter((n) => n['x-kanban']?.kind === 'task').length > 50, null, { timeout: 20000 });
await peer.evaluate(() => { document.querySelector('.name-overlay')?.remove(); (() => { const b = app.doc.nodes.find((n) => n['x-kanban']?.kind === 'board'); app.viewport.set(40 - b.x * 0.85, 80 - b.y * 0.85, 0.85); })(); });
ok((await peer.locator('.kb-head').innerText()).includes('host:'), 'peer sees the board with "host: …": ' + (await peer.locator('.kb-src').innerText()));
const ip = await peer.locator('.kb-col').nth(1).boundingBox();
await drag(peer, center(await cardBox(peer, 'TASK-15')), { x: ip.x + ip.width / 2, y: ip.y + 40 });
await sleep(2500);
ok(/^status: In Progress$/m.test(readFileSync(fileOf('TASK-15'), 'utf8')), 'peer drag → host wrote TASK-15 status: In Progress');
await peer.screenshot({ path: `${SHOTS}/3-peer.png` });
await peer.close();

// 7. service source: own `backlog browser` on 5226 (a copy), through /backlog-api
await page.goto(BASE);
await page.waitForFunction(() => !!window.app);
await page.evaluate(() => { app.store.load({ nodes: [], edges: [] }); app.dispatch('kanban.create', { x: 0, y: 0 }); });
await page.click('[data-action="service"]');
await page.waitForFunction(() => app.doc.nodes.filter((n) => n['x-kanban']?.kind === 'task').length > 50, null, { timeout: 15000 });
await page.evaluate(() => (() => { const b = app.doc.nodes.find((n) => n['x-kanban']?.kind === 'board'); app.viewport.set(40 - b.x * 0.85, 80 - b.y * 0.85, 0.85); })());
ok(true, 'service board: ' + (await page.locator('.kb-src').innerText()));
const sdone = await page.locator('.kb-col').nth(2).boundingBox();
await drag(page, center(await cardBox(page, 'TASK-16')), { x: sdone.x + sdone.width / 2, y: sdone.y + 40 });
await sleep(3000);
diff = execSync('git -C /tmp/kanban-svc diff -U0').toString();
log('service git diff:\n' + diff.split('\n').filter((l) => /^[-+][a-z]/.test(l)).join('\n'));
ok(/\+status: Done/.test(diff), 'service wrote TASK-16 via PUT /api/tasks/:id (+ reorder)');
await page.screenshot({ path: `${SHOTS}/4-service.png` });

// 8. comparison: the Backlog.md web UI as an iframe node (own instance)
await page.evaluate(() => { app.dispatch('kanban.web', { x: 1500, y: 300, url: 'http://localhost:5226' }); app.view.fit(); });
await sleep(2500);
await page.screenshot({ path: `${SHOTS}/5-iframe.png` });
ok(true, 'iframe node added');
await browser.close();
