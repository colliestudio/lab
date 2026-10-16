// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../core';
import { buildMainMenu } from '../../core/chromeView';
import { cardsPlugin } from './index';

afterEach(() => document.body.replaceChildren());
function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const app = new App(root);
  app.player = { id: 'me', name: 'Me', color: '#4363d8' };
  app.viewer = 'me';
  app.use(cardsPlugin);
  return app;
}
const game = (app: App) => buildMainMenu(app).find((e) => e.label === 'Game')!;
const items = (app: App) => game(app).items as Exclude<ReturnType<typeof game>['items'], undefined | (() => unknown)>;

describe('cards in the chrome', () => {
  it('solo: Game ▸ New hand makes my hand, no submenu', () => {
    const app = setup();
    const row = items(app).find((e) => e.label === 'New hand')!;
    expect(row.items).toBeUndefined();
    row.run!();
    expect(app.doc.nodes.some((n) => n.label === "Me's hand")).toBe(true);
  });
  it('in a room: New hand for ▸ lists the players, me first', () => {
    const app = setup();
    app.presence = { me: { id: 'me', name: 'Me', color: '#4363d8' }, peers: () => [{ clientId: 2, id: 'sam', name: 'Sam', color: '#3cb44b', cursor: null, sel: [], held: [] }] } as never;
    const row = items(app).find((e) => e.label === 'New hand for')!;
    const sub = typeof row.items === 'function' ? row.items() : row.items!;
    expect(sub[0].label).toContain('Me');
    expect(sub.map((e) => e.label).join()).toContain('Sam');
  });
  it('playerRenamed relabels my hand', () => {
    const app = setup();
    items(app).find((e) => e.label === 'New hand')!.run!();
    app.playerRenamed({ id: 'me', name: 'Zed', color: '#e6194b' });
    expect(app.doc.nodes.find((n) => n.label?.endsWith("'s hand"))?.label).toBe("Zed's hand");
  });
});
