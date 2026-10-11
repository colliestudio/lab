import { BrowserWindow } from 'electron';
import type { BoardFile } from '../../bridge/board';
import type { Actor } from '../../bridge/host';
import type { BridgeService } from '../../bridge/service';

// Agents seeing the board: per agent seat and board, a hidden BrowserWindow (show: false) loading the
// same web app in agent-view mode (?agentView=<actor id>: no chrome, no presence of its own, sees what
// that seat may see) with its own camera. Screenshots use webContents.capturePage(): browser-level
// capture, so cross-origin iframes (embedded pages, sandboxed plugin frames) are in the picture,
// which in-page JS capture (html2canvas, SVG foreignObject) can't do.

export type ShotTarget = { kind: 'board' } | { kind: 'viewport' } | { kind: 'node'; id: string };

export interface ShotOptions {
  width?: number;
  height?: number;
  padding?: number;
  format?: 'png' | 'jpeg';
  /** Keep device pixels (2x on Retina); default: scale to width x height (fewer tokens). */
  hidpi?: boolean;
}

interface View {
  win: BrowserWindow;
  ready: Promise<void>;
  boardId: string;
  actorId: string;
  last: number;
}

const IDLE_MS = 5 * 60_000;

export class AgentViews {
  private views = new Map<string, View>();
  private sweepTimer = setInterval(() => this.sweep(), 30_000);

  constructor(
    private service: BridgeService,
    private log: (...m: unknown[]) => void,
  ) {}

  private key(boardId: string, actorId: string) {
    return `${actorId}@${boardId}`;
  }

  /** The seat's view of the board (created hidden on first use). */
  view(b: BoardFile, actor: Actor, width: number, height: number): View {
    const k = this.key(b.id, actor.id);
    let v = this.views.get(k);
    if (v && !v.win.isDestroyed()) {
      v.last = Date.now();
      return v;
    }
    const t0 = performance.now();
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      title: `${actor.name} sees ${b.name}`,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        // its own in-memory storage: not the person's player identity, nothing left on disk
        partition: 'agent-views',
      },
    });
    const url = `${process.env.CANVAS_WEB_URL?.replace(/\/+$/, '') ?? this.service.origin}/?bridge=${encodeURIComponent(this.service.wsUrl(b))}&agentView=${encodeURIComponent(actor.id)}`;
    const ready = (async () => {
      await win.loadURL(url);
      // mark embedded pages as they finish loading (load doesn't bubble; capture does reach the document)
      await win.webContents.executeJavaScript(
        `document.addEventListener('load', (e) => { if (e.target instanceof HTMLIFrameElement) e.target.dataset.loaded = '1'; }, true); window.canvasSynced`,
      );
      this.log(`views: ${actor.name} view of ${b.name} ready in ${Math.round(performance.now() - t0)} ms`);
    })();
    v = { win, ready, boardId: b.id, actorId: actor.id, last: Date.now() };
    this.views.set(k, v);
    win.on('closed', () => this.views.delete(k));
    return v;
  }

  async screenshot(b: BoardFile, actor: Actor, target: ShotTarget, o: ShotOptions = {}) {
    const width = o.width ?? 1200;
    const height = o.height ?? 800;
    const padding = o.padding ?? 40;
    const t0 = performance.now();
    const v = this.view(b, actor, width, height);
    await v.ready;
    const [cw, ch] = v.win.getContentSize();
    if (cw !== width || ch !== height) v.win.setContentSize(width, height);
    // camera, then wait for paint and for embedded pages (max 3 s)
    const frames: number = await v.win.webContents.executeJavaScript(`(async () => {
      const app = window.app;
      await new Promise((r) => requestAnimationFrame(() => r()));
      const t = ${JSON.stringify(target)};
      if (t.kind === 'board') app.view.fit(${padding});
      else if (t.kind === 'node') { const n = app.node(t.id); if (n) app.view.fit(${padding}, [n], 4); }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const frames = [...document.querySelectorAll('iframe')];
      const until = Date.now() + 3000;
      while (frames.some((f) => !f.dataset.loaded) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      return frames.length;
    })()`);
    let img = await v.win.webContents.capturePage(undefined, { stayHidden: true });
    if (!o.hidpi && img.getSize().width !== width) img = img.resize({ width, height, quality: 'good' });
    const size = img.getSize();
    const jpeg = o.format === 'jpeg';
    const data = jpeg ? img.toJPEG(85) : img.toPNG();
    const ms = Math.round(performance.now() - t0);
    this.log(`views: ${actor.name} screenshot ${b.name} ${target.kind} ${size.width}x${size.height} ${data.length} B in ${ms} ms`);
    return { data, mime: jpeg ? 'image/jpeg' : 'image/png', width: size.width, height: size.height, ms, frames, empty: img.isEmpty() };
  }

  /** The agent left: close its views. */
  dropActor(actorId: string) {
    for (const v of [...this.views.values()]) if (v.actorId === actorId) v.win.destroy();
  }

  /** The board closed: close every view of it. */
  dropBoard(boardId: string) {
    for (const v of [...this.views.values()]) if (v.boardId === boardId) v.win.destroy();
  }

  /** Debug: show the hidden windows (Agents ▸ Show agent views). */
  showAll() {
    for (const v of this.views.values()) v.win.showInactive();
  }

  count() {
    return this.views.size;
  }

  private sweep() {
    const now = Date.now();
    for (const v of [...this.views.values()]) if (now - v.last > IDLE_MS) v.win.destroy();
  }

  closeAll() {
    clearInterval(this.sweepTimer);
    for (const v of [...this.views.values()]) v.win.destroy();
  }
}
