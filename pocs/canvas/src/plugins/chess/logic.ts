import type { Command, Store } from '../../core';
import { commands, duplicatePiece } from './commands';
import { gameCommands, resetGames } from './game';
import { repairImport, shapeExport } from './io';
import { board, boardIdOf, isBoard, isPiece, piece } from './model';
import type { PluginLogic } from '../logic';

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
  // undo can't be trusted in a rules game: once the other side has moved, it restores the pieces but not the game record
  store.undoGuards.push((id, doc) => {
    const n = doc.get(id);
    const b = n && (isBoard(n) ? n : isPiece(n) ? doc.get(piece(n).board ?? '') : undefined);
    return b && isBoard(b) && board(b).rules ? 'Undo is off in a chess game (it would leave the game record wrong): use takeback (chess.takeback)' : undefined;
  });
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
}

export const logic: PluginLogic = { id: 'chess', register: registerChessLogic };
