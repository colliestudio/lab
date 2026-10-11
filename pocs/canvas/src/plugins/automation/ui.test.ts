// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../core';
import { cardsPlugin } from '../cards';
import { cardsIn, isHand } from '../cards/deck';
import { clockPlugin } from '../clock';
import { matsPlugin } from '../mats';
import { isZone, zoneName } from '../mats/model';
import { automationPlugin, runButton } from './index';
import { buttonOf, isButton } from './model';

let roots: HTMLElement[] = [];
afterEach(() => {
  for (const r of roots) r.remove();
  roots = [];
  localStorage.clear();
});

function screen(id: string) {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const app = new App(root);
  app.viewer = id;
  app.player = { id, name: id, color: '#c33' };
  app.use(cardsPlugin).use(clockPlugin).use(matsPlugin).use(automationPlugin);
  return app;
}
const zone = (app: App, name: string) => app.doc.nodes.find((n) => isZone(n) && zoneName(n) === name)!;
const button = (app: App, name: string) => app.doc.nodes.find((n) => isButton(n) && buttonOf(n).name === name)!;

describe('automation on a table', () => {
  it('renders buttons and runs one on click of its face', () => {
    const app = screen('me');
    app.kits.find((k) => k.id === 'automation.tienlen')!.create(app, { x: 0, y: 0 });
    const deal = button(app, 'Deal Tiến Lên');
    const el = app.view.boxOf(deal.id)!;
    expect(el.querySelector('.au-run')!.textContent).toContain('Deal Tiến Lên');
    expect(el.querySelector('.au-button')!.getAttribute('title')).toContain('1. shuffle Main');
    runButton(app, deal.id);
    expect(cardsIn(app.doc, app.doc.nodes.find(isHand)!.id)).toHaveLength(13);
    expect(cardsIn(app.doc, zone(app, 'Set aside').id)).toHaveLength(39);
  });
  it('a rule fires when a card enters its zone, in the same undo step as the play', () => {
    const app = screen('me');
    app.kits.find((k) => k.id === 'automation.tienlen')!.create(app, { x: 0, y: 0 });
    app.dispatch('auto.edit', { id: button(app, 'Deal Tiến Lên').id, steps: [{ do: 'deal', from: { name: 'Main' }, count: 1 }] });
    runButton(app, button(app, 'Deal Tiến Lên').id);
    const hand = app.doc.nodes.find(isHand)!;
    const [only] = cardsIn(app.doc, hand.id);
    app.store.newUndoStep();
    app.dispatch('cards.drop', { target: zone(app, 'Pile').id, ids: [only.id] });
    const last = app.store.log.get(app.store.log.length - 1).text;
    expect(last).toMatch(/^a card entered Pile → ran ▶ Someone went out: played their last card/);
    const steps = app.store.undoManager.undoStack.length;
    app.store.undo();
    expect(cardsIn(app.doc, hand.id)).toHaveLength(1);
    expect(app.store.undoManager.undoStack.length).toBe(steps - 1);
  });
});
