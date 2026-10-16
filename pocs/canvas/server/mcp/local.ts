import { boardApi } from '../core/api';
import type { Board } from '../core/board';
import type { Send } from '../../bridge/client';

/**
 * The bridge client's `send` for a board in this process: the same API as over HTTP (same checks and
 * errors), without the hop. `signal` cancels a long wait; a call made after it aborted fails at once
 * (a loop that re-waits would otherwise spin).
 */
export function localSend(board: Board, signal: AbortSignal): Send {
  return async (path, init) => {
    if (signal.aborted) throw new Error('cancelled');
    const url = new URL(path, 'http://local');
    const body = init?.body ?? {};
    const reply = await boardApi(board, { method: init ? 'POST' : 'GET', path: url.pathname, query: url.searchParams, headers: {}, body: async () => body, signal });
    return reply.raw ?? JSON.stringify(reply.json);
  };
}
