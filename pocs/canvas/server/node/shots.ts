import type { Actor } from '../core/host';
import { ShotError, shotSize, type Shot, type ShotProvider, type ShotRequest } from '../core/shots';
import type { Log } from '../core/transport';

// Screenshots through one headless Chrome kept warm in this process (the serve or the bridge).
// Per (board, seat) it keeps a page on the board's own web app in agent view (src/core/agentView.ts):
// a real client of the board, so what it draws is what a person's tab draws for that seat. The shot
// is the browser's own capture, so cross-origin frames are in the picture.

export interface ShotPage {
  goto(url: string, o: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<{ status(): number } | null>;
  evaluate(expression: string): Promise<unknown>;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
  screenshot(o: { type: 'png' }): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface ShotContext {
  newPage(): Promise<ShotPage>;
  close(): Promise<void>;
}
export interface ShotBrowser {
  newContext(o: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<ShotContext>;
  close(): Promise<void>;
  on(event: 'disconnected', fn: () => void): unknown;
}

export interface HeadlessShotsOptions {
  /** The page for a seat on a board: the web app in agent view. */
  pageUrl(board: string, actorId: string): string;
  log: Log;
  /** A view unused this long is closed. Default 2 minutes. */
  idleMs?: number;
  /** The browser is closed after this long with no view. Default 5 minutes. */
  browserIdleMs?: number;
  /** At most this many warm views; the least recently used goes first. Default 8. */
  maxViews?: number;
  /** How the browser starts (tests inject a fake). */
  launch?: () => Promise<ShotBrowser>;
}

const NO_BROWSER = 'no browser for screenshots: install Google Chrome, set CANVAS_CHROME to a Chrome/Chromium binary, or set CANVAS_CDP to a running Chrome (canvas_look still works)';
const NO_BUILD = 'screenshots need the built web app: run pnpm build';

/** The slice of playwright-core's `chromium` that picks a browser (tests inject a fake). */
export interface ChromiumLike {
  launch(o: { executablePath?: string; channel?: string; headless: boolean }): Promise<unknown>;
  connectOverCDP(endpoint: string): Promise<unknown>;
}

/**
 * CANVAS_CDP=<ws or http url of a running Chrome> shares that browser (Chrome started with
 * --remote-debugging-port): we open our own contexts in it and close only those. If it can't be
 * reached, or CANVAS_CDP is unset, Chrome is launched (CANVAS_CHROME binary, else the installed Chrome).
 */
export async function launchChrome(log: Log = () => {}, env: NodeJS.ProcessEnv = process.env, chromium?: ChromiumLike): Promise<ShotBrowser> {
  chromium ??= (await import('playwright-core')).chromium as unknown as ChromiumLike;
  const cdp = env.CANVAS_CDP?.trim();
  if (cdp) {
    try {
      const b = (await chromium.connectOverCDP(cdp)) as unknown as ShotBrowser;
      const mine = new Set<ShotContext>();
      return {
        async newContext(o) {
          const c = await b.newContext(o);
          mine.add(c);
          const close = c.close.bind(c);
          c.close = async () => {
            mine.delete(c);
            await close();
          };
          return c;
        },
        // the shared Chrome stays: our contexts go, then we let go of the connection
        async close() {
          await Promise.all([...mine].map((c) => c.close().catch(() => {})));
          await b.close();
        },
        on: (event, fn) => b.on(event, fn),
      };
    } catch (e) {
      log(`screenshots: CANVAS_CDP ${cdp} did not answer (${String((e as Error).message).split('\n')[0]}); launching Chrome instead`);
    }
  }
  const executablePath = env.CANVAS_CHROME;
  return (await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: 'chrome', headless: true })) as unknown as ShotBrowser;
}

interface View {
  key: string;
  board: string;
  context: ShotContext;
  page: ShotPage;
  size: { width: number; height: number };
  lastUsed: number;
  /** Shots queued or running on this page: a busy view is never evicted. */
  busy: number;
  closed: boolean;
  /** Shots on this page run one at a time. */
  chain: Promise<unknown>;
}

export class HeadlessShots implements ShotProvider {
  private browser: Promise<ShotBrowser> | undefined;
  private views = new Map<string, Promise<View>>();
  /** The views that finished opening (the ones that can be evicted). */
  private ready = new Map<string, View>();
  /** Seats with a shot asked for but not yet on a view (still opening, or between the lookup and the queue): their view is not evictable. */
  private claims = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private emptySince = 0;
  private readonly idleMs: number;
  private readonly browserIdleMs: number;
  private readonly maxViews: number;

  constructor(private o: HeadlessShotsOptions) {
    this.idleMs = o.idleMs ?? 120_000;
    this.browserIdleMs = o.browserIdleMs ?? 300_000;
    this.maxViews = o.maxViews ?? 8;
  }

  // ------------------------------------------------------------ browser

  private getBrowser(): Promise<ShotBrowser> {
    if (this.browser) return this.browser;
    const p = (this.o.launch ?? (() => launchChrome(this.o.log)))().then(
      (b) => {
        b.on('disconnected', () => {
          if (this.browser !== p) return;
          this.o.log('screenshots: the browser went away; the next shot starts a new one');
          this.browser = undefined;
          this.views.clear();
          this.ready.clear();
        });
        this.o.log('screenshots: browser started');
        return b;
      },
      (e: Error) => {
        this.browser = undefined;
        this.o.log(`screenshots: no browser: ${String(e.message).split('\n')[0]}`);
        throw new ShotError(503, NO_BROWSER);
      },
    );
    this.browser = p;
    return p;
  }

  // ------------------------------------------------------------ views

  private view(board: string, actor: Actor, size: { width: number; height: number }): Promise<View> {
    const key = `${actor.id}@${board}`;
    const hit = this.views.get(key);
    if (hit) return hit;
    // pending opens count toward the cap; only an idle view can make room, else the caller is told to retry
    if (this.views.size >= this.maxViews && !this.evictIdle()) return Promise.reject(new ShotError(503, 'too many screenshot views open at once; try again in a moment'));
    const p = this.openView(key, board, actor, size);
    this.views.set(key, p);
    p.catch(() => this.views.get(key) === p && this.views.delete(key));
    this.startTimer();
    return p;
  }

  private async openView(key: string, board: string, actor: Actor, size: { width: number; height: number }): Promise<View> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      const res = await page.goto(this.o.pageUrl(board, actor.id), { waitUntil: 'domcontentloaded', timeout: 15_000 });
      if (res && res.status() === 503) throw new ShotError(503, NO_BUILD);
      if (res && res.status() >= 400) throw new Error(`the board page answered ${res.status()}`);
      await page.evaluate(
        `(async () => {
          const until = Date.now() + 15000;
          while (!window.canvasSynced && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
          if (!window.canvasSynced) throw new Error('the page did not start (is the web app build current? run pnpm build)');
          await Promise.race([window.canvasSynced, new Promise((_, no) => setTimeout(() => no(new Error('the board did not sync in 15 s')), 15000))]);
          return true;
        })()`,
      );
      this.o.log(`screenshots: view ${key} ready`);
      const v: View = { key, board, context, page, size, lastUsed: Date.now(), chain: Promise.resolve(), busy: 0, closed: false };
      this.ready.set(key, v);
      return v;
    } catch (e) {
      await context.close().catch(() => {});
      // the page says when the board it was opened for is gone
      const gone = /(board (not found|not available): .*)/.exec(String((e as Error).message));
      if (gone) throw new ShotError(gone[2] === 'not found' ? 400 : 503, gone[1].split('\n')[0]);
      throw e;
    }
  }

  /** Close the least recently used view that has no shot queued; false when every view is busy or still opening. */
  private evictIdle(): boolean {
    const idle = [...this.ready.values()].filter((v) => v.busy === 0 && !this.claims.get(v.key)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) return false;
    void this.close1(idle, 'too many views');
    return true;
  }

  private async close1(v: View, why: string) {
    if (v.closed) return; // a stale shot failing after its view was closed must not touch a newer view of the same seat
    v.closed = true;
    if (this.ready.get(v.key) === v) {
      this.ready.delete(v.key);
      this.views.delete(v.key);
    }
    this.o.log(`screenshots: closing view ${v.key} (${why})`);
    await v.context.close().catch(() => {});
  }

  // ------------------------------------------------------------ shooting

  async shoot(board: string, actor: Actor, r: ShotRequest): Promise<Shot> {
    const start = Date.now();
    const key = `${actor.id}@${board}`;
    this.claims.set(key, (this.claims.get(key) ?? 0) + 1);
    let v: View;

    try {
      v = await this.view(board, actor, { width: r.width, height: r.height });
      v.lastUsed = Date.now(); // an idle sweep must not close a view that has a shot queued
      v.busy++;
    } finally {
      const n = (this.claims.get(key) ?? 1) - 1;
      if (n) this.claims.set(key, n);
      else this.claims.delete(key);
    }
    const run = v.chain.then(() => this.take(v, r), () => this.take(v, r));
    v.chain = run.catch(() => {});
    const shot = await run.finally(() => v.busy--);
    const ms = Date.now() - start;
    this.o.log(`screenshots: ${actor.name} ${board} ${r.target.kind} ${r.width}x${r.height} ${ms} ms`);
    return { ...shot, ms };
  }

  private async take(v: View, r: ShotRequest): Promise<Omit<Shot, 'ms'>> {
    v.lastUsed = Date.now();
    try {
      let size = { width: r.width, height: r.height };
      if (r.autoSize) {
        const bounds = (await v.page.evaluate('window.canvasShot.bounds()')) as { width: number; height: number } | null;
        size = shotSize(r, bounds);
      }
      if (v.size.width !== size.width || v.size.height !== size.height) {
        await v.page.setViewportSize(size);
        v.size = size;
      }
      const { target, padding, labels, stateVector } = r;
      const framed = (await v.page.evaluate(`window.canvasShot.frame(${JSON.stringify({ target, padding, labels, stateVector })})`)) as { nodes: Shot['nodes'] };
      const png = await v.page.screenshot({ type: 'png' });
      v.lastUsed = Date.now();
      return { png, width: size.width, height: size.height, nodes: framed.nodes };
    } catch (e) {
      const msg = String((e as Error).message);
      const refused = /(node .+ is not shown to .+)/.exec(msg);
      if (refused) throw new ShotError(400, refused[1].split('\n')[0]);
      // a page that failed in any other way is not trusted again: the next shot opens a fresh one
      await this.close1(v, `error: ${msg.split('\n')[0]}`);
      throw new Error(`screenshot failed: ${msg.split('\n')[0]}`);
    }
  }

  // ------------------------------------------------------------ lifecycle

  private startTimer() {
    if (this.timer) return;
    const every = Math.max(20, Math.min(10_000, this.idleMs / 2));
    this.timer = setInterval(() => void this.sweep().catch(() => {}), every);
    this.timer.unref?.();
  }

  /** Close views idle for `idleMs`, and the browser once it has had no view for `browserIdleMs`. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [key, p] of [...this.views]) {
      const v = await p.catch(() => undefined);
      if (v && this.views.get(key) === p && now - v.lastUsed >= this.idleMs) await this.close1(v, 'idle');
    }
    if (this.views.size) this.emptySince = 0;
    else if (this.browser) {
      this.emptySince ||= now;
      if (now - this.emptySince >= this.browserIdleMs) await this.closeBrowser('idle');
    }
  }

  private async closeBrowser(why: string) {
    const b = this.browser;
    this.browser = undefined;
    this.emptySince = 0;
    if (!b) return;
    this.o.log(`screenshots: closing the browser (${why})`);
    await (await b.catch(() => undefined))?.close().catch(() => {});
  }

  async drop(board: string): Promise<number> {
    let n = 0;
    for (const [key, p] of [...this.views]) {
      const v = await p.catch(() => undefined);
      if (v?.board === board && this.views.get(key) === p) {
        await this.close1(v, 'board changing');
        n++;
      }
    }
    return n;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    const views = await Promise.all([...this.views.values()].map((p) => p.catch(() => undefined)));
    this.views.clear();
    this.ready.clear();
    await Promise.all(views.map((v) => v?.context.close().catch(() => {})));
    await this.closeBrowser('stopping');
  }
}
