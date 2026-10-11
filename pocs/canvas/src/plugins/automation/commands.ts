import { Scratch, isNum, set, type CanvasNode, type Change, type Command, type DocView, type EventSpec, type Store } from '../../core';
import { cardsIn, isCard, isDeck, isHand, isHomeDeck } from '../cards/deck';
import type { DealSeat } from '../cards/commands';
import { clock, isClock } from '../clock/model';
import { isMat, isZone, zoneName } from '../mats/model';
import { FIELD, buttonNode, buttonOf, buttonText, isButton, targetText, validateSteps, validateTrigger, type Cond, type Kind, type Step, type Target, type Trigger } from './model';
import { retroCommand, tienlenCommand } from './presets';

// ------------------------------------------------------------------ target resolution (against the doc as the run left it)

/** The name a target's `name` matches: a zone's name, a button's name, a node's label, else its text's first line. */
export function nameOf(n: CanvasNode): string {
  if (isZone(n)) return zoneName(n);
  if (isButton(n)) return buttonOf(n).name;
  return (n.label ?? n.text?.split('\n')[0] ?? '').trim();
}

const plainText = (n: CanvasNode) => n.type === 'text' && !Object.keys(n).some((k) => k.startsWith('x-'));

export function kindOf(n: CanvasNode): Kind | undefined {
  if (isButton(n)) return 'button';
  if (isCard(n)) return 'card';
  if (isHand(n)) return 'hand';
  if (isZone(n)) return 'zone';
  if (isDeck(n)) return 'deck';
  if (isMat(n)) return 'mat';
  if (isClock(n)) return 'clock';
  if (plainText(n)) return 'text';
  return undefined;
}

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0;
const kindMatches = (n: CanvasNode, k: Kind) => kindOf(n) === k || (k === 'deck' && isDeck(n) && !isHand(n)); // a mat's card zone is also a deck

/** A container (deck, hand, card zone): its cards. An area (mat, free zone, any box): what lies inside it (by center). */
export function contents(doc: DocView, box: CanvasNode): CanvasNode[] {
  if (isDeck(box)) return cardsIn(doc, box.id);
  const inside = (n: CanvasNode) => {
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    return cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
  };
  return doc.visible.filter((n) => n.id !== box.id && !isMat(n) && !isZone(n) && !isButton(n) && inside(n));
}

/** Everything `t` names, in z order. Unknown names resolve to nothing (the step is skipped). */
export function resolve(doc: DocView, t: Target): CanvasNode[] {
  let pool: CanvasNode[];
  if (t.in) {
    const box = doc.nodes.find((n) => sameName(nameOf(n), t.in!) && (isDeck(n) || isZone(n) || isMat(n) || plainText(n) || n.type === 'group'));
    if (!box) return [];
    pool = contents(doc, box);
  } else pool = doc.nodes;
  return pool.filter((n) => (!t.kind || kindMatches(n, t.kind)) && (!t.name || sameName(nameOf(n), t.name)));
}

/** Cards a target stands for: cards as such, the cards of containers. */
function cardsOf(doc: DocView, nodes: CanvasNode[]): CanvasNode[] {
  const out: CanvasNode[] = [];
  const seen = new Set<string>();
  for (const n of nodes) for (const c of isCard(n) ? [n] : isDeck(n) ? cardsIn(doc, n.id) : []) if (!seen.has(c.id) && seen.add(c.id)) out.push(c);
  return out;
}

export function holds(doc: DocView, c: Cond): boolean {
  const nodes = resolve(doc, c.target);
  // a target that resolves to nothing counts as empty (a pile that went away when emptied)
  const empty = (n: CanvasNode) => (isCard(n) ? false : contents(doc, n).length === 0);
  // per match: is it so? then all / any of them ("not-empty, all" = every hand has cards)
  const each = (nodes.length ? nodes.map(empty) : [true]).map((e) => (c.is === 'empty' ? e : !e));
  return c.match === 'any' ? each.some(Boolean) : each.every(Boolean);
}

// ------------------------------------------------------------------ running

export interface RunArgs {
  id: string;
  /** Who's at the table, for "deal to players" (the UI passes the seats; commands know nobody). */
  players?: DealSeat[];
  /** Clock steps: the running device's time (ms epoch). */
  now?: number;
  /** Why it ran, for the log: a click, or the trigger ("a card entered Pile"). */
  cause?: string;
}

const GRID_GAP = 16;

/** One step against the scratch doc. Returns a note when it was skipped, else undefined. */
function runStep(run: Scratch, s: Step, a: RunArgs, notes: string[]): 'stop' | void {
  const doc = run.doc;
  const none = (t: Target) => notes.push(`nothing matches “${targetText(t)}”`);
  switch (s.do) {
    case 'shuffle': {
      const decks = resolve(doc, s.target).filter(isDeck);
      if (!decks.length) return void none(s.target);
      run.call('cards.shuffle', { ids: decks.map((d) => d.id) });
      return;
    }
    case 'deal': {
      const deck = resolve(doc, s.from).find((n) => isDeck(n) && !isHand(n));
      if (!deck) return void none(s.from);
      const players = (a.players ?? []).filter((p) => p && typeof p.id === 'string');
      if (!players.length) return void notes.push('nobody to deal to');
      run.call('cards.dealHands', { id: deck.id, count: s.count, players });
      return;
    }
    case 'move': {
      const what = resolve(doc, s.what);
      const to = resolve(doc, s.to)[0];
      if (!to) return void none(s.to);
      let cards = cardsOf(doc, what).filter((c) => doc.parentOf(c.id) !== to.id);
      if (s.count) cards = cards.slice(-s.count);
      if (cards.length && isDeck(to)) {
        run.call('cards.moveInto', { target: to.id, ids: cards.map((c) => c.id) });
      }
      // other things (notes): laid out in a grid inside the area, below its title
      let others = what.filter((n) => !isCard(n) && !isDeck(n) && !isMat(n) && !isZone(n) && !isButton(n) && !doc.parentOf(n.id) && !contents(doc, to).some((x) => x.id === n.id));
      if (s.count) others = others.slice(-s.count);
      if (others.length && !isDeck(to)) {
        let x = to.x + GRID_GAP;
        let y = to.y + 44;
        let rowH = 0;
        const taken = contents(run.doc, to);
        if (taken.length) y = Math.max(...taken.map((n) => n.y + n.height)) + GRID_GAP;
        for (const n of others) {
          if (x + n.width > to.x + to.width && x > to.x + GRID_GAP) {
            x = to.x + GRID_GAP;
            y += rowH + GRID_GAP;
            rowH = 0;
          }
          run.call('core.move', { ids: [n.id], dx: x - n.x, dy: y - n.y });
          x += n.width + GRID_GAP;
          rowH = Math.max(rowH, n.height);
        }
        run.events.push({ type: 'auto.move', text: `moved ${others.length} to ${nameOf(to)}`, targets: [to.id] });
      }
      if (!cards.length && !others.length) notes.push(`nothing to move from “${targetText(s.what)}”`);
      return;
    }
    case 'gather': {
      const homes = resolve(doc, s.target).filter(isHomeDeck);
      if (!homes.length) return void none(s.target);
      for (const h of homes) run.call('cards.recall', { id: h.id });
      return;
    }
    case 'flip': {
      // cards.face turns visible cards and whole containers (a card inside a pile can't turn alone)
      const ids = resolve(doc, s.target)
        .filter((n) => isDeck(n) || (isCard(n) && doc.isVisible(n.id)))
        .map((n) => n.id);
      if (!ids.length) return void none(s.target);
      run.call('cards.face', { ids, faceUp: s.faceUp });
      return;
    }
    case 'clock': {
      const clocks = resolve(doc, s.target).filter(isClock);
      if (!clocks.length) return void none(s.target);
      const now = isNum(a.now) ? a.now : (run.ctx.now?.() ?? Date.now());
      for (const n of clocks) {
        const c = clock(n);
        const call = (name: string, args: Record<string, unknown>) => run.call(`clock.${name}`, { id: n.id, ...args }, { untracked: true });
        if (s.action === 'reset') call('reset', {});
        else if (s.action === 'pause') {
          if (c.run !== undefined && !c.paused && c.flag === undefined) call('pause', { now });
        } else if (c.paused) call('resume', { now });
        else if (c.flag !== undefined) {
          call('reset', {});
          call('tap', { side: 1, now });
        } else if (c.run === undefined) call('tap', { side: 1, now }); // tapping side 1 starts side 0, like the clock's own Start
      }
      return;
    }
    case 'setText':
    case 'cycle': {
      const notesHit = resolve(doc, s.target).filter(plainText);
      if (!notesHit.length) return void none(s.target);
      for (const n of notesHit) {
        let text: string;
        if (s.do === 'setText') text = s.text;
        else {
          const i = s.values.findIndex((v) => sameName(v, n.text ?? ''));
          text = s.values[(i + 1) % s.values.length];
        }
        run.call('auto.setText', { id: n.id, text });
        run.events.push({ type: 'auto.text', text: `${nameOf(n) || 'a note'} → “${text}”`, targets: [n.id] });
      }
      return;
    }
    case 'log':
      run.events.push({ type: 'auto.log', text: s.text });
      return;
    case 'stop':
      return 'stop';
  }
}

/**
 * Run a button's steps, each against the doc as the steps before it left it: one command, so one
 * undo step, one transaction for the other players, one log entry ("ran ▶ Deal: shuffled…; dealt…").
 * Steps whose targets match nothing are skipped (told in the log). Steps marked `when` run only if
 * their condition holds then; `stop` ends the run.
 */
export function runCommand(store: Store): Command<RunArgs> {
  return (doc, a, ctx) => {
    const b = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
    if (!b || !isButton(b)) return [];
    const { name, steps } = buttonOf(b);
    if (validateSteps(steps).length) return { changes: [], events: [{ type: 'auto.run', text: `tried ▶ ${name}, but its steps are broken (edit it)`, targets: [b.id] }] };
    const run = new Scratch(store, doc, ctx);
    const notes: string[] = [];
    for (const [i, s] of steps.entries()) {
      if (s.when && !holds(run.doc, s.when)) continue;
      const before = notes.length;
      const failed = run.failures.length;
      const r = runStep(run, s, a, notes);
      // a command that threw changed nothing; say so instead of skipping it silently
      for (const f of run.failures.slice(failed)) notes.push(`failed: ${f}`);
      for (let k = before; k < notes.length; k++) notes[k] = `step ${i + 1}: ${notes[k]}`;
      if (r === 'stop') break;
    }
    const told = run.events.map((e) => e.text);
    const body = [...told, ...notes.map((n) => `(${n})`)].join('; ');
    const text = `${a.cause ? `${a.cause} → ` : ''}ran ▶ ${name}${body ? `: ${body}` : ' (nothing to do)'}`;
    const targets = [b.id, ...new Set(run.events.flatMap((e) => e.targets ?? []))];
    const event: EventSpec = { type: 'auto.run', text: text.length > 400 ? `${text.slice(0, 399)}…` : text, targets, cue: 'pulse' };
    return { changes: run.changes, untracked: run.untracked, events: [event] };
  };
}

// ------------------------------------------------------------------ editing buttons

const okName = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : undefined);

/** A new button at (x, y) (top-left). Steps and trigger are validated (invalid = nothing happens). */
export const create: Command<{ x: number; y: number; name: string; steps?: Step[]; trigger?: Trigger }> = (doc, a, ctx) => {
  const name = okName(a?.name);
  const steps = a?.steps ?? [];
  if (!name || !isNum(a.x) || !isNum(a.y) || validateSteps(steps).length || validateTrigger(a.trigger).length) return [];
  const node = buttonNode(ctx.newId(), a.x, a.y, Math.floor(doc.topZ) + 1, { name, steps, trigger: a.trigger?.on === 'click' ? undefined : a.trigger });
  return { changes: [{ op: 'add', node }], select: [node.id] };
};

/** Replace a button's name / steps / trigger (validated as a whole: a bad list changes nothing). */
export const edit: Command<{ id: string; name?: string; steps?: Step[]; trigger?: Trigger | null }> = (doc, a) => {
  const n = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!n || !isButton(n)) return [];
  const cur = buttonOf(n);
  const name = a.name === undefined ? cur.name : okName(a.name);
  const steps = a.steps ?? cur.steps;
  const trigger = a.trigger === undefined ? cur.trigger : a.trigger?.on === 'click' ? undefined : (a.trigger ?? undefined);
  if (!name || validateSteps(steps).length || validateTrigger(trigger).length) return [];
  const changes: Change[] = [];
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (name !== cur.name) changes.push(set(n.id, `${FIELD}.name`, name));
  if (!same(steps, cur.steps)) changes.push(set(n.id, `${FIELD}.steps`, structuredClone(steps)));
  if (!same(trigger, cur.trigger)) changes.push(set(n.id, `${FIELD}.trigger`, trigger ? structuredClone(trigger) : undefined));
  const text = buttonText(name, trigger);
  if (changes.length && text !== n.text) changes.push(set(n.id, 'text', text));
  return changes.length ? { changes, events: [{ type: 'auto.edit', text: `edited ▶ ${name}`, targets: [n.id] }] } : [];
};

/** A plain note's text (what `setText` / `cycle` steps write; core has no generic text edit yet). */
export const setText: Command<{ id: string; text: string }> = (doc, a) => {
  const n = typeof a?.id === 'string' ? doc.get(a.id) : undefined;
  if (!n || !plainText(n) || typeof a.text !== 'string' || a.text.length > 2000 || n.text === a.text) return [];
  return [set(n.id, 'text', a.text)];
};

export const commands = { create, edit, setText };

export function registerAutomationLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`auto.${name}`, cmd as Command);
  store.register('auto.run', runCommand(store) as Command);
  store.register('auto.tienlen', tienlenCommand(store) as Command);
  store.register('auto.retro', retroCommand(store) as Command);
}

