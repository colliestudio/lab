import * as z from 'zod/mini';
import { command, nodeRef, view, type AgentCtx, type CommandSpec } from '../../core/agent';
import type { Command, Store } from '../../core';
import type { DispatchResult } from '../../core/store';
import { commands, duplicatePiece } from './commands';
import { findBoard, gameCommands, gameView, resetGames } from './game';
import { repairImport, shapeExport } from './io';
import { board, boardIdOf, isBoard, isPiece, piece } from './model';
import type { PluginLogic } from '../logic';
import { COLORS, gameText } from './text';

// Agent side: how each command and view describes itself (see core/agent.ts). Descriptions and
// examples are what a fresh agent reads; the specs sit next to the commands they describe.
const board_ = z.optional(nodeRef('board id; only needed when the table has several chessboards'));
const text = gameText as (v: unknown) => string;
const onBoard = (a: { board?: string }, ctx: AgentCtx) => findBoard(ctx.doc, a.board, ctx.actor);
/** The game after the command, for the caller. */
const game = (_r: DispatchResult, a: { board?: string }, ctx: AgentCtx) => gameView(ctx.doc, onBoard(a, ctx), ctx.actor);

export const specs: Record<string, CommandSpec> = {
  move: command({
    description: 'Play your move: SAN (Nf3, exd5, O-O, e8=Q) or UCI (e2e4, e7e8q). Refused with the reason (and the legal moves) if illegal or not your turn. Returns the game after it.',
    args: z.strictObject({ move: z.string(), board: board_ }),
    example: { move: 'Nf3' },
    tool: 'chess_move',
    cli: [{ verb: 'chess move', pos: ['move'] }],
    toCommand: (a, ctx) => ({ move: a.move, id: onBoard(a, ctx).id }),
    result: game,
    text,
  }),
  sit: command({
    description: 'Take a seat at a color (white or black): from then on only you move that color. `leave` stands up.',
    args: z.strictObject({ color: z.enum(['white', 'black', 'w', 'b']), leave: z.optional(z.boolean()), board: board_ }),
    example: { color: 'white' },
    tool: 'chess_sit',
    cli: [{ verb: 'chess sit', pos: ['color'] }],
    toCommand: (a, ctx) => ({ id: onBoard(a, ctx).id, color: COLORS[a.color], leave: a.leave }),
    result: game,
    text,
  }),
  newgame: command({
    description: 'Start a new game by the rules: the board’s pieces go back to the start (or a new set appears if there is no board). Seats are kept.',
    args: z.strictObject({ board: board_, x: z.optional(z.number()), y: z.optional(z.number()) }),
    example: {},
    tool: 'chess_new_game',
    cli: [{ verb: 'chess new' }],
    toCommand: (a, ctx) => {
      let id = a.board;
      if (!id)
        try {
          id = findBoard(ctx.doc, undefined, ctx.actor).id;
        } catch {
          return { x: a.x ?? 0, y: a.y ?? 0 };
        }
      return { id };
    },
    result: (r, a, ctx) => gameView(ctx.doc, onBoard({ board: a.board ?? r.select?.[0] }, ctx), ctx.actor),
    text,
  }),
  takeback: command({
    description: 'Take back your last move and the reply to it (plain undo is off in a rules game). Returns the game.',
    args: z.strictObject({ board: board_ }),
    example: {},
    tool: 'chess_takeback',
    cli: [{ verb: 'chess takeback' }],
    toCommand: (a, ctx) => ({ id: onBoard(a, ctx).id }),
    result: game,
    text,
  }),
  resign: command({
    description: 'Resign the game for your color.',
    args: z.strictObject({ board: board_ }),
    example: {},
    tool: 'chess_resign',
    cli: [{ verb: 'chess resign' }],
    toCommand: (a, ctx) => ({ id: onBoard(a, ctx).id }),
    result: game,
    text,
  }),
};

const GUIDE = `Sit first, then loop wait -> move.
1. chess.newgame starts a game by the rules (a new board if there is none). A board without rules is free play: pieces move anywhere.
2. chess.sit {color} takes white or black; only the seated player moves that color, one color per player.
3. chess.state (canvas_look) shows the game: picture (white at the bottom), seats, your color, history, legal moves, FEN.
4. chess.turn (canvas_wait) returns once it is your move or the game ended; call it again after a timeout.
5. chess.move {move} plays SAN (Nf3, exd5, O-O, e8=Q) or UCI (e2e4). Illegal or out of turn is refused with the reason and the legal moves.
6. Plain undo is off in a rules game: chess.takeback undoes your last move and the reply.
With several chessboards pass board (an id) on every call.`;

/**
 * The data side of the plugin (commands, riders, import/export, rules mode). No DOM: the browser
 * plugin, tests and the Node bridge all register this, so an agent's move is the command a drag runs.
 */
export function registerChessLogic(store: Store) {
  for (const [name, cmd] of Object.entries({ ...commands, ...gameCommands })) store.register(`chess.${name}`, cmd as Command, specs[name]);
  store.registerView(
    'chess.state',
    view({
      description: 'The game: picture (uppercase = white, white at the bottom), whose move, seats, your color, move history, legal moves (SAN) and FEN.',
      args: z.strictObject({ board: board_ }),
      example: {},
      tool: 'chess_state',
      cli: [{ verb: 'chess state' }, { verb: 'chess' }],
      read: (doc, a, actor) => gameView(doc, findBoard(doc, a.board, actor), actor),
      text,
    }),
  );
  store.registerView(
    'chess.turn',
    view({
      description: 'The game, once it is your move or the game ended (nothing before). Wait on it with canvas_wait.',
      args: z.strictObject({ board: board_ }),
      example: {},
      wait: true,
      waiting: 'still waiting for the opponent; wait again',
      tool: 'chess_wait_for_turn',
      cli: [{ verb: 'chess wait' }],
      read: (doc, a, actor) => {
        const v = gameView(doc, findBoard(doc, a.board, actor), actor);
        return v.yourTurn || v.result ? v : undefined;
      },
      text,
    }),
  );
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

export const logic: PluginLogic = { id: 'chess', title: 'Chess', summary: 'Play chess as a seat: sit, move by notation, wait for your turn.', guide: GUIDE, register: registerChessLogic };
