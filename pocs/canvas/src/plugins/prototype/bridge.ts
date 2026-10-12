// The messages a page frame may send to the canvas. The frame itself (separate sandbox origin, CSP
// headers, navigation guard, the bridge script inside it) lives in src/sandbox/page.ts; this
// module validates what comes back. Anything that isn't one of these four messages is dropped.

import { TAG } from '../../sandbox/page';

export { pageFrame, fromFrame } from '../../sandbox/page';
export { TAG };

export type PageMessage =
  | { kind: 'goto'; target: string }
  | { kind: 'back' }
  /** Escape pressed inside the page (keys in a frame never reach the canvas): leave Play / Interact. */
  | { kind: 'escape' }
  | { kind: 'set'; key: string; value: string };

/** Validate a message from a page frame (anything else: undefined). */
export function readMessage(data: unknown): PageMessage | undefined {
  if (!data || typeof data !== 'object') return;
  const d = data as Record<string, unknown>;
  if (d.tag !== TAG) return;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
  if (d.kind === 'goto') {
    const target = str(d.target ?? '', 200);
    return target === undefined ? undefined : { kind: 'goto', target };
  }
  if (d.kind === 'back') return { kind: 'back' };
  if (d.kind === 'escape') return { kind: 'escape' };
  if (d.kind === 'set') {
    const key = str(d.key, 60);
    const value = str(d.value, 2000);
    return key && value !== undefined ? { kind: 'set', key, value } : undefined;
  }
}
