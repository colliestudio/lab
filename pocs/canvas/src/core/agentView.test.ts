// @vitest-environment happy-dom
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { cardsPlugin } from '../plugins/cards';
import { CARD_W, cardNode, deckNode, standardDeck } from '../plugins/cards/deck';
import { App } from './app';
import { covers, mountAgentView } from './agentView';
import { joinBridge } from './sync';

let roots: HTMLElement[] = [];
afterEach(() => {
  for (const r of roots) r.remove();
  roots = [];
  document.querySelectorAll('.cv-shot-labels').forEach((e) => e.remove());
});

const W = 800;
const H = 600;
function table(viewer = 'agent:claude') {
  const root = document.createElement('div');
  Object.defineProperty(root, 'clientWidth', { value: W });
  Object.defineProperty(root, 'clientHeight', { value: H });
  document.body.append(root);
  roots.push(root);
  const app = new App(root);
  app.viewer = viewer;
  app.use(cardsPlugin);
  return { app, root, shot: mountAgentView(app) };
}
const text = (id: string, x: number, y: number, w = 200, h = 100) => ({ id, type: 'text', x, y, width: w, height: h, text: id });
/** Screen box of a world box under the app's camera. */
const screen = (app: App, b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x * app.viewport.zoom + app.viewport.x,
  y: b.y * app.viewport.zoom + app.viewport.y,
  w: b.width * app.viewport.zoom,
  h: b.height * app.viewport.zoom,
});

describe('View.fitBox (A1)', () => {
  it('centers a world box with the padding around it; node fit is fitBox of the node', () => {
    const { app } = table();
    app.view.fitBox({ x: 100, y: 50, width: 400, height: 300 }, 50, 4);
    const s = screen(app, { x: 100, y: 50, width: 400, height: 300 });
    expect(app.viewport.zoom).toBeCloseTo(Math.min((W - 100) / 400, (H - 100) / 300));
    expect(s.x + s.w / 2).toBeCloseTo(W / 2);
    expect(s.y + s.h / 2).toBeCloseTo(H / 2);
    const zoom = app.viewport.zoom;
    app.store.load({ nodes: [text('a', 100, 50, 400, 300)], edges: [] });
    app.view.fit(50, [app.node('a')!], 4);
    expect(app.viewport.zoom).toBeCloseTo(zoom);
    app.view.fitBox({ x: 0, y: 0, width: 10, height: 10 }, 0, 1.5);
    expect(app.viewport.zoom).toBe(1.5); // maxZoom still caps
  });
});

describe('canvasShot.frame (A2, A3)', () => {
  const nodes = [text('a', 0, 0), text('b', 1000, 0), text('c', 0, 800)];
  it('board / node / region aim the camera so the target sits inside the view with the padding', async () => {
    const { app, shot } = table();
    app.store.load({ nodes, edges: [] });
    await shot.frame({ target: { kind: 'all' }, padding: 40 });
    for (const n of nodes) {
      const s = screen(app, n);
      expect(s.x).toBeGreaterThanOrEqual(40 - 0.5);
      expect(s.x + s.w).toBeLessThanOrEqual(W - 40 + 0.5);
      expect(s.y + s.h).toBeLessThanOrEqual(H - 40 + 0.5);
    }
    await shot.frame({ target: { kind: 'node', id: 'b' }, padding: 40 });
    let s = screen(app, nodes[1]);
    expect(s.x).toBeGreaterThanOrEqual(39.5);
    expect(s.x + s.w).toBeLessThanOrEqual(W - 39.5);
    expect(s.x + s.w / 2).toBeCloseTo(W / 2);
    const region = { x: 900, y: -50, width: 400, height: 300 };
    await shot.frame({ target: { kind: 'region', ...region }, padding: 0 });
    s = screen(app, region);
    expect(s.x).toBeCloseTo(0);
    expect(s.y + s.h / 2).toBeCloseTo(H / 2);
  });

  it('a node the seat may not see throws "not shown to"; so does an unknown one', async () => {
    const { app, shot } = table('bob');
    const faces = standardDeck();
    app.store.load({ nodes: [deckNode('d', -400, 0, 1, undefined, true), ...faces.slice(0, 2).map((face, i) => cardNode(`c${i}`, 200 + i * CARD_W, 0, { face, faceUp: false, home: 'd' }, 2 + i))], edges: [] });
    const h = app.dispatch('cards.newHand', { owner: 'alice', label: 'h', x: 0, y: 400 }).select![0];
    app.dispatch('cards.drop', { target: h, ids: ['c0', 'c1'] });
    app.dispatch('cards.hideCount', { id: h, on: true });
    await expect(shot.frame({ target: { kind: 'node', id: 'c0' } })).rejects.toThrow('not shown to bob');
    await expect(shot.frame({ target: { kind: 'node', id: 'nope' } })).rejects.toThrow('not shown to bob');
    const r = await shot.frame({ target: { kind: 'all' }, labels: true });
    expect(r.nodes.map((n) => n.id)).not.toContain('c0');
  });

  it('labels add one id pill per node in view and nothing else; labels:false removes them', async () => {
    const { app, root, shot } = table();
    app.store.load({ nodes, edges: [] });
    const r = await shot.frame({ target: { kind: 'region', x: -50, y: -50, width: 400, height: 300 }, padding: 0, labels: true });
    expect(r.nodes.map((n) => n.id)).toEqual(['a']); // b and c are outside the region
    for (const n of r.nodes) {
      const [x, y, w, h] = n.box;
      expect(x + w).toBeGreaterThan(0);
      expect(x).toBeLessThan(W);
      expect(y + h).toBeGreaterThan(0);
      expect(y).toBeLessThan(H);
    }
    expect([...root.querySelectorAll('.cv-shot-label')].map((e) => e.textContent)).toEqual(['a']);
    const again = await shot.frame({ target: { kind: 'all' }, labels: true });
    expect(again.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    expect(root.querySelectorAll('.cv-shot-label')).toHaveLength(3);
    await shot.frame({ target: { kind: 'all' }, labels: false });
    expect(root.querySelectorAll('.cv-shot-label')).toHaveLength(0);
  });
});

describe('observer and freshness (A4)', () => {
  it('an observer joins with no awareness state; a normal join has one', () => {
    const { app } = table();
    const obs = joinBridge(app, 'ws://127.0.0.1:1', { id: 'agent:x', name: 'x', color: '#000' }, undefined, { observer: true });
    expect(obs.presence.awareness.getLocalState()).toBeNull();
    obs.leave();
    const { app: app2 } = table();
    const norm = joinBridge(app2, 'ws://127.0.0.1:1', { id: 'p', name: 'p', color: '#000' });
    expect(norm.presence.awareness.getLocalState()).not.toBeNull();
    norm.leave();
  });

  it('covers: true when every client clock is reached, false while one is behind', () => {
    const server = new Y.Doc();
    server.getMap('m').set('a', 1);
    const page = new Y.Doc();
    const sv = Y.encodeStateVector(server);
    expect(covers(page, sv)).toBe(false);
    Y.applyUpdate(page, Y.encodeStateAsUpdate(server));
    expect(covers(page, sv)).toBe(true);
    expect(covers(page, Y.encodeStateVector(new Y.Doc()))).toBe(true);
  });

  it('frame waits for the state vector, then continues', async () => {
    const { app, shot } = table();
    const server = new Y.Doc();
    server.getMap('m').set('a', 1);
    const sv = btoa(String.fromCharCode(...Y.encodeStateVector(server)));
    let done = false;
    const p = shot.frame({ target: { kind: 'all' }, stateVector: sv }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 120));
    expect(done).toBe(false);
    Y.applyUpdate(app.store.ydoc, Y.encodeStateAsUpdate(server));
    await p;
    expect(done).toBe(true);
  });
});

describe('read-only view', () => {
  it('dispatch does nothing and says why, so a plugin timer cannot write', () => {
    const { app } = table();
    app.store.load({ nodes: [text('a', 0, 0)], edges: [] });
    app.readOnly = true;
    const r = app.dispatch('core.delete', { ids: ['a'] });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('read-only') });
    expect(app.node('a')).toBeDefined();
    app.readOnly = false;
    expect(app.dispatch('core.delete', { ids: ['a'] }).ok).toBe(true);
  });
});
