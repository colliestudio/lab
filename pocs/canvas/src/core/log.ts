import type { DocView } from './doc';

// Event log: what players did that the others care about (a shuffle, a draw, a card played, a
// flag claimed). Commands report events as plain data next to their changes; the store appends them
// to a synced Y.Array in the doc, so every peer (and a reload) sees one log. Plain repositioning is
// never reported: the plugin decides what's relevant.
//
// Privacy: `text` is what everyone may read. A variant in `private` goes to the players listed (the
// owner of a hand sees which card left it). Texts are computed by the emitter from the state after
// the change, so they never name a card a viewer couldn't see then. Like card faces in the doc
// itself, private variants are in every peer's copy of the doc; only the UI keeps them apart (a
// host/dealer would filter them per player).

export interface LogActor {
  id: string;
  name: string;
  color: string;
}

/** What a command reports. `text` is the predicate, without the actor: "shuffled the Deck". */
export interface EventSpec {
  /** "<plugin>.<what>", e.g. "cards.shuffle". */
  type: string;
  /** Public text (no hidden information). */
  text: string;
  /** Fuller texts for some players (first match wins), e.g. the hand's owner sees the card's name. */
  private?: { to: string[]; text: string }[];
  /** Nodes it's about: the cue shows at the first one the viewer can see; a log click pans there. */
  targets?: string[];
  /** In-place animation on the first target: "shuffle", "deal", "pulse". Other targets pulse. */
  cue?: string;
  /** Same key from the same actor within a few seconds = already told (e.g. a draw dragged into a hand). */
  key?: string;
  /** Override the actor; null = nobody (the game itself: "White's time ran out"). */
  actor?: LogActor | null;
}

export interface LogEvent extends Omit<EventSpec, 'actor'> {
  id: string;
  /** ms epoch on the actor's device. */
  time: number;
  actor: LogActor | null;
}

/** A command's events: a list, or computed from the doc after its changes (what is visible then). */
export type Events = EventSpec[] | ((after: DocView) => EventSpec[]);

/** Keep the log this long (oldest entries go). */
export const LOG_CAP = 500;
/** A repeated `key` within this many ms is not logged again. */
export const KEY_WINDOW = 8000;

/** The text `viewer` gets: their private variant if there is one, else the public text. */
export function textFor(e: Pick<LogEvent, 'text' | 'private'>, viewer: string): string {
  return e.private?.find((p) => Array.isArray(p.to) && p.to.includes(viewer))?.text ?? e.text;
}

/** One line for `viewer`: "Alice shuffled the Deck", "You drew 7♥", "White's time ran out". */
export function eventLine(e: LogEvent, viewer: string): string {
  const body = textFor(e, viewer);
  if (!e.actor) return body.charAt(0).toUpperCase() + body.slice(1);
  return `${e.actor.id === viewer ? 'You' : e.actor.name} ${body}`;
}

/** "a card", "2 cards". */
export const count = (n: number, one: string, many = `${one}s`) => (n === 1 ? `a ${one}` : `${n} ${many}`);

/** "now", "40s", "3m", "2h", "5d". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Plain JSON for the Y.Array (no undefined fields). */
export function cleanEvent(e: LogEvent): LogEvent {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined) out[k] = v;
  return out as unknown as LogEvent;
}
