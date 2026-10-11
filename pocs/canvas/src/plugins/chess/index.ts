import './chess.css';
import type { App, CanvasNode, MenuEntry, Plugin } from '../../core';
import { registerChessLogic } from './logic';
import { board, isBoard, isPiece, piece, pieceName } from './model';
import { mountPalette, targetBoard } from './palette';
import { boardHtml, gameHtml, pieceHtml } from './render';

const onGrip = (down: PointerEvent) => !!(down.target as Element | null)?.closest?.('[data-grip]');

export { registerChessLogic };

/** Rules mode: new game, seats, resign, rules off. Failed commands (a taken seat) flash their reason. */
function gameMenu(app: App, b: CanvasNode): MenuEntry[] {
  const id = b.id;
  const f = board(b);
  const me = app.me().id;
  const run = (name: string, args: unknown) => () => {
    const r = app.dispatch(name, args);
    if (!r.ok && r.error) alert(r.error.replace(/^chess\.\w+: /, ''));
  };
  if (!f.rules) return [{ label: 'Play by the rules (new game)', separator: true, run: run('chess.newgame', { id }) }];
  const mine = f.white?.id === me ? 'w' : f.black?.id === me ? 'b' : undefined;
  const seat = (c: 'w' | 'b'): MenuEntry => {
    const s = c === 'w' ? f.white : f.black;
    const name = c === 'w' ? 'white' : 'black';
    if (s?.id === me) return { label: `Leave the ${name} seat`, run: run('chess.sit', { id, color: c, leave: true }) };
    if (s) return { label: `Free the ${name} seat (${s.name})`, run: run('chess.sit', { id, color: c, leave: true, force: true }) };
    return { label: `Play ${name}`, run: run('chess.sit', { id, color: c }) };
  };
  return [
    { label: 'New game', separator: true, run: run('chess.newgame', { id }) },
    seat('w'),
    seat('b'),
    ...(mine && !f.result ? [{ label: 'Resign', run: run('chess.resign', { id, color: mine }) }] : []),
    { label: 'Free play (rules off)', run: run('chess.rules', { id, on: false }) },
  ];
}

/** Actions for one board (its tab menu and the right-click menu). */
function boardMenu(app: App, b: CanvasNode, pieces: () => void): MenuEntry[] {
  const id = b.id;
  const locked = !board(b).unlocked;
  return [
    { label: 'Set up pieces', run: () => app.dispatch('chess.setup', { id }) },
    { label: 'Clear board', run: () => app.dispatch('chess.clear', { id }) },
    { label: 'Seen from black (flipped)', checked: !!board(b).flipped, run: () => app.dispatch('chess.flip', { id }) },
    { label: 'Locked (move by the tab)', checked: locked, run: () => app.dispatch('chess.lock', { id, locked: !locked }) },
    { label: 'Pieces…', separator: true, run: pieces },
    ...gameMenu(app, b),
  ];
}

export const chessPlugin: Plugin = {
  id: 'chess',
  setup(app) {
    registerChessLogic(app.store);
    app.registerKit({ id: 'chess.set', label: 'Chess set', create: (a, at) => a.dispatch('chess.create', at) });
    // DOM only in the browser (tests use registerChessLogic)
    const palette = typeof document === 'undefined' ? null : mountPalette(app);
    const openPalette = () => palette?.open();
    app.registerKit({ id: 'chess.pieces', label: 'Chess pieces', create: () => palette?.toggle() });

    app.registerType({
      id: 'chess-board',
      match: isBoard,
      render(node, el) {
        el.innerHTML = boardHtml(board(node));
      },
      renderKey: (node) => {
        const b = board(node);
        return `${!!b.flipped}:${!!b.unlocked}:${b.from ?? ''}:${b.to ?? ''}:${gameHtml(b)}`;
      },
      // a locked board only moves by its tab; its surface acts like the table (box select)
      grabbable: (node, down) => onGrip(down) || !!board(node).unlocked,
      onClick(node, down, app) {
        if (!onGrip(down)) return false;
        app.view.openMenu(boardMenu(app, node, openPalette), (down.target as Element).closest('[data-grip]')!, 'Chessboard');
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
      // dropped: snap/capture; nudged with the arrow keys: just keep `square` true to where it stands
      onDragEnd: (dragged, app, _target, via) => app.dispatch('chess.place', { ids: dragged.map((n) => n.id), soft: via === 'keys' }),
    });

    app.registerMenu((a, sel) => {
      if (!sel.length || !sel.every((n) => isBoard(n) || isPiece(n))) return;
      const b = targetBoard(a, sel);
      if (sel.length === 1 && isBoard(sel[0])) return { title: 'Chessboard', entries: boardMenu(a, sel[0], openPalette) };
      const pieces = sel.filter(isPiece);
      const entries: MenuEntry[] = [
        {
          label: sel.some(isBoard) ? 'Duplicate (board and pieces)' : pieces.length > 1 ? `Duplicate ${pieces.length} pieces` : 'Duplicate',
          hint: '⌘D',
          run: () => a.dispatch('core.duplicate', { ids: sel.map((n) => n.id) }),
        },
      ];
      if (b) entries.push({ label: 'Board', items: () => boardMenu(a, b, openPalette) });
      const title = !pieces.length ? 'Chessboards' : pieces.length > 1 ? `${pieces.length} chess pieces` : pieceName(piece(pieces[0])).replace(/^./, (c) => c.toUpperCase());
      return { title, entries };
    });
  },
};

export { commands } from './commands';
