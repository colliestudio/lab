import * as Y from 'yjs';
import type { App } from './app';
import { Viewport } from './viewport';

// Agent view: a normal client of the board that a headless browser keeps open so an agent can ask
// "what does the table look like to me". The page has no chrome and no presence; this file is the
// page-side API the screenshot provider drives (window.canvasShot). It knows nothing about the
// provider: an Electron window or a headless Chrome call the same functions.

export type ShotTarget = { kind: 'all' } | { kind: 'node'; id: string } | { kind: 'region'; x: number; y: number; width: number; height: number };

export interface FrameOpts {
  target: ShotTarget;
  padding?: number;
  labels?: boolean;
  /** base64 of the server's Y.encodeStateVector: wait until this page's doc has at least that much. */
  stateVector?: string;
}

export interface InView {
  id: string;
  type: string;
  /** Screen px in the viewport: x, y, width, height. */
  box: [number, number, number, number];
}

const SYNC_CAP_MS = 2000;
const SETTLE_CAP_MS = 1500;
const QUIET_MS = 100;

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Does `doc` hold every update the state vector `sv` counts (every client's clock at least as far)? */
export function covers(doc: Y.Doc, sv: Uint8Array): boolean {
  const have = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const [client, clock] of Y.decodeStateVector(sv)) if ((have.get(client) ?? 0) < clock) return false;
  return true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function waitSynced(doc: Y.Doc, b64: string | undefined) {
  if (!b64) return;
  const sv = fromBase64(b64);
  const end = Date.now() + SYNC_CAP_MS;
  while (!covers(doc, sv) && Date.now() < end) await sleep(16);
}

/** Resolves once nothing changed under `root` for QUIET_MS (or the cap passed). */
function domQuiet(root: HTMLElement, cap: number): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(quiet);
      clearTimeout(capTimer);
      mo.disconnect();
      resolve();
    };
    const mo = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, QUIET_MS);
    });
    mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    quiet = setTimeout(done, QUIET_MS);
    const capTimer = setTimeout(done, cap);
  });
}

/** Frames whose `load` has not fired yet: a capture-phase listener marks the ones that have. */
function trackFrames(): (root: HTMLElement) => boolean {
  const loaded = new WeakSet<Element>();
  document.addEventListener('load', (e) => e.target instanceof HTMLIFrameElement && loaded.add(e.target), true);
  return (root) => [...root.querySelectorAll('iframe')].every((f) => loaded.has(f) || !f.src && !f.srcdoc);
}

export interface CanvasShotApi {
  frame(opts: FrameOpts): Promise<{ nodes: InView[] }>;
}

export function mountAgentView(app: App): CanvasShotApi {
  const root = app.view.root;
  const framesLoaded = trackFrames();
  let labelLayer: HTMLElement | undefined;

  /** Rendered, non-concealed nodes that intersect the viewport, with their screen boxes. */
  const inView = (): InView[] => {
    const { x, y, zoom } = app.viewport;
    const w = root.clientWidth;
    const h = root.clientHeight;
    const out: InView[] = [];
    for (const n of app.store.doc.visible) {
      if (app.isConcealed(n)) continue;
      const bx = n.x * zoom + x;
      const by = n.y * zoom + y;
      const bw = n.width * zoom;
      const bh = n.height * zoom;
      if (bx + bw <= 0 || by + bh <= 0 || bx >= w || by >= h) continue;
      out.push({ id: n.id, type: n.type, box: [Math.round(bx), Math.round(by), Math.round(bw), Math.round(bh)] });
    }
    return out;
  };

  const drawLabels = (nodes: InView[]) => {
    labelLayer?.remove();
    labelLayer = undefined;
    if (!nodes.length) return;
    const layer = document.createElement('div');
    layer.className = 'cv-shot-labels';
    for (const n of nodes) {
      const l = document.createElement('span');
      l.className = 'cv-shot-label';
      l.textContent = n.id;
      l.style.transform = `translate(${Math.max(0, n.box[0])}px, ${Math.max(0, n.box[1])}px)`;
      layer.append(l);
    }
    root.append(layer);
    labelLayer = layer;
  };

  const aim = (t: ShotTarget, padding: number) => {
    const doc = app.store.doc;
    if (t.kind === 'all') return app.view.fit(padding);
    if (t.kind === 'region') return app.view.fitBox(t, padding, Viewport.MAX);
    const n = doc.get(t.id);
    if (!n || !doc.isVisible(t.id) || app.isConcealed(n)) throw new Error(`node ${t.id} is not shown to ${app.viewer}`);
    app.view.fit(padding, [n], Viewport.MAX);
  };

  const api: CanvasShotApi = {
    async frame(opts) {
      await waitSynced(app.store.ydoc, opts.stateVector);
      aim(opts.target, opts.padding ?? 40);
      drawLabels([]);
      const start = Date.now();
      await frame();
      await frame();
      await document.fonts?.ready;
      while (!framesLoaded(root) && Date.now() - start < SETTLE_CAP_MS) await sleep(30);
      await domQuiet(root, Math.max(0, SETTLE_CAP_MS - (Date.now() - start)));
      const nodes = inView();
      if (opts.labels) drawLabels(nodes);
      await frame();
      return { nodes };
    },
  };
  (window as unknown as { canvasShot: CanvasShotApi }).canvasShot = api;
  return api;
}
