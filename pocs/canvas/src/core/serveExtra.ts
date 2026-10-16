import type { Change, DocView } from './doc';
import type { EventSpec } from './log';

// How a plugin takes part in `canvas serve` beyond its commands: flags of its own, a say in GET /api/info,
// and work attached to every board the serve loads (the kanban plugin syncs a Backlog.md folder into the
// doc). The serve knows plugins only through this list (src/plugins/serve.ts), never by name. Node-only
// implementations live in the plugin's `node/` folder; this file is types only.

/** One loaded board as a serve extra sees it: the live doc, a way to change it as the extra, and its end of life. */
export interface ServeBoard {
  name: string;
  /** The live doc, current at each call. */
  doc(): DocView;
  /** Change the doc as the extra, not as a player: one transaction, not undoable by anyone, the events go to the log. */
  apply(changes: Change[], events: EventSpec[]): void;
  newId(): string;
  /** Runs after every doc change that `apply` did not make. Returns the stop function. */
  onDocChange(fn: () => void): () => void;
  /** Run when the board unloads (idle, rename, serve exit). */
  onClose(fn: () => void): void;
  log(msg: string): void;
}

export interface ServeInstance {
  /** More fields for GET /api/info (what a browser may learn about the serve). */
  info?(): Record<string, unknown>;
  /** A board was loaded: start whatever follows it. The returned function runs when it unloads. */
  attach?(board: ServeBoard): (() => void) | void;
  /** A line for the serve's start log. */
  describe?(): string | undefined;
}

export interface ServeExtra {
  id: string;
  /** Repeatable value flags the extra adds to `canvas serve`, without the dashes. */
  flags: { name: string; help: string }[];
  /** Called once at start. Throws an Error with a clear message for a bad configuration (the serve exits with it). */
  start(opts: { flags: Record<string, string[]>; env: Record<string, string | undefined> }): ServeInstance;
}
