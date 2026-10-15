import type { CanvasNode, Command, Store } from '../../core';
import type { PluginLogic } from '../logic';
import { commands } from './commands';
import { frameAt, memberships } from './model';

/**
 * Membership rule state: while a pointer is down the frame of every node is frozen at what it was
 * at the press, so a frame dragged over other objects doesn't scoop them up on the way (geometry
 * decides again on release).
 */
let frozen: Map<string, string> | null = null;
/** Freeze frame membership as it is in `nodes` (until `thaw`). */
export function freezeMembership(nodes: readonly CanvasNode[]) {
  frozen = memberships(nodes);
}
/** Back to geometry; true if it was frozen (the caller should invalidate its store). */
export function thawMembership(): boolean {
  const was = frozen !== null;
  frozen = null;
  return was;
}

/** The data side (commands, rider rule). No DOM; used by the browser, the bridge and tests. */
export function registerFramesLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`frames.${name}`, cmd as Command);
  // Registered after other plugins' rider rules (a piece rides its board, the board rides the frame).
  store.addRiderRule((n, get, all) => {
    if (!frozen) return frameAt(n, all);
    const f = frozen.get(n.id);
    return f && get(f) ? f : undefined;
  });
}

export const logic: PluginLogic = { id: 'frames', register: registerFramesLogic };
