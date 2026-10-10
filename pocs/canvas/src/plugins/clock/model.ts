import type { CanvasNode } from '../../core';

// Game clock data, synced as per-field state in `x-clock`. Nothing ticks in the document: it stores
// each side's time left as of the last switch plus `since` (the tapping device's clock, ms epoch)
// for the running side, and every client computes the display from that. Clock skew between devices
// shows up as a display offset on the other device (fine for a POC; a server could be the time source).

export const FIELD = 'x-clock';
export const W = 360;
export const H = 150;

export type Side = 0 | 1;
export interface ClockField {
  kind: 'clock';
  /** Time control: starting time and increment per move, ms. */
  base: number;
  inc: number;
  /** Time left per side as of `since` (running side) or the last switch. */
  left0: number;
  left1: number;
  /** Side whose time is running; unset before the first tap. */
  run?: Side;
  /** When the running side's time started (tapping device's clock); unset while paused/stopped. */
  since?: number;
  paused?: true;
  /** Side that ran out of time (stops the clock). */
  flag?: Side;
  name0?: string;
  name1?: string;
}

export const PRESETS: [label: string, minutes: number, incSeconds: number][] = [
  ['1+0 bullet', 1, 0],
  ['3+2 blitz', 3, 2],
  ['5+0 blitz', 5, 0],
  ['10+0 rapid', 10, 0],
  ['15+10 rapid', 15, 10],
];

const field = (n: CanvasNode) => n[FIELD] as Record<string, unknown> | undefined;
export const isClock = (n: CanvasNode | undefined): boolean => !!n && field(n)?.kind === 'clock';
export const clock = (n: CanvasNode) => n[FIELD] as ClockField;
export const other = (s: Side): Side => (s === 0 ? 1 : 0);
export const leftOf = (c: ClockField, s: Side) => (s === 0 ? c.left0 : c.left1);
export const nameOf = (c: ClockField, s: Side) => (s === 0 ? c.name0 : c.name1) || (s === 0 ? 'White' : 'Black');
export const isSide = (v: unknown): v is Side => v === 0 || v === 1;

/** Is side `s`'s time running right now? */
export const ticking = (c: ClockField, s: Side) => c.run === s && !c.paused && c.flag === undefined && typeof c.since === 'number';

/** Time left for side `s` at `now` (never below 0). */
export function remaining(c: ClockField, s: Side, now: number): number {
  const l = leftOf(c, s);
  return Math.max(0, ticking(c, s) ? l - Math.max(0, now - c.since!) : l);
}

/** 1:05:00, 4:59, 0:20, then tenths under 20 s: 19.4 */
export function fmt(ms: number): string {
  const t = Math.max(0, ms);
  if (t < 20_000) return (Math.floor(t / 100) / 10).toFixed(1);
  const s = Math.ceil(t / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function clockNode(id: string, x: number, y: number, base: number, inc: number, z?: number): CanvasNode {
  const f: ClockField = { kind: 'clock', base, inc, left0: base, left1: base };
  return { id, type: 'text', x, y, width: W, height: H, text: clockText(f), z, [FIELD]: f };
}

/** Readable text for JSON Canvas exports. */
export const clockText = (c: ClockField) =>
  `Game clock ${Math.round(c.base / 60000)}+${Math.round(c.inc / 1000)}: ${nameOf(c, 0)} ${fmt(c.left0)} / ${nameOf(c, 1)} ${fmt(c.left1)}`;
