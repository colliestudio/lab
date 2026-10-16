import { describe, expect, it } from 'vitest';
import { registerPluginLogic } from '../plugins/logic';
import { parse, serialize } from './io';
import { registerCoreCommands } from './commands';
import { Store } from './store';

describe('boards saved before the seed was removed', () => {
  it('a board holding the old starter deck (cards.setup) saves, parses and loads as it is', () => {
    const old = new Store();
    registerCoreCommands(old);
    registerPluginLogic(old);
    old.dispatch('cards.setup', { x: -470, y: -120 });
    const n = old.doc.nodes.length;
    expect(n).toBeGreaterThan(40);
    const again = new Store();
    registerCoreCommands(again);
    registerPluginLogic(again);
    again.load(parse(serialize(old.exportDoc())));
    expect(again.doc.nodes).toHaveLength(n);
    expect(again.doc.nodes.some((x) => (x as { 'x-cards'?: unknown })['x-cards'])).toBe(true);
  });
  it('a new store is empty', () => {
    expect(new Store().doc.nodes).toEqual([]);
  });
});
