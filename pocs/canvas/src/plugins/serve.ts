import type { ServeExtra } from '../core/serveExtra';
import { kanbanServe } from './kanban/node/serve';

/**
 * What plugins add to `canvas serve`: flags, a say in /api/info, work attached to each loaded board.
 * Node-only (they read folders); only server/serve.ts imports this.
 */
export const PLUGIN_SERVE: readonly ServeExtra[] = [kanbanServe];
