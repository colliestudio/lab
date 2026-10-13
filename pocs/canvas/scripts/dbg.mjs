import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage();
p.on('console', m => console.log('console', m.text()));
p.on('websocket', ws => { console.log('ws', ws.url()); ws.on('close', () => console.log('ws closed')); ws.on('socketerror', e => console.log('ws err', e)); });
await p.goto(process.argv[2]);
await p.waitForTimeout(3000);
console.log(await p.evaluate(() => document.querySelector('.room-state')?.textContent));
await b.close();
