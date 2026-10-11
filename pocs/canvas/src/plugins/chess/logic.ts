import type { Command, Store } from '../../core';
import { commands, duplicatePiece } from './commands';
import { gameCommands, resetGames } from './game';
import { repairImport, shapeExport } from './io';
import { boardIdOf } from './model';

/**
 * The data side of the plugin (commands, riders, import/export, rules mode). No DOM: the browser
 * plugin, tests and the Node bridge all register this, so an agent's move is the command a drag runs.
 */
export function registerChessLogic(store: Store) {
  for (const [name, cmd] of Object.entries({ ...commands, ...gameCommands })) store.register(`chess.${name}`, cmd as Command);
  store.addRiderRule(boardIdOf);
  store.duplicateRules.push(duplicatePiece);
  store.resets.push(commands.resetAll as Command, resetGames as Command);
  store.repairs.push(commands.repair as Command);
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
}
