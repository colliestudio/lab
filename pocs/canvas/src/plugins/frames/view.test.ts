// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { App } from '../../core';
import { chessPlugin } from '../chess';
import { buildChessRoom } from './demo';
import { createFramesPlugin } from './index';

// The real view + frames plugin on a DOM: portals choose live / snapshot / nothing, render the
// other room with the app's own renderers; present mode steps through slides.

let roots: HTMLElement[] = [];
afterEach(() => {
  for (const r of roots) r.remove();
  roots = [];
  document.querySelectorAll('.fr-outline, .fr-present-bar, .ch-palette').forEach((e) => e.remove());
  document.body.className = '';
});

function setup(room: string | null = null) {
  const root = document.createElement('div');
  Object.defineProperty(root, 'clientWidth', { value: 1200 });
  Object.defineProperty(root, 'clientHeight', { value: 800 });
  document.body.append(root);
  roots.push(root);
  const app = new App(root);
  app.use(chessPlugin);
  const remote = new Y.Doc();
  buildChessRoom(remote);
  const entered: string[] = [];
  const frames = createFramesPlugin({
    room,
    enter: (r) => entered.push(r),
    connect: (_r, doc) => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
      return { destroy() {} };
    },
  });
  app.use(frames);
  app.store.load({
    nodes: [
      { id: 'f1', type: 'group', label: 'One', x: 0, y: 0, width: 800, height: 600, 'x-frame': {} },
      { id: 'f2', type: 'group', label: 'Two', x: 1000, y: 0, width: 800, height: 600, 'x-frame': {} },
      { id: 'p', type: 'file', file: 'chess-room.canvas', x: 1050, y: 50, width: 600, height: 450, 'x-portal': { room: 'chess-room' } },
    ],
    edges: [],
  });
  return { app, root, frames, entered };
}

const flush = () => new Promise((r) => setTimeout(r, 40));

describe('portal view', () => {
  it('big on screen: live, drawn with the chess renderers; small: snapshot; off screen: nothing', async () => {
    const { app, root, frames } = setup();
    app.viewport.set(-1000, 0, 1); // portal fully on screen at 600px wide
    frames.portals!.draw();
    const body = root.querySelector<HTMLElement>('.fr-portal-body')!;
    expect(body.dataset.mode).toBe('live');
    expect(body.querySelectorAll('.cv-node[data-kind="chess-board"]').length).toBe(1);
    expect(body.querySelectorAll('.cv-node[data-kind="chess-piece"]').length).toBe(32);
    expect(body.querySelector('[data-node-id]')).toBeNull(); // the main view never mistakes them for its own nodes
    app.viewport.set(0, 0, 0.2); // 120px wide
    frames.portals!.draw();
    expect(body.dataset.mode).toBe('snap');
    expect(body.querySelectorAll('svg rect').length).toBe(34);
    app.viewport.set(-50000, 0, 1);
    frames.portals!.draw();
    expect(body.dataset.mode).toBe('off');
    await flush();
  });
  it('a portal into the room you are in shows a note, not itself', () => {
    const { app, root, frames } = setup('chess-room');
    app.viewport.set(-1000, 0, 1);
    frames.portals!.draw();
    expect(root.querySelector<HTMLElement>('.fr-portal-body')!.dataset.mode).toBe('self');
    expect(frames.portals!.rooms.openRooms()).toEqual([]);
  });
  it('double-click enters the room', () => {
    const { app, entered } = setup();
    app.typeOf(app.node('p')!)!.onDoubleClick!(app.node('p')!, app);
    expect(entered).toEqual(['chess-room']);
  });
});

describe('present mode', () => {
  it('steps through the slides (skipping skipped frames) and ends with Esc', () => {
    const { app, frames } = setup();
    app.dispatch('frames.skip', { id: 'f1', skip: true });
    app.dispatch('core.add', { nodes: [{ id: 'f3', type: 'group', label: 'Three', x: 2000, y: 0, width: 800, height: 600, 'x-frame': {} }] });
    const p = frames.presenter!;
    p.start();
    expect(document.body.classList.contains('fr-presenting')).toBe(true);
    expect(p.state()).toMatchObject({ frame: 'f2', index: 0, count: 2 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(p.state()).toMatchObject({ frame: 'f3', index: 1 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); // last: stays
    expect(p.current).toBe('f3');
    app.dispatch('core.delete', { ids: ['f3'] }); // deleted mid-talk: back to a slide that exists
    expect(p.current).toBe('f2');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(p.active).toBe(false);
    expect(document.body.classList.contains('fr-presenting')).toBe(false);
  });
});
