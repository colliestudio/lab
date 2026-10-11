import type { CanvasNode } from '../../core';

// Automation as data: a Button node holds a list of declarative steps. Each step is one verb from a
// small fixed vocabulary (below) that maps onto existing commands; targets are picked by name / kind
// / place at run time, never by id, so a button survives New round, copies and other tables. Steps are
// plain JSON in the node (`x-auto`), so they sync, live in the .canvas file, and an agent can write
// them. A run is one command: one undo step, one log entry. No code runs: `validate` is the gate.

export const FIELD = 'x-auto';
export const BUTTON_W = 220;
export const BUTTON_H = 76;
export const MAX_STEPS = 40;
const MAX_TEXT = 120;

export const KINDS = ['deck', 'hand', 'zone', 'mat', 'card', 'clock', 'text', 'button'] as const;
export type Kind = (typeof KINDS)[number];

/** What a step acts on: everything that matches all given fields. `in`: inside the thing with that name. */
export interface Target {
  name?: string;
  kind?: Kind;
  in?: string;
}

/** "Only if …": the target's things (cards in a container, things in an area) are empty or not. */
export interface Cond {
  target: Target;
  is: 'empty' | 'not-empty';
  /** Several matches: all of them (default) or any one must be so. */
  match?: 'all' | 'any';
}

type When = { when?: Cond };
export type Step = When &
  (
    | { do: 'shuffle'; target: Target }
    | { do: 'deal'; from: Target; count: number | 'even' }
    | { do: 'move'; what: Target; to: Target; count?: number }
    | { do: 'gather'; target: Target }
    | { do: 'flip'; target: Target; faceUp: boolean }
    | { do: 'clock'; target: Target; action: 'start' | 'pause' | 'reset' }
    | { do: 'setText'; target: Target; text: string }
    | { do: 'cycle'; target: Target; values: string[] }
    | { do: 'log'; text: string }
    | { do: 'stop' }
  );
export type Verb = Step['do'];

/** Click (default) or "a card lands in this zone" (runs on the player who put it there, same undo step). */
export type Trigger = { on: 'click' } | { on: 'enter'; zone: Target };

export interface ButtonField {
  name: string;
  steps: Step[];
  trigger?: Trigger;
}

// ------------------------------------------------------------------ the step schema (also drives the editor)

export type ArgType = 'target' | 'count' | 'number' | 'bool' | 'text' | 'list' | 'clockAction';
export interface ArgSpec {
  type: ArgType;
  label: string;
  optional?: boolean;
}
export const VERBS: Record<Verb, { label: string; hint: string; args: Record<string, ArgSpec> }> = {
  shuffle: { label: 'Shuffle', hint: 'shuffle a deck or pile', args: { target: { type: 'target', label: 'deck' } } },
  deal: {
    label: 'Deal to players',
    hint: "round-robin into each player's hand, face down",
    args: { from: { type: 'target', label: 'from' }, count: { type: 'count', label: 'each' } },
  },
  move: {
    label: 'Move',
    hint: 'cards into a container (they take its facing), or notes into an area',
    args: {
      what: { type: 'target', label: 'what' },
      to: { type: 'target', label: 'to' },
      count: { type: 'number', label: 'top', optional: true },
    },
  },
  gather: { label: 'Gather all into', hint: "every card of this deck's pack comes home", args: { target: { type: 'target', label: 'deck' } } },
  flip: { label: 'Turn', hint: 'cards face up or down', args: { target: { type: 'target', label: 'cards' }, faceUp: { type: 'bool', label: 'face up' } } },
  clock: { label: 'Clock', hint: 'start, pause or reset a clock', args: { target: { type: 'target', label: 'clock' }, action: { type: 'clockAction', label: 'action' } } },
  setText: { label: 'Set text', hint: 'of a note', args: { target: { type: 'target', label: 'note' }, text: { type: 'text', label: 'text' } } },
  cycle: { label: 'Next value', hint: 'a note steps through a list', args: { target: { type: 'target', label: 'note' }, values: { type: 'list', label: 'values' } } },
  log: { label: 'Log', hint: 'a line in the log', args: { text: { type: 'text', label: 'text' } } },
  stop: { label: 'Stop', hint: 'end the run here (use with "only if")', args: {} },
};
export const VERB_IDS = Object.keys(VERBS) as Verb[];

// ------------------------------------------------------------------ validation

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const okText = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function targetError(v: unknown): string | null {
  if (!isObj(v)) return 'must be a target object';
  for (const k of Object.keys(v)) if (!['name', 'kind', 'in'].includes(k)) return `unknown target field "${k}"`;
  if (v.name === undefined && v.kind === undefined && v.in === undefined) return 'needs a name, a kind or "in"';
  if (v.name !== undefined && !okText(v.name, 80)) return 'name must be a short text';
  if (v.in !== undefined && !okText(v.in, 80)) return '"in" must be a short text';
  if (v.kind !== undefined && !KINDS.includes(v.kind as Kind)) return `kind must be one of ${KINDS.join(', ')}`;
  return null;
}

function argError(spec: ArgSpec, v: unknown): string | null {
  switch (spec.type) {
    case 'target':
      return targetError(v);
    case 'count':
      return v === 'even' || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 52) ? null : 'must be 1–52 or "even"';
    case 'number':
      return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 200 ? null : 'must be a whole number 1–200';
    case 'bool':
      return typeof v === 'boolean' ? null : 'must be true or false';
    case 'text':
      return okText(v) ? null : `must be a text (1–${MAX_TEXT} characters)`;
    case 'list':
      return Array.isArray(v) && v.length >= 2 && v.length <= 20 && v.every((x) => okText(x, 80)) ? null : 'must be a list of 2–20 short texts';
    case 'clockAction':
      return v === 'start' || v === 'pause' || v === 'reset' ? null : 'must be start, pause or reset';
  }
}

function condError(v: unknown): string | null {
  if (!isObj(v)) return 'must be an object';
  for (const k of Object.keys(v)) if (!['target', 'is', 'match'].includes(k)) return `unknown field "${k}"`;
  const t = targetError(v.target);
  if (t) return `target: ${t}`;
  if (v.is !== 'empty' && v.is !== 'not-empty') return 'is must be "empty" or "not-empty"';
  if (v.match !== undefined && v.match !== 'all' && v.match !== 'any') return 'match must be "all" or "any"';
  return null;
}

/** Errors in a step list ("step 2 (move): to: needs a name…"); empty = valid. */
export function validateSteps(steps: unknown): string[] {
  if (!Array.isArray(steps)) return ['steps must be a list'];
  if (steps.length > MAX_STEPS) return [`at most ${MAX_STEPS} steps`];
  const errs: string[] = [];
  steps.forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (!isObj(s)) return errs.push(`${at}: must be an object`);
    const verb = typeof s.do === 'string' && Object.hasOwn(VERBS, s.do) ? VERBS[s.do as Verb] : undefined;
    if (!verb) return errs.push(`${at}: unknown "do": ${JSON.stringify(s.do)} (one of ${VERB_IDS.join(', ')})`);
    for (const k of Object.keys(s)) if (k !== 'do' && k !== 'when' && !(k in verb.args)) errs.push(`${at} (${s.do}): unknown field "${k}"`);
    for (const [k, spec] of Object.entries(verb.args)) {
      if (s[k] === undefined) {
        if (!spec.optional) errs.push(`${at} (${s.do}): missing "${k}"`);
        continue;
      }
      const e = argError(spec, s[k]);
      if (e) errs.push(`${at} (${s.do}): ${k} ${e}`);
    }
    if (s.when !== undefined) {
      const e = condError(s.when);
      if (e) errs.push(`${at} (${s.do}): when: ${e}`);
    }
  });
  return errs;
}

export function validateTrigger(t: unknown): string[] {
  if (t === undefined) return [];
  if (!isObj(t)) return ['trigger must be an object'];
  if (t.on === 'click') return Object.keys(t).length === 1 ? [] : ['trigger: click takes no fields'];
  if (t.on === 'enter') {
    const e = targetError(t.zone);
    return e ? [`trigger zone: ${e}`] : Object.keys(t).every((k) => k === 'on' || k === 'zone') ? [] : ['trigger: unknown field'];
  }
  return ['trigger "on" must be "click" or "enter"'];
}

// ------------------------------------------------------------------ the node

const field = (n: CanvasNode | undefined) => n?.[FIELD] as Partial<ButtonField> | undefined;
export const isButton = (n: CanvasNode | undefined): boolean => !!n && typeof field(n)?.name === 'string' && Array.isArray(field(n)?.steps);
export const buttonOf = (n: CanvasNode) => n[FIELD] as ButtonField;
export const isRule = (n: CanvasNode) => buttonOf(n).trigger?.on === 'enter';

/** The fallback text other JSON Canvas apps show. */
export const buttonText = (name: string, trigger?: Trigger) =>
  trigger?.on === 'enter' ? `⚡ ${name} (when a card enters ${targetText(trigger.zone)})` : `▶ ${name}`;

export function buttonNode(id: string, x: number, y: number, z: number, b: ButtonField): CanvasNode {
  return {
    id,
    type: 'text',
    x: Math.round(x),
    y: Math.round(y),
    width: BUTTON_W,
    height: BUTTON_H,
    z,
    text: buttonText(b.name, b.trigger),
    [FIELD]: structuredClone(b.trigger ? b : { name: b.name, steps: b.steps }),
  };
}

// ------------------------------------------------------------------ targets as short text (editor, log, describe)

const PLURAL: Record<Kind, string> = { deck: 'decks', hand: 'hands', zone: 'zones', mat: 'mats', card: 'cards', clock: 'clocks', text: 'notes', button: 'buttons' };
const SINGULAR: Record<string, Kind> = Object.fromEntries([...KINDS.map((k) => [k, k]), ...Object.entries(PLURAL).map(([k, p]) => [p, k]), ['note', 'text']]);

/** `{name:'Main'}` → "Main"; `{kind:'hand'}` → "hands"; `{kind:'card', in:'Pile'}` → "cards in Pile"; `{kind:'clock', name:'Timer'}` → "clock Timer". */
export function targetText(t: Target): string {
  const kind = t.kind ? (t.name ? (t.kind === 'text' ? 'note' : t.kind) : PLURAL[t.kind]) : '';
  const head = [kind, t.name ?? ''].filter(Boolean).join(' ');
  if (t.in) return `${head || 'everything'} in ${t.in}`;
  return head;
}

/** The inverse of `targetText` (lenient): "cards in Pile", "hands", "clock", "Main", "note Phase". */
export function parseTarget(s: string): Target | null {
  const text = s.trim();
  if (!text) return null;
  const m = /^(.*?)\s+in\s+(.+)$/i.exec(text);
  const head = m ? m[1].trim() : text;
  const t: Target = {};
  if (m) t.in = m[2].trim();
  if (head && head.toLowerCase() !== 'everything') {
    const [first, ...rest] = head.split(/\s+/);
    const kind = SINGULAR[first.toLowerCase()];
    if (kind) {
      t.kind = kind;
      if (rest.length) t.name = rest.join(' ');
    } else t.name = head;
  }
  return t.name || t.kind || t.in ? t : null;
}

/** One line per step, for the button's tooltip and the editor's preview. */
export function describeStep(s: Step): string {
  const when = s.when ? ` — only if ${targetText(s.when.target)} ${s.when.match === 'any' ? '(any) ' : ''}${s.when.is === 'empty' ? 'is empty' : 'is not empty'}` : '';
  const body = (() => {
    switch (s.do) {
      case 'shuffle':
        return `shuffle ${targetText(s.target)}`;
      case 'deal':
        return `deal ${s.count === 'even' ? 'all evenly' : `${s.count} each`} from ${targetText(s.from)} to players`;
      case 'move':
        return `move ${s.count ? `top ${s.count} of ` : ''}${targetText(s.what)} to ${targetText(s.to)}`;
      case 'gather':
        return `gather all cards into ${targetText(s.target)}`;
      case 'flip':
        return `turn ${targetText(s.target)} face ${s.faceUp ? 'up' : 'down'}`;
      case 'clock':
        return `${s.action} ${targetText(s.target)}`;
      case 'setText':
        return `set ${targetText(s.target)} to “${s.text}”`;
      case 'cycle':
        return `${targetText(s.target)}: next of ${s.values.join(' → ')}`;
      case 'log':
        return `log “${s.text}”`;
      case 'stop':
        return 'stop';
    }
  })();
  return body + when;
}
