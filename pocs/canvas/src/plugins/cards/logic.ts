import './standard';
import type { Command, Store } from '../../core';
import type { PluginLogic } from '../logic';
import { commands } from './commands';
import { deckIdOf, isCardish } from './deck';
import { repairImport, shapeExport } from './io';
import { cardLayouts } from './layout';

/** The data side of the plugin (commands, containment, import/export). No DOM; used by tests too. */
export function registerCardsLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`cards.${name}`, cmd as Command);
  store.addParentRule(deckIdOf);
  store.addLayout(cardLayouts);
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
  store.migrations.push(commands.migrateHands as Command);
  store.migrations.push(commands.repairHomes as Command);
  store.resets.push(commands.resetAll as Command);
  // a copied card would be a 53rd card of the pack: cards opt out of Duplicate
  store.duplicateRules.push((n) => (isCardish(n) ? null : undefined));
}

export const logic: PluginLogic = { id: 'cards', register: registerCardsLogic };
