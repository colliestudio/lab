import type { CliExtra } from '../core/agent';
import { syncBacklog } from './board/cli';
import { chessBot } from './chess/bot';

/**
 * Command line verbs plugins add beyond calling their commands. Node-only (they read files or run
 * loops); only bridge/cli.ts imports this.
 */
export const PLUGIN_CLI: readonly CliExtra[] = [syncBacklog, chessBot];
