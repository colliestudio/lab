import type { Command, Store } from '../../core';
import type { PluginLogic } from '../logic';
import { commands } from './commands';
import { repairImport, shapeExport } from './io';

/** The data side of the plugin. No DOM; used by tests too. */
export function registerClockLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`clock.${name}`, cmd as Command);
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
  store.resets.push(commands.resetAll as Command);
}

export const logic: PluginLogic = { id: 'clock', register: registerClockLogic };
