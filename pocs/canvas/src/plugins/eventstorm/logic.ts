import type { Command, Store } from '../../core';
import { commands, repair, resetAll } from './commands';
import { stormCarrierOf } from './model';

/** The data side of the plugin (commands, rider rule, reset). No DOM; used by tests too. */
export function registerStormLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`storm.${name}`, cmd as Command);
  store.addRiderRule(stormCarrierOf);
  store.resets.push(resetAll);
  store.repairs.push(repair as Command);
}
