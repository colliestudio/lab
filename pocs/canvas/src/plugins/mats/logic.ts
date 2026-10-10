import type { Command, Store } from '../../core';
import * as cmds from './commands';
import { repairImport } from './io';
import { isMat, matCarrierOf } from './model';
import { preset } from './presets';

export const commands = {
  create: cmds.create,
  lock: cmds.lock,
  setMat: cmds.setMat,
  addZone: cmds.addZone,
  configZone: cmds.configZone,
  visibility: cmds.visibility,
  resize: cmds.resize,
  placeZones: cmds.placeZones,
  deleteZone: cmds.deleteZone,
  removeMat: cmds.removeMat,
  dealKlondike: cmds.dealKlondike,
  preset,
};

/** The data side of the plugin (commands, riders, import). No DOM; used by tests too. */
export function registerMatsLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`mats.${name}`, cmd as Command);
  store.addRiderRule(matCarrierOf);
  store.importFilters.push(repairImport);
  // a copied mat is a bare mat (its zones and cards stay with the original)
  store.duplicateRules.push((n) => (isMat(n) ? { ...n } : undefined));
}
