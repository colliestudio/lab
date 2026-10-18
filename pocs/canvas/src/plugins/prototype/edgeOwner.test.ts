// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../core';
import { boardPlugin } from '../board';
import { prototypePlugin } from './index';

afterEach(() => document.body.replaceChildren());

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const app = new App(root);
  app.use(boardPlugin);
  app.use(prototypePlugin);
  return { app, root };
}
const flush = () => new Promise((r) => setTimeout(r, 40));

describe('one renderer per edge', () => {
  it('a plain board edge is drawn by core only', async () => {
    const { app, root } = setup();
    app.dispatch('board.add', { id: 'a', text: 'A', x: 0, y: 0 });
    app.dispatch('board.add', { id: 'b', text: 'B', x: 500, y: 200 });
    app.dispatch('board.connect', { from: 'a', to: 'b', label: 'x' });
    await flush();
    expect(app.store.doc.edges.length).toBe(1);
    expect(root.querySelectorAll('.cv-edges line').length).toBe(1);
    expect(root.querySelectorAll('.cv-edges text').length).toBe(1);
    expect(root.querySelector('.cv-edges text')!.textContent).toBe('x');
    expect(root.querySelectorAll('.pg-edge').length).toBe(0);
    expect(root.querySelectorAll('.pg-edge-label').length).toBe(0);
  });

  it('a page-to-page link is drawn by the prototype layer only', async () => {
    const { app, root } = setup();
    app.dispatch('page.create', { x: 0, y: 0, title: 'A' });
    app.dispatch('page.create', { x: 600, y: 0, title: 'B' });
    const [a, b] = app.store.doc.nodes.map((n) => n.id);
    app.dispatch('page.link', { from: a, to: b, label: 'Go' });
    await flush();
    expect(app.store.doc.edges.length).toBe(1);
    expect(root.querySelectorAll('.pg-edge-label').length).toBe(1);
    expect(root.querySelectorAll('.pg-edge:not(.pg-head)').length).toBe(1);
    expect(root.querySelectorAll('.cv-edges line, .cv-edges text, .cv-edge-label').length).toBe(0);
  });
});
