import { isNum, set, type CanvasNode, type Change, type Command, type DocView } from '../../core';
import { FIELD, H, W, clock, clockNode, isClock, isSide, other, remaining, ticking, type ClockField, type Side } from './model';

// Pure commands. Time comes in as `now` (the caller's clock), so they stay replayable and testable.
// The app dispatches tap/pause/resume/flag/reset/control as not undoable: time doesn't go back.

const F = (k: string) => `${FIELD}.${k}`;
const clockArg = (doc: DocView, id: unknown) => {
  const n = typeof id === 'string' ? doc.get(id) : undefined;
  return n && isClock(n) ? n : undefined;
};
const leftKey = (s: Side) => F(s === 0 ? 'left0' : 'left1');

/** Field changes from `c` to `next` (only what differs; undefined deletes). */
function diff(n: CanvasNode, next: Partial<ClockField>): Change[] {
  const c = clock(n) as unknown as Record<string, unknown>;
  return Object.entries(next)
    .filter(([k, v]) => c[k] !== v)
    .map(([k, v]) => set(n.id, F(k), v));
}

export const create: Command<{ x: number; y: number; base?: number; inc?: number }> = (doc, a, ctx) => {
  if (!isNum(a?.x) || !isNum(a?.y)) return [];
  const base = isNum(a.base) && a.base > 0 ? a.base : 5 * 60_000;
  const inc = isNum(a.inc) && a.inc >= 0 ? a.inc : 0;
  return [{ op: 'add', node: clockNode(ctx.newId(), Math.round(a.x - W / 2), Math.round(a.y - H / 2), base, inc, doc.topZ + 1) }];
};

/**
 * Side `side` ends its turn: its time stops (plus the increment) and the other side's starts.
 * Before the first tap, either side's tap starts the other side. Tapping the waiting side, a paused
 * or flagged clock does nothing. Out of time at the tap: flagged instead.
 */
export const tap: Command<{ id: string; side: Side; now: number }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n || !isSide(a.side) || !isNum(a.now)) return [];
  const c = clock(n);
  if (c.paused || c.flag !== undefined) return [];
  if (c.run === undefined) return diff(n, { run: other(a.side), since: a.now });
  if (c.run !== a.side) return [];
  const left = remaining(c, a.side, a.now);
  if (left <= 0) return diff(n, { [a.side === 0 ? 'left0' : 'left1']: 0, flag: a.side, since: undefined });
  return [set(n.id, leftKey(a.side), left + c.inc), ...diff(n, { run: other(a.side), since: a.now })];
};

/** Stop the running side's time (keeps whose turn it is). */
export const pause: Command<{ id: string; now: number }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n || !isNum(a.now)) return [];
  const c = clock(n);
  if (c.run === undefined || !ticking(c, c.run)) return [];
  return [set(n.id, leftKey(c.run), remaining(c, c.run, a.now)), set(n.id, F('paused'), true), set(n.id, F('since'), undefined)];
};

export const resume: Command<{ id: string; now: number }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n || !isNum(a.now)) return [];
  const c = clock(n);
  if (!c.paused || c.flag !== undefined) return [];
  return [set(n.id, F('paused'), undefined), set(n.id, F('since'), a.now)];
};

/**
 * The running side ran out of time (any client notices and sends this; it checks with its own `now`).
 * Idempotent: concurrent flags write the same values.
 */
export const flag: Command<{ id: string; now: number }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n || !isNum(a.now)) return [];
  const c = clock(n);
  if (c.run === undefined || !ticking(c, c.run) || remaining(c, c.run, a.now) > 0) return [];
  return [set(n.id, leftKey(c.run), 0), set(n.id, F('flag'), c.run), set(n.id, F('since'), undefined)];
};

const fresh = (c: Pick<ClockField, 'base'>): Partial<ClockField> => ({ left0: c.base, left1: c.base, run: undefined, since: undefined, paused: undefined, flag: undefined });

/** Both sides back to the time control, nobody running. */
export const reset: Command<{ id: string }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  return n ? diff(n, fresh(clock(n))) : [];
};

/** New time control (minutes + increment seconds, as ms), and reset. */
export const control: Command<{ id: string; base: number; inc: number }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n || !isNum(a.base) || a.base <= 0 || a.base > 24 * 3600_000 || !isNum(a.inc) || a.inc < 0 || a.inc > 3600_000) return [];
  return diff(n, { base: Math.round(a.base), inc: Math.round(a.inc), ...fresh({ base: Math.round(a.base) }) });
};

/** Side names ("" = default White/Black). */
export const names: Command<{ id: string; name0?: string; name1?: string }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n) return [];
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 24) : undefined);
  return diff(n, { name0: clean(a.name0), name1: clean(a.name1) });
};

/** Reset table (core `registerReset`): every clock back to its time control. */
export const resetAll: Command<Record<string, never>> = (doc) => doc.nodes.filter(isClock).flatMap((n) => diff(n, fresh(clock(n))));

export const commands = { create, tap, pause, resume, flag, reset, control, names, resetAll };
