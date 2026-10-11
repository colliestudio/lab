// Headless attack run: starts the sandbox server (with sink) and Vite on free ports, opens
// sandbox.html?auto=1 in Chrome, prints the before/now table and checks the expectations below.
//   pnpm test:attacks           (CHROME=/path/to/chrome to override)
// Exit code 1 if a "now" result differs from what ideas/sandbox-origin.md documents.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sbxPort = await freePort();
const srv = spawn(process.execPath, ['sandbox/server.mjs', '--port', String(sbxPort), '--sink'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
process.env.VITE_SANDBOX_URL = `http://{label}.localhost:${sbxPort}`;
const vite = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await vite.listen();
const appUrl = `http://localhost:${vite.httpServer.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
let code = 0;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${appUrl}/sandbox.html?auto=1`);
  await page.waitForFunction(() => window.__lab, null, { timeout: 180_000, polling: 500 });
  const results = await page.evaluate(() => window.__lab);
  const by = new Map(results.map((r) => [`${r.attack}/${r.where}/${r.mode}`, r]));
  const fmt = (r) => (r ? (r.leaked.length ? 'LEAK ' + r.leaked.join(' ') : 'blocked') + (r.notes.length ? ' | ' + r.notes.join(' | ') : '') : '-');
  const keys = [...new Set(results.map((r) => `${r.attack}/${r.where}`))];
  for (const k of keys) console.log(`${k.padEnd(22)} before: ${fmt(by.get(k + '/before')).slice(0, 90).padEnd(92)} now: ${fmt(by.get(k + '/now')).slice(0, 110)}`);
  // what we expect now: only the control leaks, plus the documented WebRTC-from-child-frame hole in pages
  const expectedLeaksNow = new Set(['control/plugin', 'webrtc-child/page']);
  for (const k of keys) {
    const now = by.get(k + '/now');
    const leaked = now.leaked.length > 0;
    if (leaked !== expectedLeaksNow.has(k)) {
      console.error(`UNEXPECTED: ${k} now ${leaked ? 'leaked' : 'blocked'}`);
      code = 1;
    }
  }
  if (errors.length) console.log('uncaught in frames (attacks being refused):', errors.map((e) => e.slice(0, 100)));
  // the plugin loader in the real app: install Dice, roll it, see it ran in a Worker on the sandbox origin
  await page.goto(appUrl);
  await page.waitForTimeout(1500); // first visit: Vite may optimize deps and reload
  await page.goto(appUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: /Plugins/ }).click();
  await page.getByRole('button', { name: 'Dice' }).click();
  await page.locator('dialog button', { hasText: /^(OK|Install|Allow)/ }).first().click().catch(() => {});
  await page.waitForSelector('iframe[data-plugin="dice"]', { state: 'attached', timeout: 5000 });
  const src = await page.getAttribute('iframe[data-plugin="dice"]', 'src');
  console.log('dice frame:', src);
  if (!src?.startsWith(`http://p-dice-`)) (console.error('dice frame not on the sandbox origin'), (code = 1));
  await page.locator('.pp-status.pp-running').first().waitFor({ timeout: 5000 });
  await page.locator('.pp-close').click();
  await page.getByRole('button', { name: 'Add…' }).click();
  await page.getByText('Die (d6)').click();
  await page.locator('[data-action="roll"]').first().click();
  await page.waitForFunction(() => /rolled \d/.test(document.body.innerText), null, { timeout: 5000 });
  console.log('dice: installed, rendered and rolled through the Worker');
} finally {
  await browser.close();
  await vite.close();
  srv.kill();
}
process.exit(code);
