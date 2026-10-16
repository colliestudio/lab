import { isIds, isNum, pick } from '../../core/commands';
import { set } from '../../core/doc';
import type { CanvasNode, Change, Command, CommandResult, DocView, EventSpec } from '../../core';
import {
  COL,
  FIELD,
  KINDS,
  MIN_W,
  PAD,
  PHASE_INFO,
  ROW,
  boardHeight,
  boardNode,
  center,
  enforcesTimeline,
  eventY,
  isBoard,
  isEvent,
  isKind,
  isPhase,
  isSticky,
  kindOf,
  laneAt,
  laneTop,
  lanesOf,
  offered,
  phaseOf,
  slotX,
  sticky,
  stickyNode,
  timerLeft,
  board as boardF,
  votesOf,
  type Author,
  type StickyKind,
} from './model';

// Pure commands (doc, args, ctx) -> changes. Positions on a board are stored (not a derived
// layout): the timeline is re-packed by commands (after a drop, a new sticky, a phase switch), so
// a .canvas file opened anywhere shows the same picture.

const S = (k: string) => `${FIELD}.${k}`;
const get = (doc: DocView, id: unknown) => (typeof id === 'string' ? doc.get(id) : undefined);
const boardArg = (doc: DocView, id: unknown) => {
  const b = get(doc, id);
  return b && isBoard(b) ? b : undefined;
};
const stickyArg = (doc: DocView, id: unknown) => {
  const n = get(doc, id);
  return n && isSticky(n) ? n : undefined;
};
const okText = (t: unknown) => (typeof t === 'string' ? t.replace(/\s+$/g, '').slice(0, 280) : undefined);
const okAuthor = (a: unknown): Author | undefined => {
  const o = a as Author | undefined;
  return o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.color === 'string' ? { id: o.id, name: o.name, color: o.color } : undefined;
};
/**
 * Who the log names for a sticky's first words: its author (`by`), so an agent that passes itself
 * as `by` is not logged as the local player. No `by` = the acting player.
 * Follow-up once commands carry the actor (CommandCtx.actor): use that instead of the argument.
 */
const logActor = (n: CanvasNode) => sticky(n).by ?? undefined;
const quote = (n: CanvasNode) => (n.text?.trim() ? `“${n.text.trim().split('\n')[0].slice(0, 40)}”` : 'an empty sticky');
const kindName = (k: StickyKind) => KINDS[k].name.toLowerCase();

/** The board a node sits on (an attached sticky: its event's board). */
export function boardOf(doc: DocView, n: CanvasNode | undefined): CanvasNode | undefined {
  for (let i = 0, cur = n; cur && i < 4; i++) {
    if (isBoard(cur)) return cur;
    const c = doc.carrierOf(cur.id);
    cur = c ? doc.get(c) : undefined;
  }
}
/** Every event storm board in the doc. */
export const boardsIn = (doc: DocView): CanvasNode[] => doc.nodes.filter(isBoard);
/** Events on a board, in timeline order (center x, then y). */
export function eventsOn(doc: DocView, boardId: string): CanvasNode[] {
  return byTime(doc.riders(boardId).filter(isEvent));
}
const byTime = (ns: CanvasNode[]) => ns.slice().sort((a, b) => center(a).x - center(b).x || center(a).y - center(b).y || (a.id < b.id ? -1 : 1));
/** Stickies attached to an event. */
export const attachedTo = (doc: DocView, eventId: string) => doc.riders(eventId).filter(isSticky);
/** Every sticky on a board (attached ones included). */
export function stickiesOn(doc: DocView, boardId: string): CanvasNode[] {
  const out: CanvasNode[] = [];
  for (const n of doc.riders(boardId)) {
    if (!isSticky(n)) continue;
    out.push(n);
    if (isEvent(n)) out.push(...attachedTo(doc, n.id));
  }
  return out;
}

/**
 * Where everything on a board goes: events in one left→right sequence (when the phase enforces the
 * timeline: slot by slot, each in the middle row of the lane it's in), attached stickies stacked in
 * rows above / below their event, centered on it. Returns position changes and the board's width.
 */
export function packPlan(b: CanvasNode, events: CanvasNode[], attached: (id: string) => CanvasNode[], enforce: boolean, loose: CanvasNode[] = []): Change[] {
  const out: Change[] = [];
  const move = (n: CanvasNode, x: number, y: number) => {
    x = Math.round(x);
    y = Math.round(y);
    if (n.x !== x) out.push(set(n.id, 'x', x));
    if (n.y !== y) out.push(set(n.id, 'y', y));
  };
  const evs = enforce ? byTime(events) : events;
  evs.forEach((ev, i) => {
    const [ex, ey] = enforce ? [slotX(b, i), eventY(b, laneAt(b, center(ev).y))] : [ev.x, ev.y];
    move(ev, ex, ey);
    const mine = attached(ev.id);
    for (const side of ['above', 'below'] as const) {
      const list = mine.filter((s) => KINDS[kindOf(s)].side === side);
      // keep their order: nearest to the event first
      list.sort((p, q) => (side === 'above' ? q.y - p.y : p.y - q.y) || (p.id < q.id ? -1 : 1));
      list.forEach((s, k) => {
        const x = ex + (ev.width - s.width) / 2;
        const y = side === 'above' ? ey - (k + 1) * ROW + (ev.height - s.height) : ey + (k + 1) * ROW;
        move(s, x, y);
      });
    }
  });
  if (enforce) {
    // loose stickies (a hotspot parked right of the last event) stay inside the board
    const w = Math.max(MIN_W, 2 * PAD + evs.length * COL, ...loose.map((n) => n.x + n.width + PAD - b.x));
    if (b.width !== w) out.push(set(b.id, 'width', w));
  }
  return out;
}

/** Stickies on a board that are neither events nor attached to one. */
const looseOn = (doc: DocView, b: CanvasNode) => doc.riders(b.id).filter((n) => isSticky(n) && !isEvent(n) && !sticky(n).on);

/** A width change that keeps `nodes` (at their final spots) inside the board, unless the pack already sets the width. */
const widenFor = (b: CanvasNode, nodes: CanvasNode[], pack: Change[]): Change[] => {
  const right = Math.max(...nodes.map((n) => n.x + n.width)) + PAD - b.x;
  return right > b.width && !pack.some((c) => c.op === 'set' && c.id === b.id && c.key === 'width') ? [set(b.id, 'width', Math.ceil(right))] : [];
};

/** Re-pack a board as it is now. */
export function packBoard(doc: DocView, b: CanvasNode, extra: { add?: CanvasNode } = {}): Change[] {
  const events = eventsOn(doc, b.id);
  const a = extra.add;
  if (a && isEvent(a)) events.push(a);
  const attached = (id: string) => {
    const l = attachedTo(doc, id);
    if (a && !isEvent(a) && sticky(a).on === id) l.push(a);
    return l;
  };
  const loose = looseOn(doc, b);
  if (a && !isEvent(a) && !sticky(a).on) loose.push(a);
  return packPlan(b, events, attached, enforcesTimeline(phaseOf(b)), loose);
}

/** Apply `changes` to a node list (for a plan that must see a new node's final spot). */
const placed = (n: CanvasNode, changes: Change[]): CanvasNode => {
  let out = n;
  for (const c of changes) if (c.op === 'set' && c.id === n.id && (c.key === 'x' || c.key === 'y')) out = { ...out, [c.key]: c.value as number };
  return out;
};

// ---------------------------------------------------------------- commands

/** A new board, top-left at (x, y) minus half its size (centered on the point). */
export const createBoard: Command<{ x: number; y: number; label?: string; lanes?: string[] }> = (doc, a, ctx) => {
  if (!isNum(a?.x) || !isNum(a?.y)) return [];
  const lanes = Array.isArray(a.lanes) ? a.lanes.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim().slice(0, 40)) : undefined;
  const n = boardNode(ctx.newId(), 0, 0, Math.floor(doc.topZ) + 1, { label: typeof a.label === 'string' ? a.label.slice(0, 60) : undefined, lanes });
  n.x = Math.round(a.x - n.width / 2);
  n.y = Math.round(a.y - n.height / 2);
  return { changes: [{ op: 'add', node: n }], select: [n.id], events: [{ type: 'storm.board', text: 'started an event storm', targets: [n.id] }] };
};

/**
 * A new sticky on `board`. Where: `after` (an event: the next slot on the timeline; another
 * sticky: the same row on the next event), `on` (attached to that event, stacked in its column),
 * else centered on (x, y). With none of these: an event goes at the end of the timeline, any other
 * kind in the top row right of the last event. `lane` (an index) picks the swimlane for those.
 * Kinds the board's phase doesn't offer are refused. Selects it.
 */
export const add: Command<{ board: string; kind: StickyKind; x?: number; y?: number; on?: string; after?: string; lane?: number; text?: string; by?: Author }> = (doc, a, ctx) => {
  const b = boardArg(doc, a?.board);
  if (!b || !isKind(a.kind) || !offered(phaseOf(b)).includes(a.kind)) return [];
  const k = KINDS[a.kind];
  const z = Math.floor(doc.topZ) + 1;
  let on: string | undefined;
  let x = isNum(a.x) ? a.x - k.w / 2 : b.x + PAD;
  let y = isNum(a.y) ? a.y - k.h / 2 : eventY(b, 0);
  const after = stickyArg(doc, a.after);
  const target = get(doc, a.on);
  if (after && a.kind === 'event') {
    const ev = isEvent(after) ? after : get(doc, sticky(after).on);
    if (ev) {
      // timeline: just right of it (the pack slots it in between it and the next event); explore: one step right
      x = ev.x + (enforcesTimeline(phaseOf(b)) ? COL / 2 + 1 : COL);
      y = ev.y;
    }
  } else if (after) {
    const ev = isEvent(after) ? after : get(doc, sticky(after).on);
    const evs = ev ? eventsOn(doc, b.id) : [];
    const next = ev && !isEvent(after) ? evs[evs.findIndex((e) => e.id === ev.id) + 1] : ev;
    if (next) on = next.id;
    else {
      x = after.x + COL;
      y = after.y;
    }
  } else if (target && isEvent(target) && a.kind !== 'event') on = target.id;
  const lane = isNum(a.lane) && Number.isInteger(a.lane) ? Math.max(0, Math.min(lanesOf(b).length - 1, a.lane)) : undefined;
  if (!isNum(a.x) && !isNum(a.y) && !after && !on) {
    const last = eventsOn(doc, b.id).at(-1);
    if (a.kind === 'event') {
      if (last) {
        x = last.x + (enforcesTimeline(phaseOf(b)) ? COL / 2 + 1 : COL);
        y = last.y;
      }
    } else {
      y = laneTop(b, lane ?? 0) + (ROW - k.h) / 2;
      x = last ? last.x + COL : b.x + PAD;
      // keep clear of loose stickies already in that row
      const row = doc.riders(b.id).filter((n) => isSticky(n) && !isEvent(n) && !sticky(n).on && Math.abs(n.y - y) < ROW / 2);
      while (row.some((n) => Math.abs(n.x - x) < COL / 2)) x += COL;
    }
  }
  if (lane !== undefined && a.kind === 'event' && !isNum(a.y) && !on) y = eventY(b, lane);
  const node = stickyNode(ctx.newId(), a.kind, x, y, z, { text: okText(a.text), on, by: okAuthor(a.by) });
  if (on) {
    // a provisional spot past the far end of its column (the plan stacks it there)
    const ev = doc.get(on)!;
    node.x = ev.x;
    node.y = k.side === 'above' ? ev.y - 99 * ROW : ev.y + 99 * ROW;
  }
  const pack = packBoard(doc, b, { add: node });
  const changes: Change[] = [{ op: 'add', node: placed(node, pack) }, ...pack.filter((c) => c.op !== 'set' || c.id !== node.id)];
  // a position we chose (not the caller's) must stay on the board: widen it, or the sticky falls off its right edge
  if (!isNum(a.x) && !on) changes.push(...widenFor(b, [placed(node, pack)], pack));
  const events: EventSpec[] = node.text ? [{ type: 'storm.add', text: `added ${kindName(a.kind)} ${quote(node)}`, targets: [node.id], actor: logActor(node) }] : [];
  return { changes, select: [node.id], events };
};

/**
 * Reorder an event: right after / before another event, to the front, or into another lane (alone
 * or together with those). Its attached stickies go with it; the pack closes the gaps.
 */
export const move: Command<{ id: string; after?: string; before?: string; first?: boolean; lane?: number }> = (doc, a) => {
  const ev = stickyArg(doc, a?.id);
  const b = boardOf(doc, ev);
  if (!ev || !b || !isEvent(ev)) return [];
  const anchor = (id: unknown) => {
    const e = stickyArg(doc, id);
    return e && isEvent(e) && e.id !== ev.id && boardOf(doc, e)?.id === b.id ? e : undefined;
  };
  const after = a.after !== undefined ? anchor(a.after) : undefined;
  const before = a.before !== undefined ? anchor(a.before) : undefined;
  const lane = isNum(a.lane) && Number.isInteger(a.lane) && a.lane >= 0 && a.lane < lanesOf(b).length ? a.lane : undefined;
  if ((a.after !== undefined && !after) || (a.before !== undefined && !before) || (a.lane !== undefined && lane === undefined)) return [];
  if (!after && !before && !a.first && lane === undefined) return [];
  const enforce = enforcesTimeline(phaseOf(b));
  const others = eventsOn(doc, b.id).filter((e) => e.id !== ev.id);
  let x = ev.x;
  // explore keeps positions as they are, so make room: events at or right of the target spot step right
  let from: number | undefined;
  if (enforce) {
    if (after) x = after.x + COL / 2 + 1;
    else if (before) x = before.x - COL / 2 - 1;
    else if (a.first) x = slotX(b, 0) - COL / 2 - 1;
  } else {
    if (after) from = x = after.x + COL;
    else if (before) from = x = before.x;
    else if (a.first) from = x = Math.min(slotX(b, 0), ...others.map((e) => e.x));
  }
  const moved: CanvasNode = { ...ev, x, y: lane !== undefined ? eventY(b, lane) : ev.y };
  const events = [...others.map((e) => (from !== undefined && e.x >= from ? { ...e, x: e.x + COL } : e)), moved];
  const pack = packPlan(b, events, (id) => attachedTo(doc, id), enforce, looseOn(doc, b));
  const changes: Change[] = pack.filter((c) => c.op !== 'set' || !events.some((e) => e.id === c.id));
  const origin = new Map(eventsOn(doc, b.id).map((e) => [e.id, e]));
  for (const e of events) {
    const final = placed(e, pack);
    const was = origin.get(e.id)!;
    if (final.y !== was.y) changes.unshift(set(e.id, 'y', final.y));
    if (final.x !== was.x) changes.unshift(set(e.id, 'x', final.x));
  }
  if (!enforce) changes.push(...widenFor(b, events.map((e) => placed(e, pack)), pack));
  if (!changes.length) return [];
  return { changes, events: [{ type: 'storm.move', text: `moved ${quote(ev)}`, targets: [ev.id] }] };
};

/** Put a sticky (not an event) on an event: it rides it and stacks above or below it. */
export const attach: Command<{ id: string; on: string }> = (doc, a) => {
  const s = stickyArg(doc, a?.id);
  const ev = stickyArg(doc, a?.on);
  const b = boardOf(doc, ev);
  if (!s || !ev || !b || isEvent(s) || !isEvent(ev) || sticky(s).on === ev.id) return [];
  const from = boardOf(doc, s);
  if (from && from.id !== b.id) return [];
  const view = (n: CanvasNode): CanvasNode => (n.id === s.id ? { ...n, [FIELD]: { ...sticky(n), on: ev.id } } : n);
  const all = doc.nodes.filter(isSticky).map(view);
  const attached = (id: string) => all.filter((n) => !isEvent(n) && sticky(n).on === id);
  const changes: Change[] = [set(s.id, S('on'), ev.id), ...packPlan(b, eventsOn(doc, b.id), attached, enforcesTimeline(phaseOf(b)), looseOn(doc, b))];
  return { changes, events: [{ type: 'storm.attach', text: `put ${quote(s)} on ${quote(ev)}`, targets: [s.id] }] };
};

/** Set a sticky's words. Logs the first words as "added …", later ones as "renamed …". */
export const text: Command<{ id: string; text: string }> = (doc, a) => {
  const n = stickyArg(doc, a?.id);
  const t = okText(a?.text);
  if (!n || t === undefined || t === (n.text ?? '')) return [];
  const was = (n.text ?? '').trim();
  const now = { ...n, text: t };
  const events: EventSpec[] = !t.trim() ? [] : [{ type: 'storm.text', text: was ? `renamed ${kindName(kindOf(n))} “${was.slice(0, 30)}” to ${quote(now)}` : `added ${kindName(kindOf(n))} ${quote(now)}`, targets: [n.id], ...(was ? {} : { actor: logActor(n) }) }];
  return { changes: [set(n.id, 'text', t)], events };
};

/** Change a sticky's kind (keeps its words, votes, author). An event that becomes something else lets go of what was attached to it. */
export const kind: Command<{ id: string; kind: StickyKind }> = (doc, a) => {
  const n = stickyArg(doc, a?.id);
  if (!n || !isKind(a.kind) || kindOf(n) === a.kind) return [];
  const k = KINDS[a.kind];
  const changes: Change[] = [set(n.id, S('st'), a.kind), set(n.id, 'color', k.color), set(n.id, 'width', k.w), set(n.id, 'height', k.h)];
  if (isEvent(n)) for (const s of attachedTo(doc, n.id)) changes.push(set(s.id, S('on'), undefined));
  if (a.kind === 'event' && sticky(n).on) changes.push(set(n.id, S('on'), undefined));
  return { changes, events: [{ type: 'storm.kind', text: `made ${quote(n)} a ${kindName(a.kind)}`, targets: [n.id] }] };
};

/**
 * After a drop: each moved non-event sticky attaches to the event whose column it lies in (same
 * lane, timeline phases only) or lets go; then every touched board re-packs.
 */
export const settle: Command<{ ids: string[] }> = (doc, a) => {
  if (!isIds(a?.ids)) return [];
  const moved = pick(doc, a.ids).filter(isSticky);
  const ons = new Map<string, string | undefined>();
  const boards = new Map<string, CanvasNode>();
  for (const n of moved) {
    const b = boardOf(doc, n);
    if (b) boards.set(b.id, b);
    if (isEvent(n)) continue;
    let on: string | undefined;
    if (b && enforcesTimeline(phaseOf(b))) {
      const c = center(n);
      const lane = laneAt(b, c.y);
      on = eventsOn(doc, b.id).find((e) => c.x >= e.x - 20 && c.x < e.x + e.width + 20 && laneAt(b, center(e).y) === lane)?.id;
    }
    if (on !== sticky(n).on) ons.set(n.id, on);
  }
  const changes: Change[] = [...ons].map(([id, on]) => set(id, S('on'), on));
  // the plan sees the new attachments
  const view = (n: CanvasNode): CanvasNode => (ons.has(n.id) ? { ...n, [FIELD]: { ...sticky(n), on: ons.get(n.id) } } : n);
  const all = doc.nodes.filter(isSticky).map(view);
  for (const b of boards.values()) {
    const evs = eventsOn(doc, b.id);
    const attached = (id: string) => all.filter((s) => !isEvent(s) && sticky(s).on === id);
    changes.push(...packPlan(b, evs, attached, enforcesTimeline(phaseOf(b)), looseOn(doc, b)));
  }
  return changes;
};

/**
 * Repair (core `repairs`) after a remote change or an undo/redo: two events in one timeline column
 * (added at the same moment, even in two lanes) or two attached stickies on one spot (two commands
 * on one event) re-pack the board. Every peer runs it; the pack depends on the doc only. Counted:
 * only what the pack places (two loose stickies on one spot would re-pack the board on every remote
 * change) and events only on a slot (an event someone is dragging is off its slot until the drop).
 * A clash elsewhere during a drag still re-packs the dragged event.
 */
export const repair: Command<{ ids: string[]; undo?: boolean }> = (doc, a) => {
  if (!isIds(a?.ids)) return [];
  const boards = new Map<string, CanvasNode>();
  for (const n of pick(doc, a.ids).filter(isSticky)) {
    const b = boardOf(doc, n);
    if (b && enforcesTimeline(phaseOf(b))) boards.set(b.id, b);
  }
  const out: Change[] = [];
  for (const b of boards.values()) {
    const seen = new Set<string>();
    const clash = (key: string) => {
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    };
    const onSlot = (e: CanvasNode) => (e.x - b.x - PAD) % COL === 0 && e.y === eventY(b, laneAt(b, center(e).y));
    const events = eventsOn(doc, b.id);
    const hit = events.some((e) => (onSlot(e) && clash(`${e.x}`)) || attachedTo(doc, e.id).some((s) => clash(`${s.x},${s.y}`)));
    if (hit) out.push(...packBoard(doc, b));
  }
  return out;
};

/** Re-pack a board (menu: Tidy). */
export const tidy: Command<{ board: string }> = (doc, a) => {
  const b = boardArg(doc, a?.board);
  return b ? packBoard(doc, b) : [];
};

/** Switch the workshop's phase; moving into a timeline phase snaps the events into sequence. */
export const phase: Command<{ board: string; phase: string }> = (doc, a) => {
  const b = boardArg(doc, a?.board);
  if (!b || !isPhase(a.phase) || phaseOf(b) === a.phase) return [];
  const next = { ...b, [FIELD]: { ...boardF(b), phase: a.phase } };
  const changes: Change[] = [set(b.id, S('phase'), a.phase), ...packBoard(doc, next)];
  return { changes, events: [{ type: 'storm.phase', text: `moved the workshop to ${PHASE_INFO[a.phase].name.replace(/^\d /, '')}`, targets: [b.id], cue: 'pulse' }] };
};

/** Rename / add / remove swimlanes (at least one). The board grows or shrinks; the timeline re-packs. */
export const lanes: Command<{ board: string; lanes: string[] }> = (doc, a) => {
  const b = boardArg(doc, a?.board);
  if (!b || !Array.isArray(a.lanes)) return [];
  const ls = a.lanes.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim().slice(0, 40));
  if (!ls.length || JSON.stringify(ls) === JSON.stringify(lanesOf(b))) return [];
  const next = { ...b, height: boardHeight(ls.length), [FIELD]: { ...boardF(b), lanes: ls } };
  return [set(b.id, S('lanes'), ls), set(b.id, 'height', next.height), ...packBoard(doc, next)];
};

/** Votes each person may cast on a board. */
export const dots: Command<{ board: string; dots: number }> = (doc, a) => {
  const b = boardArg(doc, a?.board);
  if (!b || !isNum(a.dots) || a.dots < 0 || a.dots > 20) return [];
  return boardF(b).dots === Math.round(a.dots) ? [] : [set(b.id, S('dots'), Math.round(a.dots))];
};

/** Votes `voter` has cast on a board. */
export function votesCast(doc: DocView, boardId: string, voter: string): number {
  return stickiesOn(doc, boardId).reduce((s, n) => s + (votesOf(n)[voter] ?? 0), 0);
}

/** Dot voting: +1 / −1 of `voter`'s dots on a sticky, within the board's budget. */
export const vote: Command<{ id: string; voter: string; delta: 1 | -1 }> = (doc, a) => {
  const n = stickyArg(doc, a?.id);
  const b = n && boardOf(doc, n);
  if (!n || !b || typeof a.voter !== 'string' || (a.delta !== 1 && a.delta !== -1)) return [];
  const mine = votesOf(n)[a.voter] ?? 0;
  if (a.delta === -1 && !mine) return [];
  if (a.delta === 1 && votesCast(doc, b.id, a.voter) >= boardF(b).dots) return [];
  const v = mine + a.delta;
  return {
    changes: [set(n.id, S(`v_${a.voter}`), v || undefined)],
    events: [{ type: 'storm.vote', text: a.delta > 0 ? `voted for ${quote(n)}` : `took a vote back from ${quote(n)}`, targets: [n.id], key: `vote:${n.id}:${a.delta}` }],
  };
};

/** Timebox for the current phase: start / pause / reset / set length. `now` = the caller's clock. */
export const timer: Command<{ board: string; action: 'start' | 'pause' | 'reset' | 'set'; now: number; minutes?: number }> = (doc, a) => {
  const b = boardArg(doc, a?.board);
  if (!b || !isNum(a.now)) return [];
  const t = boardF(b).timer;
  const put = (k: string, v: unknown): Change => set(b.id, S('timer'), { ...t, [k]: v });
  const log = (text: string, changes: Change[]): CommandResult => ({ changes, events: [{ type: 'storm.timer', text, targets: [b.id] }] });
  switch (a.action) {
    case 'start':
      if (typeof t.since === 'number' || timerLeft(t, a.now) <= 0) return [];
      return log(`started the timebox (${Math.ceil(t.left / 60000)} min)`, [put('since', a.now)]);
    case 'pause': {
      if (typeof t.since !== 'number') return [];
      return log('paused the timebox', [set(b.id, S('timer'), { base: t.base, left: timerLeft(t, a.now) })]);
    }
    case 'reset':
      return t.left === t.base && t.since === undefined ? [] : [set(b.id, S('timer'), { base: t.base, left: t.base })];
    case 'set': {
      if (!isNum(a.minutes) || a.minutes <= 0 || a.minutes > 240) return [];
      const ms = Math.round(a.minutes * 60_000);
      return [set(b.id, S('timer'), { base: ms, left: ms })];
    }
  }
  return [];
};

/** Let go of an event (stays where it is). */
export const detach: Command<{ ids: string[] }> = (doc, a) =>
  pick(doc, a?.ids)
    .filter((n) => isSticky(n) && sticky(n).on)
    .map((n) => set(n.id, S('on'), undefined));

/** Reset table: votes back, timers back. Stickies stay (they're the work). */
export const resetAll: Command = (doc) => {
  const out: Change[] = [];
  for (const n of doc.nodes) {
    if (isSticky(n)) for (const v of Object.keys(votesOf(n))) out.push(set(n.id, S(`v_${v}`), undefined));
    if (isBoard(n)) {
      const t = boardF(n).timer;
      if (t.left !== t.base || t.since !== undefined) out.push(set(n.id, S('timer'), { base: t.base, left: t.base }));
    }
  }
  return out;
};

export const commands = { createBoard, add, text, kind, move, attach, settle, tidy, phase, lanes, dots, vote, timer, detach };
