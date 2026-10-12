import type { DocView } from '../src/core/doc';
import type { LogActor } from '../src/core/log';
import { findBoard, gameView } from '../src/plugins/chess/game';

// Views: what an agent reads instead of raw nodes. A view is a pure function of the doc, the args and
// who asks (a game view differs per seat; with hidden information, e.g. a hand of cards, it must).
// A view that returns undefined means "not yet": the bridge's /wait long-polls on it (turn loops).
// Today they're registered here per plugin; the plugin API could carry them (`registerView`).

export type View = (doc: DocView, args: Record<string, string | undefined>, actor: LogActor) => unknown;

export const views: Record<string, View> = {
  /** The game on a board (default: the only board, or the one you sit at): FEN, picture, turn, seats, legal moves. */
  'chess.state': (doc, a, actor) => gameView(doc, findBoard(doc, a.board, actor), actor),
  /** Same, but only once it's your move or the game is over (for /wait). */
  'chess.turn': (doc, a, actor) => {
    const v = gameView(doc, findBoard(doc, a.board, actor), actor);
    return v.yourTurn || v.result ? v : undefined;
  },
};
