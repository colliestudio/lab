import type { Command, Store } from '../../core';
import { commands, duplicateRule } from './commands';
import { repairImport } from './io';
import { isNote, note } from './model';

/** The data side of the plugin (no DOM): commands, riders, import repair. Used by tests too. */
export function registerPrototypeLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`page.${name}`, cmd as Command);
  // a note rides the page it annotates
  store.addRiderRule((n) => (isNote(n) ? note(n).on : undefined));
  store.importFilters.push(repairImport);
  store.duplicateRules.push((n) => duplicateRule(n));
}
