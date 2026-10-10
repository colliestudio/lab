import { isNum, set, type CanvasNode, type Change, type Command, type CommandResult, type DocView, type EventSpec } from '../../core';
import { FIELD, H, W, baseOf, clock, clockNode, controlText, incOf, isClock, isSide, nameOf, other, remaining, ticking, type ClockField, type Rot, type Side } from './model';

// Pure commands. Time comes in as `now` (the caller's clock), so they stay replayable and testable.
// The app dispatches tap/pause/resume/flag/reset/control as not undoable: time doesn't go back.

const F = (k: string) => `${FIELD}.${k}`;
const clockArg = (doc: DocView, id: unknown) => {
  const n = typeof id === 'string' ? doc.get(id) : undefined;
  return n && isClock(n) ? n : undefined;
};
/** Changes plus a log entry about clock `n` (only if something changed). Taps aren't logged: only start, pause, resume, flag fall, reset, time control. */
const logged = (n: CanvasNode, changes: Change[], text: string, extra: Partial<EventSpec> = {}): CommandResult =>
  changes.length ? { changes, events: [{ type: 'clock', text, targets: [n.id], ...extra }] } : { changes };
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
  // first spot clear of other objects, sliding right
  let x = Math.round(a.x - W / 2);
  const y = Math.round(a.y - H / 2);
  const gap = 40;
  const clash = (x: number) => doc.visible.some((n) => n.x < x + W + gap && n.x + n.width + gap > x && n.y < y + H + gap && n.y + n.height + gap > y);
  for (let i = 0; i < 60 && clash(x); i++) x += 60;
  return [{ op: 'add', node: clockNode(ctx.newId(), x, y, base, inc, doc.topZ + 1) }];
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
  if (c.run === undefined) return logged(n, diff(n, { run: other(a.side), since: a.now }), `started the clock (${nameOf(c, other(a.side))} to move)`);
  if (c.run !== a.side) return [];
  const left = remaining(c, a.side, a.now);
  if (left <= 0) return logged(n, diff(n, { [a.side === 0 ? 'left0' : 'left1']: 0, flag: a.side, since: undefined }), `${nameOf(c, a.side)}’s time ran out`, { actor: null, key: `flag:${n.id}`, cue: 'pulse' });
  return [set(n.id, leftKey(a.side), left + incOf(c, a.side)), ...diff(n, { run: other(a.side), since: a.now })];
};

/** Stop the running side's time (keeps whose turn it is). */
export const pause: Command<{ id: string; now: number }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n || !isNum(a.now)) return [];
  const c = clock(n);
  if (c.run === undefined || !ticking(c, c.run)) return [];
  return logged(n, [set(n.id, leftKey(c.run), remaining(c, c.run, a.now)), set(n.id, F('paused'), true), set(n.id, F('since'), undefined)], 'paused the clock');
};

export const resume: Command<{ id: string; now: number }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n || !isNum(a.now)) return [];
  const c = clock(n);
  if (!c.paused || c.flag !== undefined) return [];
  return logged(n, [set(n.id, F('paused'), undefined), set(n.id, F('since'), a.now)], 'resumed the clock');
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
  return logged(n, [set(n.id, leftKey(c.run), 0), set(n.id, F('flag'), c.run), set(n.id, F('since'), undefined)], `${nameOf(c, c.run)}’s time ran out`, {
    actor: null,
    key: `flag:${n.id}`,
    cue: 'pulse',
  });
};

/** Each side back to its own starting time, nobody running. */
const fresh = (c: ClockField): Partial<ClockField> => ({ left0: baseOf(c, 0), left1: baseOf(c, 1), run: undefined, since: undefined, paused: undefined, flag: undefined });

/** Both sides back to the time control, nobody running. */
export const reset: Command<{ id: string }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  return n ? logged(n, diff(n, fresh(clock(n))), 'reset the clock') : [];
};

const okBase = (v: unknown): v is number => isNum(v) && v > 0 && v <= 24 * 3600_000;
const okInc = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 3600_000;

/**
 * New time control (ms), then reset. `base`/`inc` for both sides, or with `base1`/`inc1` a different
 * control for side 1 (handicap). Without them both sides share `base`/`inc`.
 */
export const control: Command<{ id: string; base: number; inc: number; base1?: number; inc1?: number }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n || !okBase(a.base) || !okInc(a.inc)) return [];
  const split = a.base1 !== undefined || a.inc1 !== undefined;
  if (split && (!okBase(a.base1) || !okInc(a.inc1))) return [];
  const next: ClockField = { ...clock(n), base: Math.round(a.base), inc: Math.round(a.inc), base1: undefined, inc1: undefined };
  if (split && (Math.round(a.base1!) !== next.base || Math.round(a.inc1!) !== next.inc)) {
    next.base1 = Math.round(a.base1!);
    next.inc1 = Math.round(a.inc1!);
  }
  return logged(n, diff(n, { base: next.base, inc: next.inc, base1: next.base1, inc1: next.inc1, ...fresh(next) }), `set the clock to ${controlText(next)}`);
};

/**
 * Turn the clock a quarter (clockwise): 0 → 90 → 180 → 270. At 90/270 the box turns tall (keeping
 * its center) and the halves stack; the text stays upright (see `facing`).
 */
export const rotate: Command<{ id: string }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n) return [];
  const rot = (((clock(n).rot ?? 0) + 90) % 360) as 0 | Rot;
  const tall = rot === 90 || rot === 270;
  const [w, h] = tall ? [H, W] : [W, H];
  const changes = [set(n.id, F('rot'), rot || undefined)];
  if (w !== n.width) {
    changes.push(set(n.id, 'width', w), set(n.id, 'height', h));
    changes.push(set(n.id, 'x', Math.round(n.x + (n.width - w) / 2)), set(n.id, 'y', Math.round(n.y + (n.height - h) / 2)));
  }
  return changes;
};

/** Turned tall: the top half's text upside down (facing the far player) or upright (default). */
export const facing: Command<{ id: string; on: boolean }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n || typeof a.on !== 'boolean') return [];
  return diff(n, { facing: a.on || undefined });
};

/** Side names ("" = default White/Black). */
export const names: Command<{ id: string; name0?: string; name1?: string }> = (doc, a) => {
  const n = clockArg(doc, a?.id);
  if (!n) return [];
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 24) : undefined);
  return diff(n, { name0: clean(a.name0), name1: clean(a.name1) });
};

/**
 * Reset table (core `resets`): every clock back to its time control. Not undone with the table
 * reset (`untracked`): time doesn't go back, and an undo would restart a clock from a stale start time.
 */
export const resetAll: Command<Record<string, never>> = (doc) => ({ changes: [], untracked: doc.nodes.filter(isClock).flatMap((n) => diff(n, fresh(clock(n)))) });

export const commands = { create, tap, pause, resume, flag, reset, control, rotate, facing, names, resetAll };
