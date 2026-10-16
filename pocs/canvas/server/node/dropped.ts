import type { ServerResponse } from 'node:http';

/** Aborts when the client's connection closes before the response was finished (a long wait must not eat a message nobody receives). */
export function droppedSignal(res: ServerResponse): AbortSignal {
  const ac = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac.signal;
}
