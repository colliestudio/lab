import type { CanvasNode, CarrierOf } from '../../core';

// Event storming: stickies on a timeline board. A board is a `group` node with
// `x-storm: { kind: 'board', ... }`; a sticky is a `text` node (its text = the sticky's words, so a
// plain JSON Canvas viewer still reads it) with `x-storm: { kind: 'sticky', st: <sticky type> }`.
// Stickies ride the board under their center (geometry, like a mat's pieces); a non-event sticky
// can be attached to an event (`on`: the event's id) and then rides that event instead, so moving
// or reordering an event takes its command, policy... along.

export const FIELD = 'x-storm';

export type StickyKind = 'event' | 'command' | 'actor' | 'aggregate' | 'policy' | 'read' | 'external' | 'hotspot';
export type Phase = 'explore' | 'timeline' | 'process' | 'aggregates';

export interface KindInfo {
  name: string;
  /** Plural for exports and menus. */
  plural: string;
  color: string;
  w: number;
  h: number;
  /** Key that makes one. */
  key: string;
  /** Attached to an event: stacks above or below it. */
  side: 'above' | 'below';
  /** First phase that offers it. */
  from: Phase;
}

export const KINDS: Record<StickyKind, KindInfo> = {
  event: { name: 'Domain event', plural: 'Domain events', color: '#ffa94d', w: 160, h: 110, key: 'e', side: 'above', from: 'explore' },
  hotspot: { name: 'Hotspot', plural: 'Hotspots', color: '#ff6b6b', w: 140, h: 100, key: 'q', side: 'below', from: 'explore' },
  command: { name: 'Command', plural: 'Commands', color: '#74c0fc', w: 160, h: 110, key: 'c', side: 'above', from: 'process' },
  actor: { name: 'Actor', plural: 'Actors', color: '#ffec99', w: 110, h: 80, key: 'a', side: 'above', from: 'process' },
  policy: { name: 'Policy', plural: 'Policies', color: '#d0bfff', w: 160, h: 110, key: 'p', side: 'below', from: 'process' },
  read: { name: 'Read model', plural: 'Read models', color: '#8ce99a', w: 160, h: 110, key: 'r', side: 'below', from: 'process' },
  external: { name: 'External system', plural: 'External systems', color: '#fcc2d7', w: 160, h: 110, key: 'x', side: 'below', from: 'process' },
  aggregate: { name: 'Aggregate', plural: 'Aggregates', color: '#ffd43b', w: 160, h: 160, key: 'g', side: 'above', from: 'aggregates' },
};
export const KIND_ORDER: StickyKind[] = ['event', 'hotspot', 'command', 'actor', 'policy', 'read', 'external', 'aggregate'];
export const isKind = (v: unknown): v is StickyKind => typeof v === 'string' && v in KINDS;

export const PHASES: Phase[] = ['explore', 'timeline', 'process', 'aggregates'];
export const PHASE_INFO: Record<Phase, { name: string; hint: string }> = {
  explore: { name: '1 Chaotic exploration', hint: 'Everyone drops domain events anywhere (past tense). Hotspots for questions.' },
  timeline: { name: '2 Enforce the timeline', hint: 'Events snap into one left→right sequence. Drag an event to reorder.' },
  process: { name: '3 Commands & policies', hint: 'Add what triggers each event (command, actor) and what follows (policy, read model, external system).' },
  aggregates: { name: '4 Aggregates', hint: 'Group commands and events around the aggregates that own them.' },
};
export const isPhase = (v: unknown): v is Phase => typeof v === 'string' && (PHASES as string[]).includes(v);
/** Sticky kinds a phase offers (earlier phases' kinds stay). */
export const offered = (p: Phase): StickyKind[] => KIND_ORDER.filter((k) => PHASES.indexOf(KINDS[k].from) <= PHASES.indexOf(p));
/** Does this phase lay events out as one sequence? */
export const enforcesTimeline = (p: Phase) => p !== 'explore';

export interface Author {
  id: string;
  name: string;
  color: string;
}
export interface StickyField {
  kind: 'sticky';
  st: StickyKind;
  /** The event it belongs to (rides it). */
  on?: string;
  /** Who put it on the board. */
  by?: Author;
  /** Votes are flat keys `v_<player id>` = count (concurrent votes by two players both survive). */
  [vote: `v_${string}`]: number;
}
export interface Timer {
  /** Timebox length, ms. */
  base: number;
  /** Time left as of `since` (running) or the last pause. */
  left: number;
  /** Start of the running stretch (the starting device's clock); unset = paused/stopped. */
  since?: number;
}
export interface BoardField {
  kind: 'board';
  phase: Phase;
  /** Swimlane names, top to bottom. */
  lanes: string[];
  /** Votes each person may cast on this board. */
  dots: number;
  timer: Timer;
}

// ---------------------------------------------------------------- geometry
export const PAD = 40;
/** Header band: phase switch, palette, timer. */
export const HEAD = 84;
/** One sticky row (tallest regular sticky + gap). */
export const ROW = 128;
/** A lane: two rows above the event row, the event row, two rows below. */
export const LANE_H = 5 * ROW;
/** Horizontal step between events on the timeline. */
export const COL = 200;
export const MIN_W = 1200;

const sf = (n: CanvasNode | undefined) => n?.[FIELD] as Record<string, unknown> | undefined;
export const isBoard = (n: CanvasNode | undefined): boolean => sf(n)?.kind === 'board';
export const isSticky = (n: CanvasNode | undefined): boolean => sf(n)?.kind === 'sticky' && isKind(sf(n)?.st);
export const isStorm = (n: CanvasNode | undefined) => isBoard(n) || isSticky(n);
export const board = (n: CanvasNode) => n[FIELD] as BoardField;
export const sticky = (n: CanvasNode) => n[FIELD] as StickyField;
export const kindOf = (n: CanvasNode) => sticky(n).st;
export const isEvent = (n: CanvasNode | undefined) => isSticky(n) && kindOf(n!) === 'event';
export const phaseOf = (b: CanvasNode): Phase => (isPhase(board(b).phase) ? board(b).phase : 'explore');
export const lanesOf = (b: CanvasNode): string[] => (Array.isArray(board(b).lanes) && board(b).lanes.length ? board(b).lanes : ['Timeline']);

export const boardHeight = (lanes: number) => HEAD + lanes * LANE_H + PAD / 2;
/** Top of lane `i` (world). */
export const laneTop = (b: CanvasNode, i: number) => b.y + HEAD + i * LANE_H;
/** Lane index at world y (clamped). */
export function laneAt(b: CanvasNode, y: number): number {
  const n = lanesOf(b).length;
  return Math.max(0, Math.min(n - 1, Math.floor((y - b.y - HEAD) / LANE_H)));
}
/** Top y of an event in lane `i` (middle row). */
export const eventY = (b: CanvasNode, i: number) => laneTop(b, i) + 2 * ROW + (ROW - KINDS.event.h) / 2;
/** Left x of timeline slot `i`. */
export const slotX = (b: CanvasNode, i: number) => b.x + PAD + i * COL;

export const center = (n: CanvasNode) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });
const inside = (p: { x: number; y: number }, b: CanvasNode) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;

/** Topmost board whose box holds `n`'s center (and lies below it). */
export function boardUnder(n: CanvasNode, all: readonly CanvasNode[]): CanvasNode | undefined {
  const c = center(n);
  const z = n.z ?? 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const b = all[i];
    if (b.id !== n.id && isBoard(b) && (b.z ?? 0) < z && inside(c, b)) return b;
  }
}

/** Rider rule: an attached sticky rides its event; other stickies the board under their center. */
export const stormCarrierOf: CarrierOf = (n, get, all) => {
  if (!isSticky(n)) return;
  const on = sticky(n).on;
  if (on && isEvent(get(on))) return on;
  return boardUnder(n, all)?.id;
};

/** Votes on a sticky: player id → count. */
export function votesOf(n: CanvasNode): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(n[FIELD] as object)) if (k.startsWith('v_') && typeof v === 'number' && v > 0) out[k.slice(2)] = v;
  return out;
}
export const voteTotal = (n: CanvasNode) => Object.values(votesOf(n)).reduce((a, b) => a + b, 0);

export function boardNode(id: string, x: number, y: number, z: number, o: { label?: string; lanes?: string[] } = {}): CanvasNode {
  const lanes = o.lanes?.length ? o.lanes : ['Timeline'];
  const f: BoardField = { kind: 'board', phase: 'explore', lanes, dots: 3, timer: { base: 10 * 60_000, left: 10 * 60_000 } };
  return { id, type: 'group', x: Math.round(x), y: Math.round(y), width: MIN_W, height: boardHeight(lanes.length), z, label: o.label ?? 'Event storm', [FIELD]: f };
}

export function stickyNode(id: string, kind: StickyKind, x: number, y: number, z: number, o: { text?: string; on?: string; by?: Author } = {}): CanvasNode {
  const k = KINDS[kind];
  const f: StickyField = { kind: 'sticky', st: kind };
  if (o.on) f.on = o.on;
  if (o.by) f.by = o.by;
  return { id, type: 'text', x: Math.round(x), y: Math.round(y), width: k.w, height: k.h, z, text: o.text ?? '', color: k.color, [FIELD]: f };
}

/** Time left on a board's timer at `now`. */
export function timerLeft(t: Timer, now: number): number {
  return Math.max(0, typeof t.since === 'number' ? t.left - Math.max(0, now - t.since) : t.left);
}
