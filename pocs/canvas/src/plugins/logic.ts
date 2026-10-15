import type { Store } from '../core';
import { logic as battleline } from './battleline/logic';
import { logic as board } from './board/logic';
import { logic as cards } from './cards/logic';
import { logic as chess } from './chess/logic';
import { logic as clock } from './clock/logic';
import { logic as eventstorm } from './eventstorm/logic';
import { logic as frames } from './frames/logic';
import { logic as mats } from './mats/logic';
import { logic as prototype } from './prototype/logic';

/**
 * A plugin's data side: what it registers on a Store (commands, riders, repairs, resets,
 * import/export filters). Node-safe: no DOM, no CSS, no runtime import from the core index or a
 * plugin's index.ts, so the browser, the bridge and tests all load it.
 */
export interface PluginLogic {
  id: string;
  register(store: Store): void;
}

/**
 * Every built-in plugin's logic, in registration order (rider rules run in this order: a piece rides
 * its board, the board its frame, so frames comes last). The browser and the bridge both use this.
 */
export const PLUGIN_LOGIC: readonly PluginLogic[] = [cards, chess, clock, battleline, mats, board, eventstorm, prototype, frames];

export function registerPluginLogic(store: Store) {
  for (const entry of PLUGIN_LOGIC) useLogic(store, entry);
}

const registered = new WeakMap<Store, Set<string>>();

/** Register one plugin's logic on a store unless it already has it (a plugin's `setup` calls this). */
export function useLogic(store: Store, entry: PluginLogic) {
  let ids = registered.get(store);
  if (!ids) registered.set(store, (ids = new Set()));
  if (ids.has(entry.id)) return;
  ids.add(entry.id);
  entry.register(store);
}
