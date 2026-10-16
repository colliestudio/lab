// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { App } from './app';
import type { CanvasNode } from './doc';
import type { KeyBinding, Tool } from './plugin';
import { toolForKey } from './toolKeys';

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

describe('tool keys by context', () => {
  const node = (id: string, shape = false) => ({ id, type: 'text', x: 0, y: 0, width: 1, height: 1, ...(shape ? { 'x-shape': { kind: 'rect' } } : {}) }) as CanvasNode;
  const mk = (key: string): Tool => ({ id: `t.${key}`, label: key, key, owns: (n) => !!n['x-shape'], create: () => {} });
  const tools = [mk('s'), mk('o'), mk('r')];
  const keys = (b: Record<string, Partial<KeyBinding>>) => new Map(Object.entries(b).map(([k, v]) => [k, { key: k, run: () => {}, ...v } as KeyBinding]));
  const app = {} as never;

  it('over empty board a letter picks the tool, even if a plugin binds it without a condition', () => {
    expect(toolForKey(tools, keys({ s: {} }), 's', undefined, app)?.id).toBe('t.s');
    expect(toolForKey(tools, keys({}), 'x', undefined, app)).toBeUndefined();
  });
  it('over another plugin’s object that plugin’s key wins (S on a deck, O on a frame)', () => {
    expect(toolForKey(tools, keys({ s: {}, o: {} }), 's', node('deck'), app)).toBeUndefined();
    expect(toolForKey(tools, keys({ s: {}, o: {} }), 'o', node('frame'), app)).toBeUndefined();
  });
  it('over a diagram shape the tool still works', () => {
    expect(toolForKey(tools, keys({}), 'r', node('a', true), app)?.id).toBe('t.r');
  });
  it('a plugin binding that applies right now beats the tool; one that does not does not', () => {
    expect(toolForKey(tools, keys({ s: { when: () => true } }), 's', undefined, app)).toBeUndefined();
    expect(toolForKey(tools, keys({ s: { when: () => false } }), 's', undefined, app)?.id).toBe('t.s');
  });
  it('a tool’s own when can switch it off', () => {
    expect(toolForKey([{ ...mk('s'), when: () => false }], keys({}), 's', undefined, app)).toBeUndefined();
  });

  it('in the app: the pointer over a plugin’s object keeps the letter for the plugin', () => {
    const a = new App(document.createElement('div'));
    a.registerTool({ id: 't.box', label: 'Box', key: 'd', create() {} });
    let ran = 0;
    a.registerKey({ key: 'd', label: 'Draw', run: () => ran++ }); // no condition, like cards' D
    a.store.apply([{ op: 'add', node: { id: 'deck', type: 'text', x: 0, y: 0, width: 10, height: 10 } }]);
    a.view.hovered = 'deck';
    press('d');
    expect(a.view.tool).toBe('select');
    expect(ran).toBe(1);
    a.view.hovered = undefined;
    press('d');
    expect(a.view.tool).toBe('t.box');
  });
});

