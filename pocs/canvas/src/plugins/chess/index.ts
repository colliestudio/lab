import './chess.css';
import type { App, CanvasNode, Command, Plugin, Store } from '../../core';
import { commands } from './commands';
import { repairImport, shapeExport } from './io';
import { board, boardIdOf, isBoard, isPiece, piece } from './model';
import { boardHtml, pieceHtml } from './render';

const onGrip = (down: PointerEvent) => !!(down.target as Element | null)?.closest?.('[data-grip]');

/** The data side of the plugin (commands, riders, import/export). No DOM; used by tests too. */
export function registerChessLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`chess.${name}`, cmd as Command);
  store.addRiderRule(boardIdOf);
  store.importFilters.push(repairImport);
  store.exportFilters.push(shapeExport);
}

/** Actions for one board (its tab menu and the right-click menu). */
function boardMenu(app: App, b: CanvasNode) {
  const id = b.id;
  const locked = !board(b).unlocked;
  return [
    { label: 'Set up pieces', run: () => app.dispatch('chess.setup', { id }) },
    { label: board(b).flipped ? 'Flip board (view from white)' : 'Flip board (view from black)', run: () => app.dispatch('chess.flip', { id }) },
    { label: 'Clear board', run: () => app.dispatch('chess.clear', { id }) },
    { label: locked ? 'Unlock (drag anywhere to move)' : 'Lock (drag the tab to move)', run: () => app.dispatch('chess.lock', { id, locked: !locked }) },
  ];
}

/** The board an action aims at: a selected board, else the board of a selected piece. */
const targetBoard = (app: App, sel: CanvasNode[]) => {
  const b = sel.filter(isBoard).at(-1);
  if (b) return b;
  const p = sel.filter(isPiece).at(-1);
  const id = p && app.doc.carrierOf(p.id);
  return id ? app.node(id) : undefined;
};

export const chessPlugin: Plugin = {
  id: 'chess',
  setup(app) {
    registerChessLogic(app.store);
    app.registerKit({ id: 'chess.set', label: 'Chess set', create: (a, at) => a.dispatch('chess.create', at) });

    app.registerType({
      id: 'chess-board',
      match: isBoard,
      render(node, el) {
        el.innerHTML = boardHtml(board(node));
      },
      renderKey: (node) => {
        const b = board(node);
        return `${!!b.flipped}:${!!b.unlocked}:${b.from ?? ''}:${b.to ?? ''}`;
      },
      // a locked board only moves by its tab; its surface acts like the table (box select)
      grabbable: (node, down) => onGrip(down) || !!board(node).unlocked,
      onClick(node, down, app) {
        if (!onGrip(down)) return false;
        app.view.openMenu(boardMenu(app, node), (down.target as Element).closest('[data-grip]')!);
        return true;
      },
    });

    app.registerType({
      id: 'chess-piece',
      match: isPiece,
      render(node, el) {
        el.innerHTML = pieceHtml(piece(node));
      },
      renderKey: (node) => piece(node).piece + piece(node).color,
      onDragEnd: (dragged, app) => app.dispatch('chess.place', { ids: dragged.map((n) => n.id) }),
    });

    const hasBoard = (a: App, sel: CanvasNode[]) => !!targetBoard(a, sel);
    const onBoard = (fn: (a: App, b: CanvasNode) => void) => (a: App, sel: CanvasNode[]) => {
      const b = targetBoard(a, sel);
      if (b) fn(a, b);
    };
    app.registerMenuItem({ label: 'Set up pieces', when: hasBoard, run: onBoard((a, b) => a.dispatch('chess.setup', { id: b.id })) });
    app.registerMenuItem({ label: 'Flip board', when: hasBoard, run: onBoard((a, b) => a.dispatch('chess.flip', { id: b.id })) });
    app.registerMenuItem({ label: 'Clear board', when: hasBoard, run: onBoard((a, b) => a.dispatch('chess.clear', { id: b.id })) });
    app.registerMenuItem({
      get label() {
        const b = targetBoard(app, app.selected());
        return b && board(b).unlocked ? 'Lock board' : 'Unlock board';
      },
      when: (_a, sel) => sel.some(isBoard),
      run: onBoard((a, b) => a.dispatch('chess.lock', { id: b.id, locked: !!board(b).unlocked })),
    });
  },
};

export { commands } from './commands';
