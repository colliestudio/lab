import { chatText, type ChatMessage } from '../src/core/chat';
import type { Client } from './client';

// What the CLI adds for a canvas serve: --canvas NAME picks a board of the service, and
// `chat wait --follow` keeps printing what others say (for a Monitor or a terminal).

export const DEFAULT_SERVE = 'http://localhost:5310';

/** Where the CLI talks: a board of the service (`--canvas`), else the bridge as before (undefined = the client's default). */
export function apiBase(o: { bridge?: string; board?: string }, env: Record<string, string | undefined> = process.env): string | undefined {
  if (o.board === undefined) return o.bridge;
  if (!o.board || o.board === 'true') throw new Error('--canvas needs a canvas name'); // a bare flag parses as "true"
  return `${(o.bridge ?? env.CANVAS_SERVE ?? DEFAULT_SERVE).replace(/\/+$/, '')}/api/boards/${encodeURIComponent(o.board)}`;
}

export interface FollowOptions {
  /** Seconds per wait request (a long poll is cut off by proxies; the loop goes on). */
  sliceS?: number;
  /** Failures in a row (service down, board gone) before giving up. */
  maxFailures?: number;
  /** Waits between retries, in ms: the n-th failure waits backoff[n-1] (the last one repeats). */
  backoff?: number[];
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Called when a wait failed (before the retry or giving up). */
  warn?: (message: string) => void;
}

/**
 * Print each batch of new messages as it arrives; a timeout just waits again. Ends (throws) after
 * `maxFailures` waits in a row failed, or returns when `signal` aborts.
 */
export async function followChat(c: Pick<Client, 'chatWait' | 'doc'>, print: (text: string) => void, o: FollowOptions = {}): Promise<void> {
  const { sliceS = 290, maxFailures = 3, backoff = [1000, 2000], signal } = o;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let failures = 0;
  while (!signal?.aborted) {
    let msgs: ChatMessage[];
    try {
      msgs = await c.chatWait(sliceS);
      failures = 0;
    } catch (e) {
      failures++;
      o.warn?.(`${(e as Error).message} (${failures}/${maxFailures})`);
      if (failures >= maxFailures) throw new Error(`gave up after ${failures} failed waits: ${(e as Error).message}`);
      await sleep(backoff[Math.min(failures, backoff.length) - 1]);
      continue;
    }
    if (msgs.length) print(chatText(msgs, await c.doc().catch(() => ({ nodes: [] }))));
  }
}
