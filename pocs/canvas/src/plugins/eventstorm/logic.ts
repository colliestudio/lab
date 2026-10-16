import * as z from 'zod/mini';
import { command, nodeRef, view, type AgentCtx, type CommandSpec } from '../../core/agent';
import type { CanvasNode, Command, DocView, Store } from '../../core';
import { boardOf, boardsIn, commands, eventsOn, repair, resetAll, votesCast } from './commands';
import { flowOf, flowText } from './flow';
import {
  KINDS,
  KIND_ORDER,
  MIN_W,
  board as boardF,
  boardHeight,
  isEvent,
  isSticky,
  kindOf,
  lanesOf,
  offered,
  phaseOf,
  stormCarrierOf,
  sticky,
  timerLeft,
  votesOf,
  voteTotal,
  type Author,
} from './model';
import type { PluginLogic } from '../logic';

// The data side of the plugin (commands, rider rule, reset) and how an agent uses it: a spec per
// command, the storm.flow view, the guide. No DOM; used by tests too.
//
// Refusals with a reason live in the specs' adapters (`toCommand` throws, the bridge reports it
// as the call's error); the commands keep the store contract (bad args do nothing), so the UI,
// which dispatches without prechecks, is unchanged.

const KIND = z.enum(KIND_ORDER);
const PHASE = z.enum(['explore', 'timeline', 'process', 'aggregates']);
const board_ = z.optional(nodeRef('event storm board (id or label); default: the only board'));
const ref = (what: string) => nodeRef(`${what} (id or its text)`);

// ---------------------------------------------------------------- adapter helpers

const nameOf = (n: CanvasNode) => `“${(n.label ?? n.text ?? n.id).trim().split('\n')[0].slice(0, 40)}”`;
const boardName = (b: CanvasNode) => `${nameOf(b)} (${b.id})`;

/** The board a call is about: the one named, else the one the given stickies are on, else the only one. */
function stormBoard(doc: DocView, ref?: string, ...stickyRefs: (string | undefined)[]): CanvasNode {
  const named = ref ? doc.get(ref) : undefined;
  if (named && boardsIn(doc).some((b) => b.id === named.id)) return named;
  if (ref) throw new Error(`board: ${named ? nameOf(named) : ref} is not an event storm board. Boards: ${boardsIn(doc).map(boardName).join(', ') || 'none'}`);
  for (const r of stickyRefs) {
    const b = r ? boardOf(doc, doc.get(r)) : undefined;
    if (b) return b;
  }
  const all = boardsIn(doc);
  if (all.length === 1) return all[0];
  if (!all.length) throw new Error('no event storm board yet; make one with storm.createBoard {label?, lanes?}');
  throw new Error(`${all.length} event storm boards: ${all.map(boardName).join(', ')}. Pass board.`);
}
/** Refuse a node that is on another board than `b`. */
function sameBoard(doc: DocView, b: CanvasNode, id: string, field: string) {
  const o = boardOf(doc, doc.get(id));
  if (o && o.id !== b.id) throw new Error(`${field}: ${nameOf(doc.get(id)!)} is on board ${boardName(o)}, not ${boardName(b)}`);
}
function boardFor(doc: DocView, n: CanvasNode, field: string): CanvasNode {
  const b = boardOf(doc, n);
  if (!b) throw new Error(`${field}: ${nameOf(n)} is not on an event storm board (it sits outside every board; delete it and add it again)`);
  return b;
}
function laneIndex(b: CanvasNode, name: string): number {
  const lanes = lanesOf(b);
  const i = lanes.findIndex((l) => l.toLowerCase() === name.trim().toLowerCase());
  if (i < 0) throw new Error(`lane: no lane “${name}”; lanes: ${lanes.join(', ')}`);
  return i;
}
function mustSticky(doc: DocView, id: string, field: string): CanvasNode {
  const n = doc.get(id);
  if (!n || !isSticky(n)) throw new Error(`${field}: ${n ? nameOf(n) : id} is not an event storm sticky`);
  return n;
}
function mustEvent(doc: DocView, id: string, field: string): CanvasNode {
  const n = mustSticky(doc, id, field);
  if (!isEvent(n)) throw new Error(`${field}: ${nameOf(n)} is a ${KINDS[kindOf(n)].name.toLowerCase()}, not a domain event`);
  return n;
}
const actorAuthor = (ctx: AgentCtx): Author => ({ id: ctx.actor.id, name: ctx.actor.name, color: ctx.actor.color });

/** Center for a new board of `w` x `h`: right of everything visible, top-aligned (the command centers boards on x/y). */
function freeCenter(doc: DocView, w: number, h: number): { x: number; y: number } {
  if (!doc.visible.length) return { x: Math.round(w / 2), y: Math.round(h / 2) };
  const right = Math.max(...doc.visible.map((o) => o.x + o.width));
  const top = Math.min(...doc.visible.map((o) => o.y));
  return { x: Math.round(right + 80 + w / 2), y: Math.round(top + h / 2) };
}

// ---------------------------------------------------------------- specs

const changed = (r: { changes: unknown[] }) => r.changes.length;

export const specs: Record<string, CommandSpec> = {
  createBoard: command({
    description: 'Start an event storm: a board with swimlanes (top to bottom), in phase explore. Without x/y it goes in a free spot. Returns the board id.',
    args: z.strictObject({
      label: z.optional(z.string().check(z.meta({ description: 'name of the board, e.g. the process being stormed' }))),
      lanes: z.optional(z.array(z.string()).check(z.meta({ description: 'swimlane names, top to bottom (e.g. who acts: Customer, Shop, Warehouse); default one lane' }))),
      x: z.optional(z.number().check(z.meta({ description: 'center of the board' }))),
      y: z.optional(z.number()),
    }),
    example: { label: 'Checkout', lanes: ['Customer', 'Shop', 'Warehouse'] },
    toCommand: (a, ctx) => {
      const lanes = a.lanes?.map((l) => l.trim()).filter(Boolean);
      const at = typeof a.x === 'number' && typeof a.y === 'number' ? { x: a.x, y: a.y } : freeCenter(ctx.doc, MIN_W, boardHeight(lanes?.length || 1));
      return { label: a.label, lanes, ...at };
    },
    result: (r, _a, ctx) => ({ id: r.select?.[0], phase: 'explore', lanes: lanesOf(ctx.doc.get(r.select![0])!) }),
  }),
  add: command({
    description:
      'Add a sticky. An event (past tense: "Order placed") goes at the end of the timeline, or right after `after`; any other kind goes on an event with `on`. `lane` picks the swimlane. Kinds appear by phase (see the guide). Returns the new id.',
    args: z.strictObject({
      kind: KIND,
      text: z.string().check(z.minLength(1), z.meta({ description: 'the sticky\'s words' })),
      board: board_,
      after: z.optional(ref('place the event right after this one')),
      on: z.optional(ref('the event this sticky belongs to (not for events)')),
      lane: z.optional(z.string().check(z.meta({ description: 'swimlane name; for events (after keeps the lane unless given); ignored with on, which follows the event\'s lane; default the first' }))),
      x: z.optional(z.number().check(z.meta({ description: 'canvas position (rarely needed)' }))),
      y: z.optional(z.number()),
    }),
    example: { kind: 'event', text: 'Order placed', after: 'Checkout started' },
    toCommand: (a, ctx) => {
      const doc = ctx.doc;
      const b = stormBoard(doc, a.board, a.after, a.on);
      if (a.on && a.kind === 'event') throw new Error("on: events don't attach to events; use after to place an event on the timeline");
      if (!offered(phaseOf(b)).includes(a.kind)) {
        const from = KINDS[a.kind].from;
        throw new Error(`kind: ${a.kind} comes in phase ${from}; board ${boardName(b)} is in ${phaseOf(b)}. Run storm.phase {phase:"${from}"} first (events snap into one timeline)`);
      }
      if (a.on) {
        const t = mustSticky(doc, a.on, 'on');
        if (!isEvent(t)) throw new Error(`on: ${nameOf(t)} is a ${KINDS[kindOf(t)].name.toLowerCase()}, not a domain event`);
        sameBoard(doc, b, a.on, 'on');
      }
      if (a.after) {
        const t = mustSticky(doc, a.after, 'after');
        if (a.kind === 'event' && !isEvent(t) && !(sticky(t).on && isEvent(doc.get(sticky(t).on!)))) throw new Error(`after: ${nameOf(t)} is a ${KINDS[kindOf(t)].name.toLowerCase()} not on an event; give an event`);
        sameBoard(doc, b, a.after, 'after');
      }
      return { board: b.id, kind: a.kind, text: a.text, after: a.after, on: a.on, lane: a.lane === undefined ? undefined : laneIndex(b, a.lane), x: a.x, y: a.y, by: actorAuthor(ctx) };
    },
    result: (r, a, ctx) => {
      const id = r.select?.[0];
      const n = id ? ctx.doc.get(id) : undefined;
      return { id, kind: a.kind, ...(n && sticky(n).on ? { on: sticky(n).on } : {}), changed: changed(r) };
    },
  }),
  text: command({
    description: 'Change a sticky\'s words.',
    args: z.strictObject({ id: ref('the sticky'), text: z.string() }),
    example: { id: 'Order placed', text: 'Order submitted' },
    toCommand: (a, ctx) => (mustSticky(ctx.doc, a.id, 'id'), a),
    result: (r, a) => ({ id: a.id, changed: changed(r) }),
  }),
  kind: command({
    description: 'Change a sticky\'s kind (keeps its words). An event that becomes something else lets go of what was attached to it.',
    args: z.strictObject({ id: ref('the sticky'), kind: KIND }),
    example: { id: 'Card declined', kind: 'hotspot' },
    toCommand: (a, ctx) => (mustSticky(ctx.doc, a.id, 'id'), a),
    result: (r, a) => ({ id: a.id, kind: a.kind, changed: changed(r) }),
  }),
  move: command({
    description: 'Reorder a domain event on the timeline: right after or before another event, to the front, or into another swimlane. Its attached stickies go with it.',
    args: z.strictObject({
      id: ref('the event to move'),
      after: z.optional(ref('put it right after this event')),
      before: z.optional(ref('put it right before this event')),
      first: z.optional(z.boolean().check(z.meta({ description: 'put it at the start' }))),
      lane: z.optional(z.string().check(z.meta({ description: 'swimlane name; the order stays' }))),
    }),
    example: { id: 'Payment received', after: 'Order placed' },
    toCommand: (a, ctx) => {
      const doc = ctx.doc;
      const n = mustSticky(doc, a.id, 'id');
      if (!isEvent(n)) throw new Error(`id: storm.move moves domain events; ${nameOf(n)} is a ${KINDS[kindOf(n)].name.toLowerCase()}. Put it on an event with storm.attach`);
      if (!a.after && !a.before && !a.first && a.lane === undefined) throw new Error('give one of after, before, first or lane');
      const b = boardFor(doc, n, 'id');
      for (const [f, id] of [['after', a.after], ['before', a.before]] as const) {
        if (!id) continue;
        mustEvent(doc, id, f);
        sameBoard(doc, b, id, f);
        if (id === a.id) throw new Error(`${f}: an event can't go ${f} itself`);
      }
      return { id: a.id, after: a.after, before: a.before, first: a.first, lane: a.lane === undefined ? undefined : laneIndex(b, a.lane) };
    },
    result: (r, a, ctx) => {
      const b = boardOf(ctx.doc, ctx.doc.get(a.id))!;
      return { id: a.id, position: eventsOn(ctx.doc, b.id).findIndex((e) => e.id === a.id) + 1, changed: changed(r) };
    },
  }),
  attach: command({
    description: 'Put a sticky (command, actor, policy, read model, external system, hotspot) on a domain event. Commands and actors stack above the event, the rest below.',
    args: z.strictObject({ id: ref('the sticky to attach'), on: ref('the domain event') }),
    example: { id: 'Place order', on: 'Order placed' },
    toCommand: (a, ctx) => {
      const doc = ctx.doc;
      const n = mustSticky(doc, a.id, 'id');
      if (isEvent(n)) throw new Error(`id: ${nameOf(n)} is a domain event; events go on the timeline (storm.move), only other stickies attach`);
      mustEvent(doc, a.on, 'on');
      const b = boardFor(doc, doc.get(a.on)!, 'on');
      sameBoard(doc, b, a.id, 'id');
      return a;
    },
    result: (r, a) => ({ id: a.id, on: a.on, changed: changed(r) }),
  }),
  detach: command({
    description: 'Let go of the event a sticky is attached to (it stays where it is).',
    args: z.strictObject({ ids: z.array(ref('a sticky')) }),
    example: { ids: ['Place order'] },
    result: (r) => ({ changed: changed(r) }),
  }),
  phase: command({
    description: 'Switch the workshop phase. explore: events and hotspots anywhere. timeline: events snap into one sequence. process: adds command, actor, policy, read model, external system. aggregates: adds aggregate. Switching to the phase it is in changes nothing.',
    args: z.strictObject({ phase: PHASE, board: board_ }),
    example: { phase: 'timeline' },
    toCommand: (a, ctx) => ({ board: stormBoard(ctx.doc, a.board).id, phase: a.phase }),
    result: (r, a, ctx) => {
      const b = stormBoard(ctx.doc, a.board);
      return { phase: phaseOf(b), offers: offered(phaseOf(b)), changed: changed(r) };
    },
  }),
  lanes: command({
    description: 'Set the swimlanes, top to bottom (rename, add, remove). Events keep their lane by position.',
    args: z.strictObject({ lanes: z.array(z.string()).check(z.minLength(1)), board: board_ }),
    example: { lanes: ['Customer', 'Shop', 'Warehouse'] },
    toCommand: (a, ctx) => {
      const lanes = a.lanes.map((l) => l.trim()).filter(Boolean);
      if (!lanes.length) throw new Error('lanes: give at least one lane name');
      return { board: stormBoard(ctx.doc, a.board).id, lanes };
    },
    result: (r, a, ctx) => ({ lanes: lanesOf(stormBoard(ctx.doc, a.board)), changed: changed(r) }),
  }),
  tidy: command({
    description: 'Re-pack the board: events in one gap-free sequence (timeline phases), attached stickies stacked on their events. Use after deleting.',
    args: z.strictObject({ board: board_ }),
    example: {},
    toCommand: (a, ctx) => ({ board: stormBoard(ctx.doc, a.board).id }),
    result: (r) => ({ changed: changed(r) }),
  }),
  settle: command({
    description: 'After moving stickies by position (core.move): attach each moved sticky to the event in its column and re-pack. Prefer storm.move and storm.attach.',
    args: z.strictObject({ ids: z.array(ref('a sticky that was moved')) }),
    example: { ids: ['Place order'] },
    result: (r) => ({ changed: changed(r) }),
  }),
  dots: command({
    description: 'Votes each person may cast on the board (0 to 20; default 3).',
    args: z.strictObject({ dots: z.int().check(z.gte(0), z.lte(20)), board: board_ }),
    example: { dots: 3 },
    toCommand: (a, ctx) => ({ board: stormBoard(ctx.doc, a.board).id, dots: a.dots }),
    result: (r) => ({ changed: changed(r) }),
  }),
  vote: command({
    description: 'Dot voting: put one of your votes on a sticky (or take one back). Each person has a few votes per board.',
    args: z.strictObject({ id: ref('the sticky'), back: z.optional(z.boolean().check(z.meta({ description: 'take a vote back instead' }))) }),
    example: { id: 'Payment received' },
    toCommand: (a, ctx) => {
      const n = mustSticky(ctx.doc, a.id, 'id');
      const b = boardFor(ctx.doc, n, 'id');
      const me = ctx.actor.id;
      if (a.back) {
        if (!votesOf(n)[me]) throw new Error(`id: you have no vote on ${nameOf(n)} to take back`);
      } else if (votesCast(ctx.doc, b.id, me) >= boardF(b).dots) throw new Error(`no votes left on this board (${boardF(b).dots} each)`);
      return { id: a.id, voter: me, delta: a.back ? -1 : 1 };
    },
    result: (r, a, ctx) => {
      const n = ctx.doc.get(a.id)!;
      const b = boardOf(ctx.doc, n)!;
      return { id: a.id, votes: voteTotal(n), left: boardF(b).dots - votesCast(ctx.doc, b.id, ctx.actor.id), changed: changed(r) };
    },
  }),
  timer: command({
    description: 'Timebox for the current phase: set its length in minutes, start, pause or reset it.',
    args: z.strictObject({
      action: z.enum(['start', 'pause', 'reset', 'set']),
      minutes: z.optional(z.number().check(z.gt(0), z.lte(240), z.meta({ description: 'length, for action set' }))),
      board: board_,
    }),
    example: { action: 'set', minutes: 10 },
    toCommand: (a, ctx) => {
      const b = stormBoard(ctx.doc, a.board);
      const t = boardF(b).timer;
      const now = Date.now();
      const running = typeof t.since === 'number';
      if (a.action === 'set' && a.minutes === undefined) throw new Error('minutes: give the length in minutes for action set');
      if (a.action === 'start' && running) throw new Error('the timer is already running');
      if (a.action === 'start' && timerLeft(t, now) <= 0) throw new Error('no time left; storm.timer {action:"reset"} or set a new length');
      if (a.action === 'pause' && !running) throw new Error('the timer is not running');
      return { board: b.id, action: a.action, minutes: a.minutes, now };
    },
    result: (r, a, ctx) => {
      const t = boardF(stormBoard(ctx.doc, a.board)).timer;
      return { left_s: Math.ceil(timerLeft(t, Date.now()) / 1000), running: typeof t.since === 'number', changed: changed(r) };
    },
  }),
};

const GUIDE = `Event storming: domain events (past tense, orange) in time order left to right, with what triggers them above and what follows below.
- storm.createBoard makes a board (label, lanes = swimlanes top to bottom). Commands without board use the only board.
- Phases in order: explore (events, hotspots), timeline (events snap into one sequence), process (adds command, actor, policy, read, external), aggregates (adds aggregate). A kind outside the phase is refused; switch with storm.phase.
- Events: storm.add {kind: "event", text}. Without after it goes at the end of the timeline; after: <event> puts it right after that one; lane: <name> picks the swimlane.
- Commands, actors, policies, read models, external systems: storm.add with on: <event> (id or its text). Commands and actors stack above the event, the rest below.
- storm.move reorders an event (after, before, first, lane). storm.attach / storm.detach put a sticky on or off an event. storm.text / storm.kind edit one.
- Check your work with the view storm.flow (canvas_look with view "storm.flow"): the timeline in order with ids, lanes and what is attached.
- Typical run: createBoard, add the events in order, phase timeline, phase process, add a command on each event, look at storm.flow.
- Delete with core.delete, then storm.tidy closes the gaps.`;

/** The data side of the plugin (commands, views, rider rule, reset). No DOM; used by tests too. */
export function registerStormLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`storm.${name}`, cmd as Command, specs[name]);
  store.registerView(
    'storm.flow',
    view({
      description: 'The storm as text: phase and what it offers, lanes, the timeline (events left to right with ids, lane and what is attached), stickies not on an event, the next step.',
      args: z.strictObject({ board: board_ }),
      example: {},
      read: (doc, a) => flowOf(doc, stormBoard(doc, a.board)),
      text: (v) => flowText(v as ReturnType<typeof flowOf>),
    }),
  );
  store.addRiderRule(stormCarrierOf);
  store.resets.push(resetAll);
  store.repairs.push(repair as Command);
  store.summaryExt.add('x-storm'); // a sticky's kind and event show in listings
}

export const logic: PluginLogic = {
  id: 'eventstorm',
  title: 'Event storm',
  summary: 'Event storming: a timeline of domain events with commands, actors and policies on them; phases, swimlanes, votes, timebox.',
  guide: GUIDE,
  register: registerStormLogic,
};
