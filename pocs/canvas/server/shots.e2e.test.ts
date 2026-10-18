import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, root, startBridge, until, type TestBridge } from '../bridge/process.test-util';

// Screenshots end to end in a real Chrome: a real serve (and a real bridge) with the built web app,
// real MCP and CLI, and a pixel probe of the PNG that came back. Skipped without Chrome.

const CHROME = [process.env.CANVAS_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
if (!CHROME) console.warn('shots.e2e: no Chrome found (set CANVAS_CHROME=<binary> or install google-chrome-stable): the screenshot e2e tests are SKIPPED');

function newest(dir: string): number {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) t = Math.max(t, e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs);
  return t;
}
/** dist/ when it is at least as new as src/, else a fresh build. */
function ensureBuild() {
  const index = join(root, 'dist', 'index.html');
  const built = existsSync(index) ? statSync(index).mtimeMs : 0;
  if (built >= newest(join(root, 'src')) && built >= statSync(join(root, 'index.html')).mtimeMs) return;
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, stdio: 'ignore' });
}

const pngSize = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

let probe: Browser;
/** RGBA at each point of the PNG, decoded by a browser. */
async function pixels(png: Buffer, pts: [number, number][]): Promise<number[][]> {
  const page = await probe.newPage();
  try {
    return (await page.evaluate(
      `(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${png.toString('base64')}';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return ${JSON.stringify(pts)}.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
      })()`,
    )) as number[][];
  } finally {
    await page.close();
  }
}
const near = (px: number[], hex: string, tol = 12) => [1, 3, 5].every((i, k) => Math.abs(px[k] - parseInt(hex.slice(i, i + 2), 16)) <= tol);

interface Shot {
  png: Buffer;
  text: string;
}
const parts = (r: Awaited<ReturnType<Client['callTool']>>) => {
  const c = r.content as { type: string; data?: string; text?: string }[];
  if (r.isError) throw new Error(c[0].text);
  const img = c.find((x) => x.type === 'image');
  return { png: Buffer.from(img!.data!, 'base64'), text: c.find((x) => x.type === 'text')!.text! } satisfies Shot;
};
const boxOf = (text: string, id: string) => {
  const m = new RegExp(`${id} \\S+ \\[(-?\\d+),(-?\\d+),(\\d+),(\\d+)\\]`).exec(text);
  if (!m) throw new Error(`${id} is not in view:\n${text}`);
  return m.slice(1).map(Number) as [number, number, number, number];
};

let serveProc: ChildProcess;
let boardsDir: string;
let base: string;
let mcp: Client;
let mcp2: Client;
const as = (name: string) => ({ board: 'main', name });

async function startServe() {
  boardsDir = mkdtempSync(join(tmpdir(), 'canvas-shots-e2e-'));
  const port = await freePort();
  serveProc = spawn(process.execPath, ['--import', 'tsx', 'server/serve.ts', boardsDir, '--port', String(port)], { cwd: root, stdio: 'ignore' });
  base = `http://127.0.0.1:${port}`;
  await until(async () => !!(await fetch(base + '/api/info').catch(() => null))?.ok);
}
const api = async (path: string, body?: Record<string, unknown>) => (await fetch(`${base}/api/boards${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
const run = (board: string, name: string, args: Record<string, unknown>, who = 'Setup') => api(`/${board}/agent/run`, { as: who, name, args });

describe.skipIf(!CHROME)('screenshots in a real browser', () => {
  beforeAll(async () => {
    ensureBuild();
    probe = await chromium.launch({ executablePath: CHROME, headless: true });
    await startServe();
    await api('', { name: 'main' });
    await api('', { name: 'hands' });
    mcp = new Client({ name: 'test', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
    mcp2 = new Client({ name: 'test2', version: '1' });
    await mcp2.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  }, 120_000);
  afterAll(async () => {
    await mcp?.close().catch(() => {});
    await mcp2?.close().catch(() => {});
    serveProc?.kill('SIGKILL');
    await probe?.close();
    rmSync(boardsDir, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => mcp.callTool({ name, arguments: args });

  it('A14: a serve answers canvas_screenshot with a 1000x750 PNG that shows node colors and the prototype page inside its iframe', async () => {
    const red = (await run('main', 'board.add', { text: 'red', x: 0, y: 0, color: '1' })).result.id;
    const cyan = (await run('main', 'board.add', { text: 'cyan', x: 400, y: 0, color: '5' })).result.id;
    const page = (await run('main', 'page.create', { title: 'Solid', html: '<html><body style="margin:0;background:#ff00ff"></body></html>', x: 0, y: 300 })).result.id;
    await call('canvas_join', as('Claude'));
    const s = parts(await call('canvas_screenshot'));
    expect(pngSize(s.png)).toEqual({ width: 1000, height: 750 });
    expect(s.text).toContain('agent:claude');
    const [rx, ry, , rh] = boxOf(s.text, red);
    const [cx, cy, , ch] = boxOf(s.text, cyan);
    const [px, py, pw, ph] = boxOf(s.text, page);
    const [a, b, c] = await pixels(s.png, [
      [rx + 2, ry + Math.round(rh / 2)], // the color stripe of the first note
      [cx + 2, cy + Math.round(ch / 2)],
      [px + Math.round(pw / 2), py + Math.round(ph / 2)], // inside the page's iframe
    ]);
    expect(near(a, '#fb464c')).toBe(true);
    expect(near(b, '#53dfdd')).toBe(true);
    expect(near(c, '#ff00ff')).toBe(true);
    // one node: it fills the picture
    const one = parts(await call('canvas_screenshot', { node: 'Solid', padding: 0 }));
    const [, , w, h] = boxOf(one.text, page);
    expect(Math.max(w / 1000, h / 750)).toBeGreaterThan(0.95);
    // a region
    const reg = parts(await call('canvas_screenshot', { region: { x: 380, y: -20, width: 300, height: 140 }, labels: true }));
    expect(reg.text).toContain(cyan);
    expect(reg.text).not.toContain(page);
  }, 60_000);

  it('A16: another player’s hand shows its card backs to the agent seat; the agent’s own hand shows faces', async () => {
    const post = (name: string, args: Record<string, unknown>) => api('/hands/cmd', { as: 'Setup', name, args });
    await post('cards.addPack', { x: 0, y: -900 });
    const other = (await post('cards.newHand', { owner: 'p1', label: 'P1', x: -400, y: 300 })).select[0];
    const mine = (await post('cards.newHand', { owner: 'agent:claude', label: 'Claude', x: 500, y: 300 })).select[0];
    const id = async (face: string) => ((await (await fetch(`${base}/api/boards/hands/query?text=${encodeURIComponent(face)}`)).json()) as { id: string; text: string }[]).find((n) => n.text === face)!.id;
    const [a, b, c, d] = [await id('A♠'), await id('2♠'), await id('3♠'), await id('4♠')];
    await post('cards.drop', { target: other, ids: [a, b], faceUp: true });
    await post('cards.drop', { target: mine, ids: [c, d] });
    await mcp2.callTool({ name: 'canvas_join', arguments: { board: 'hands', name: 'Claude' } });
    // just the two hands: the pack above them would fill the list of nodes in view
    const s = parts(await mcp2.callTool({ name: 'canvas_screenshot', arguments: { region: { x: -500, y: 250, width: 1400, height: 450 }, width: 1400, height: 450, padding: 0 } }));
    /** The share of a card's inner area that is reddish (a back) versus near white (a face). */
    const share = async (cardId: string) => {
      const [x, y, w, h] = boxOf(s.text, cardId);
      const pts: [number, number][] = [];
      for (let i = 1; i < 7; i++) for (let j = 1; j < 7; j++) pts.push([x + Math.round((w * i) / 7), y + Math.round((h * j) / 7)]);
      const px = await pixels(s.png, pts);
      return { red: px.filter(([r, g, bl]) => r > g + 40 && r > bl + 20).length / px.length, white: px.filter(([r, g, bl]) => r > 225 && g > 220 && bl > 200).length / px.length };
    };
    const theirs = await share(b); // the top card of p1's hand
    const own = await share(d);
    expect(theirs.red).toBeGreaterThan(0.8);
    expect(theirs.white).toBeLessThan(0.1);
    expect(own.white).toBeGreaterThan(0.5);
    expect(own.red).toBeLessThan(0.1);
  }, 60_000);

  it('A17: warm shots take under 1 s, show the board as it is now, and write nothing', async () => {
    const id = (await run('main', 'board.add', { text: 'mover', x: 800, y: 0 })).result.id;
    const file = join(boardsDir, 'main.canvas');
    const digest = () => createHash('sha1').update(readFileSync(file)).digest('hex');
    const logLen = async () => (await (await fetch(`${base}/api/boards/main/log?limit=500`)).json()).length;
    await call('canvas_screenshot', {}); // the first one pays for the browser and the page
    await until(() => readFileSync(file, 'utf8').includes('mover'));
    const before = { file: digest(), log: await logLen() };
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      const s = parts(await call('canvas_screenshot', i % 2 ? {} : { node: id }));
      ms.push(Number(/(\d+) ms/.exec(s.text)![1]));
      expect(Date.now() - t).toBeLessThan(1000);
    }
    expect(Math.max(...ms)).toBeLessThan(1000);
    // moved by someone else: the next picture has it at its new place
    const first = boxOf(parts(await call('canvas_screenshot', { region: { x: 700, y: -100, width: 600, height: 400 } })).text, id);
    expect((await run('main', 'board.update', { node: id, x: 1000, y: 150 })).ok).toBe(true);
    const after = boxOf(parts(await call('canvas_screenshot', { region: { x: 700, y: -100, width: 600, height: 400 } })).text, id);
    expect(after[0]).toBeGreaterThan(first[0] + 100);
    expect(after[1]).toBeGreaterThan(first[1] + 50);
    await new Promise((r) => setTimeout(r, 1200)); // a page that wrote on load would have reached the file by now
    const log = await logLen();
    expect(log - before.log).toBe(1); // only the board.update
    expect(readFileSync(file, 'utf8')).toContain('"x": 1000');
    const unchangedByShots = digest();
    await call('canvas_screenshot', {});
    await new Promise((r) => setTimeout(r, 500));
    expect(digest()).toBe(unchangedByShots);
    expect(before.file).not.toBe(digest());
  }, 60_000);

  it('a node the seat can not see, and a bad region, come back as clear errors', async () => {
    const r = await call('canvas_screenshot', { node: 'no such thing' });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toContain('no node');
    expect((await call('canvas_screenshot', { region: { x: 0, y: 0, width: -1, height: 5 } })).isError).toBe(true);
  }, 60_000);
});

describe.skipIf(!CHROME)('whole-board shot of a wide board, no app chrome', () => {
  beforeAll(async () => {
    ensureBuild();
    probe = await chromium.launch({ executablePath: CHROME, headless: true });
    await startServe();
    await api('', { name: 'wide' });
    for (let i = 0; i < 40; i++) await run('wide', 'board.add', { text: `n${i}`, x: i * 1500, y: (i % 5) * 900 });
    for (let i = 0; i < 3; i++) await run('wide', 'frames.create', { x: i * 20000, y: -900, width: 18000, height: 600, label: `F${i}` });
  }, 120_000);
  afterAll(async () => {
    serveProc?.kill('SIGKILL');
    await probe?.close();
    rmSync(boardsDir, { recursive: true, force: true });
  });

  it('every node is inside the picture (which takes the board’s shape), and the outline, dock and the viewing seat’s own cursor are not drawn', async () => {
    const s = (await api('/wide/shot?as=x')) as { png: string; width: number; height: number; nodes: { id: string; box: [number, number, number, number] }[] };
    expect(s.width).toBe(2000);
    expect(s.height).toBeLessThan(2000);
    expect(s.nodes).toHaveLength(43);
    for (const n of s.nodes) {
      const [x, y, w, h] = n.box;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(s.width);
      expect(y + h).toBeLessThanOrEqual(s.height);
    }
    // the same page a shot uses: nothing beside the table shows
    const page = await probe.newPage({ viewport: { width: 1000, height: 750 } });
    try {
      await page.goto(`${base}/b/wide?agentView=agent:x`);
      await page.waitForFunction('window.canvasSynced');
      await page.evaluate('window.canvasSynced');
      const shown = (await page.evaluate(
        `[...document.body.children].filter((e) => e.tagName !== 'SCRIPT' && e.id !== 'table' && getComputedStyle(e).display !== 'none').map((e) => e.className)`,
      )) as string[];
      expect(shown).toEqual([]);
      expect(await page.evaluate(`!!document.querySelector('.fr-outline')`)).toBe(true); // it exists, hidden
    } finally {
      await page.close();
    }
  }, 90_000);
});

describe.skipIf(!CHROME)('screenshots in a Chrome that is already running (CANVAS_CDP)', () => {
  let shared: ChildProcess;
  let sharedDir: string;
  let cdp: string;
  const alive = async () => !!(await fetch(`${cdp}/json/version`).catch(() => null))?.ok;
  beforeAll(async () => {
    ensureBuild();
    sharedDir = mkdtempSync(join(tmpdir(), 'canvas-shots-cdp-'));
    const port = await freePort();
    shared = spawn(CHROME!, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${sharedDir}`, '--no-first-run', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
    cdp = `http://127.0.0.1:${port}`;
    await until(alive);
    boardsDir = mkdtempSync(join(tmpdir(), 'canvas-shots-e2e-'));
    const sp = await freePort();
    serveProc = spawn(process.execPath, ['--import', 'tsx', 'server/serve.ts', boardsDir, '--port', String(sp)], { cwd: root, stdio: 'ignore', env: { ...process.env, CANVAS_CDP: cdp, CANVAS_CHROME: '/nonexistent' } });
    base = `http://127.0.0.1:${sp}`;
    await until(async () => !!(await fetch(base + '/api/info').catch(() => null))?.ok);
    await api('', { name: 'main' });
    await run('main', 'board.add', { text: 'hi', x: 0, y: 0 });
  }, 120_000);
  afterAll(() => {
    serveProc?.kill('SIGKILL');
    shared?.kill('SIGKILL');
    rmSync(boardsDir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // Chrome's children may still be writing
  });

  it('takes the shot in the running Chrome (CANVAS_CHROME is a dead path, so it did not launch), and that Chrome is still up after', async () => {
    const s = (await api('/main/shot?as=x')) as { png: string; nodes: unknown[] };
    expect(Buffer.from(s.png, 'base64').subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(s.nodes).toHaveLength(1);
    const targets = (await (await fetch(`${cdp}/json/list`)).json()) as { url: string }[];
    expect(targets.some((t) => t.url.includes('agentView=agent'))).toBe(true); // our page lives in the shared browser
    serveProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await alive()).toBe(true);
  }, 90_000);
});

describe.skipIf(!CHROME)('screenshots through a bridge', () => {
  let b: TestBridge;
  let stdio: Client;
  beforeAll(async () => {
    ensureBuild();
    b = await startBridge();
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    stdio = new Client({ name: 'test', version: '1' });
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'bridge/mcp.ts'], cwd: root, env: { ...env, CANVAS_BRIDGE: b.url, CANVAS_AS: 'Tester' } }));
    await b.post('/agent/run', { as: 'Setup', name: 'board.add', args: { text: 'hello', x: 0, y: 0, color: '1' } });
  }, 120_000);
  afterAll(async () => {
    await stdio?.close().catch(() => {});
    b?.stop();
  });

  it('A15: the CLI writes a PNG of the right size; the stdio MCP returns an image block; the bridge’s own routes still answer', async () => {
    const out = join(b.dir, 'shot.png');
    const env = { ...process.env, CANVAS_BRIDGE: b.url };
    const outText = execFileSync(process.execPath, ['--import', 'tsx', 'bridge/cli.ts', '--as', 'Tester', 'screenshot', '--labels', '--width', '800', '--height', '600', '--out', out], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    expect(outText).toContain(out);
    expect(pngSize(readFileSync(out))).toEqual({ width: 800, height: 600 });
    const s = parts(await stdio.callTool({ name: 'canvas_screenshot', arguments: {} }));
    expect(pngSize(s.png)).toEqual({ width: 1000, height: 750 });
    expect(s.text).toContain('agent:tester');
    expect((await b.get('/status')).nodes).toBe(1);
    expect((await fetch(b.url + '/doc')).status).toBe(200);
  }, 90_000);
});
