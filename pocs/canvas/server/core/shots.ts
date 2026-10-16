import { resolveNode } from '../../src/core/query';
import type { ShotTarget, InView } from '../../src/core/agentView';
import type { Actor } from './host';

export type { ShotTarget, InView };

// Screenshots of a board as a seat sees it. The core only knows this interface and the argument
// rules; a provider (server/node/shots.ts: headless Chrome; later the desktop app) takes the picture.

export interface ShotRequest {
  target: ShotTarget;
  width: number;
  height: number;
  padding: number;
  labels: boolean;
  /** base64 of the board's Y state vector: the picture must include at least that much. */
  stateVector: string;
}

export interface Shot {
  png: Uint8Array;
  width: number;
  height: number;
  /** How long the shot took. */
  ms: number;
  /** The nodes in view, with their screen boxes. */
  nodes: InView[];
}

export interface ShotProvider {
  shoot(board: string, actor: Actor, r: ShotRequest): Promise<Shot>;
  /** Close the pages held for a board (before it unloads, renames or is deleted); resolves to how many it closed. */
  drop(board: string): Promise<number>;
  close(): Promise<void>;
}

/** A shot that can't be taken; `status` is the HTTP code (503: nothing to shoot with here, 400: the request). */
export class ShotError extends Error {
  constructor(
    readonly status: 400 | 503,
    msg: string,
  ) {
    super(msg);
    this.name = 'ShotError';
  }
}

export const SHOT_DEFAULTS = { width: 1000, height: 750, padding: 40 };
const MIN_SIZE = 200;
const MAX_SIZE = 2000;

function num(v: unknown, what: string): number {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ShotError(400, `${what} must be a number`);
  return n;
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Validate the tool arguments (node, region, labels, width, height, padding) into a request; a node given as a title resolves to its id. */
export function parseShotArgs(args: Record<string, unknown>, doc: { nodes: { id: string; type?: string }[] }): Omit<ShotRequest, 'stateVector'> {
  if (args.node !== undefined && args.region !== undefined) throw new ShotError(400, 'give a node or a region, not both');
  let target: ShotTarget = { kind: 'board' };
  if (args.node !== undefined) {
    try {
      target = { kind: 'node', id: resolveNode(doc as Parameters<typeof resolveNode>[0], String(args.node)).id };
    } catch (e) {
      throw new ShotError(400, (e as Error).message);
    }
  } else if (args.region !== undefined) {
    const r = args.region as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') throw new ShotError(400, 'region must be {x, y, width, height} in board coordinates');
    const box = { x: num(r.x, 'region.x'), y: num(r.y, 'region.y'), width: num(r.width, 'region.width'), height: num(r.height, 'region.height') };
    if (box.width <= 0 || box.height <= 0) throw new ShotError(400, 'region width and height must be above 0');
    target = { kind: 'region', ...box };
  }
  const size = (v: unknown, dflt: number, what: string) => (v === undefined ? dflt : Math.round(clamp(num(v, what), MIN_SIZE, MAX_SIZE)));
  return {
    target,
    width: size(args.width, SHOT_DEFAULTS.width, 'width'),
    height: size(args.height, SHOT_DEFAULTS.height, 'height'),
    padding: args.padding === undefined ? SHOT_DEFAULTS.padding : clamp(num(args.padding, 'padding'), 0, 400),
    labels: args.labels === true || args.labels === 'true' || args.labels === 1,
  };
}

export const describeTarget = (t: ShotTarget) => (t.kind === 'board' ? 'whole board' : t.kind === 'node' ? `node ${t.id}` : `region ${t.x},${t.y} ${t.width}x${t.height}`);
