// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { App } from './app';

const press = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('creation tool keys', () => {
  const setup = () => {
    const app = new App(document.createElement('div'));
    app.registerTool({ id: 't.box', label: 'Box', key: 'd', create() {} });
    return app;
  };

  it('pick the tool when no plugin key applies on that letter', () => {
    const app = setup();
    press('d');
    expect(app.view.tool).toBe('t.box');
  });

  it('give way to a plugin key that applies right now (and take over once it does not)', () => {
    const app = setup();
    let applies = true;
    let ran = 0;
    app.registerKey({ key: 'd', label: 'Draw', when: () => applies, run: () => ran++ });
    press('d');
    expect(ran).toBe(1);
    expect(app.view.tool).toBe('select');
    applies = false;
    press('d');
    expect(app.view.tool).toBe('t.box');
    expect(ran).toBe(1);
  });
});
