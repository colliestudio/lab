// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../core';
import { buildMainMenu } from '../../core/chromeView';
import { prototypePlugin } from './index';

afterEach(() => document.body.replaceChildren());

describe('prototype in the chrome', () => {
  it('Game ▸ Play prototype is disabled without pages, enabled after one is created', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const app = new App(root);
    app.use(prototypePlugin);
    const row = () => (buildMainMenu(app).find((e) => e.label === 'Game')!.items as { label: string; hint?: string; disabled?: boolean | string }[]).find((e) => e.label === 'Play prototype')!;
    expect(row().disabled).toBe('No pages yet');
    expect(row().hint).toBe('⇧↵');
    app.dispatch('page.create', { x: 0, y: 0, title: 'A' });
    expect(row().disabled).toBeFalsy();
  });
});
