// @vitest-environment happy-dom
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { App } from '../src/core';
import { registerCoreCommands } from '../src/core/commands';
import { Store } from '../src/core/store';
import { battleLinePlugin } from '../src/plugins/battleline';
import { boardPlugin } from '../src/plugins/board';
import { cardsPlugin } from '../src/plugins/cards';
import { logic as cardsLogic } from '../src/plugins/cards/logic';
import { chessPlugin } from '../src/plugins/chess';
import { clockPlugin } from '../src/plugins/clock';
import { stormPlugin } from '../src/plugins/eventstorm';
import { diagramPlugin } from '../src/plugins/diagram';
import { createFramesPlugin } from '../src/plugins/frames';
import { PLUGIN_LOGIC, registerPluginLogic, useLogic } from '../src/plugins/logic';
import { matsPlugin } from '../src/plugins/mats';
import { prototypePlugin } from '../src/plugins/prototype';

// The bridge must know every command the browser does. The Host is loaded in a real Node process
// (tsx): vitest transforms .css imports away, Node does not, so a plugin logic module that reaches
// CSS or the DOM through an import fails here.

const root = join(__dirname, '..');
const bridgeCommands: string[] = JSON.parse(
  execFileSync(join(root, 'node_modules/.bin/tsx'), ['-e', "import('./bridge/host.ts').then(m => console.log(JSON.stringify(new m.Host().store.commandNames())))"], { cwd: root, encoding: 'utf8', timeout: 30000 }).trim().split('\n').pop()!,
);

// the catalog (zod/mini, plugin specs) loads in plain Node too, and describes the same commands
const nodeCatalog: { ids: string[]; described: string[] } = JSON.parse(
  execFileSync(join(root, 'node_modules/.bin/tsx'), ['-e', "import('./bridge/catalog.ts').then(m => { const c = m.buildCatalog(); console.log(JSON.stringify({ ids: c.plugins().map(p => p.id), described: c.commandNames().filter(n => c.spec(n)) })) })"], { cwd: root, encoding: 'utf8', timeout: 30000 }).trim().split('\n').pop()!,
);

// the browser's plugins in main.ts order
function browserCommands() {
  const app = new App(document.createElement('div'));
  registerPluginLogic(app.store);
  for (const p of [cardsPlugin, chessPlugin, clockPlugin, battleLinePlugin, matsPlugin, boardPlugin, stormPlugin, prototypePlugin, diagramPlugin, createFramesPlugin({ room: null, enter() {}, connect: null })]) app.use(p);
  return app.store.commandNames();
}

describe('bridge plugin logic', () => {
  it('the Node-loaded bridge Host knows exactly the commands the browser registers', () => {
    expect(bridgeCommands).toEqual(browserCommands());
  });

  it('covers every plugin', () => {
    for (const prefix of ['core.', 'cards.', 'chess.', 'clock.', 'battleline.', 'mats.', 'board.', 'diagram.', 'storm.', 'page.', 'frames.']) {
      expect(bridgeCommands.some((c) => c.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it('the catalog loads in Node and its described commands are real commands', () => {
    expect(nodeCatalog.ids).toEqual(['core', ...PLUGIN_LOGIC.map((e) => e.id)]);
    expect(nodeCatalog.described.length).toBeGreaterThan(15);
    for (const n of nodeCatalog.described) expect(bridgeCommands, n).toContain(n);
  });

  it('registers frames last (its rider rule must follow the others)', () => {
    expect(PLUGIN_LOGIC.map((e) => e.id)).toEqual(['cards', 'chess', 'clock', 'battleline', 'mats', 'board', 'diagram', 'eventstorm', 'prototype', 'excalidraw', 'frames']);
  });

  it('useLogic skips logic a store already has', () => {
    const s = new Store();
    registerCoreCommands(s);
    registerPluginLogic(s);
    expect(() => useLogic(s, cardsLogic)).not.toThrow();
  });
});
