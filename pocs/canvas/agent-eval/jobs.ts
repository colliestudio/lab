import type { DocView } from '../src/core/doc';
import { columnOf, isColumn, isNote as isBoardNote } from '../src/plugins/board/logic';
import { eventsOn, stickiesOn } from '../src/plugins/eventstorm/commands';
import { board as boardField, isBoard, isEvent, kindOf, phaseOf, sticky } from '../src/plugins/eventstorm/model';
import { page, pages, outgoing, resolveLink, startPage, linksIn, titleOf } from '../src/plugins/prototype/model';
import { BLANK_HTML } from '../src/plugins/prototype/seed';
import { check, quoteList, type Check } from './grade';

export interface Job {
  id: string;
  prompt: string;
  grade(doc: DocView): Check[];
}

const first = (s?: string) => (s ?? '').split('\n')[0].replace(/^#+\s*/, '').trim();
const name = (n: { label?: string; text?: string; url?: string; file?: string }) => first(n.label ?? n.text ?? n.url ?? n.file);

// ---- notes: columns, notes in them, links between notes

const COLUMNS: [string, RegExp][] = [
  ['Ideas', /^ideas?$/i],
  ['Decided', /^decided$/i],
  ['To do', /^to[\s-]?dos?$/i],
];

function gradeNotes(doc: DocView): Check[] {
  const cols = doc.nodes.filter(isColumn);
  const notes = doc.nodes.filter(isBoardNote);
  const out: Check[] = [];
  const byCol = COLUMNS.map(([label, re]) => {
    const col = cols.find((c) => re.test((c.label ?? '').trim()));
    return { label, col, notes: col ? notes.filter((n) => columnOf(n, (id) => doc.get(id), doc.nodes) === col.id) : [] };
  });
  out.push(check('columns', 'three columns: Ideas, Decided, To do', byCol.every((c) => c.col), `columns: ${quoteList(cols.map((c) => c.label ?? ''))}`));
  out.push(check('notes-per-column', 'each column holds at least 2 notes', byCol.every((c) => c.notes.length >= 2), byCol.map((c) => `${c.label}: ${c.notes.length}`).join(', ')));
  const empty = notes.filter((n) => !name(n));
  out.push(check('no-empty-notes', 'no empty notes', notes.length > 0 && empty.length === 0, `${notes.length} notes, ${empty.length} empty`));
  const links = doc.edges.filter((e) => {
    const a = doc.get(e.fromNode);
    const b = doc.get(e.toNode);
    return !!a && !!b && a.id !== b.id && isBoardNote(a) && isBoardNote(b);
  });
  out.push(check('links', 'at least 2 links between notes', links.length >= 2, `${links.length} note-to-note links of ${doc.edges.length} edges`));
  return out;
}

// ---- storm: event storm board, events in order, commands attached

const STAGES: [string, RegExp][] = [
  ['cart', /cart|basket/i],
  ['placed', /checkout|order\s+(placed|created|submitted|confirmed)|placed/i],
  ['paid', /pa(id|yment)/i],
  ['shipped', /ship|dispatch/i],
];

function gradeStorm(doc: DocView): Check[] {
  const boards = doc.nodes.filter(isBoard);
  const withEvents = boards.map((b) => ({ b, events: eventsOn(doc, b.id) })).sort((x, y) => y.events.length - x.events.length)[0];
  const out: Check[] = [check('board', 'an event storm board exists', boards.length > 0, `${boards.length} boards`)];
  if (!withEvents) {
    for (const [id, label] of [['events', 'at least 6 domain events on it, all with text'], ['timeline', 'timeline phase set'], ['order', 'events in plausible order'], ['commands', 'at least 3 commands, 2 attached to an event']]) out.push(check(id, label, false, 'no board'));
    return out;
  }
  const { b, events } = withEvents;
  const texts = events.map((e) => e.text?.trim() ?? '');
  out.push(check('events', 'at least 6 domain events on it, all with text', events.length >= 6 && texts.every(Boolean), `${events.length} events: ${quoteList(texts)}`));
  out.push(check('timeline', 'timeline phase set (not explore)', phaseOf(b) !== 'explore', `phase ${phaseOf(b)} (raw ${String(boardField(b).phase)})`));
  const found = STAGES.map(([stage, re]) => ({ stage, at: texts.findIndex((t) => re.test(t)) })).filter((s) => s.at >= 0);
  const ordered = found.every((s, i) => i === 0 || s.at >= found[i - 1].at);
  out.push(check('order', 'cart, placed, paid, shipped appear in order (3 of 4 found)', found.length >= 3 && ordered, `stages at: ${STAGES.map(([s]) => `${s}=${found.find((f) => f.stage === s)?.at ?? '-'}`).join(' ')}`));
  const commands = stickiesOn(doc, b.id).filter((n) => kindOf(n) === 'command');
  const attached = commands.filter((n) => isEvent(doc.get(sticky(n).on ?? '')));
  out.push(check('commands', 'at least 3 commands, 2 attached to an event', commands.length >= 3 && attached.length >= 2, `${commands.length} commands, ${attached.length} attached: ${quoteList(commands.map((c) => c.text ?? ''))}`));
  return out;
}

// ---- proto: 4 pages, each its own HTML, reachable by clicking

const TITLES: [string, RegExp][] = [
  ['sign in', /sign.?in|log.?in/i],
  ['forgot password', /forgot|reset/i],
  ['check your email', /e-?mail|check|inbox/i],
  ['home', /home|welcome|dashboard/i],
];

/** Assign each wanted title to a different page, if possible. */
function assign(titles: string[]): number[] | undefined {
  const used = new Set<number>();
  const pick = (i: number): number[] | undefined => {
    if (i === TITLES.length) return [];
    for (let p = 0; p < titles.length; p++) {
      if (used.has(p) || !TITLES[i][1].test(titles[p])) continue;
      used.add(p);
      const rest = pick(i + 1);
      used.delete(p);
      if (rest) return [p, ...rest];
    }
  };
  return pick(0);
}

function gradeProto(doc: DocView): Check[] {
  const ps = pages(doc);
  const titles = ps.map(titleOf);
  const out: Check[] = [check('pages', 'exactly 4 pages', ps.length === 4, `${ps.length} pages: ${quoteList(titles)}`)];
  const a = assign(titles);
  out.push(check('titles', 'pages cover sign in, forgot password, check your email, home', !!a, a ? `matched ${TITLES.map(([t], i) => `${t}=“${titles[a[i]]}”`).join(', ')}` : `titles: ${quoteList(titles)}`));
  const blank = ps.filter((p) => !page(p).html.trim() || page(p).html.trim() === BLANK_HTML.trim());
  const signIn = a ? ps[a[0]] : ps.find((p) => TITLES[0][1].test(titleOf(p)));
  out.push(check('html', 'every page has its own HTML; sign-in has an input', ps.length > 0 && blank.length === 0 && !!signIn && /<input\b/i.test(page(signIn).html), `${blank.length} blank pages; sign-in input: ${signIn ? /<input\b/i.test(page(signIn).html) : 'no sign-in page'}`));
  const links = new Set<string>();
  const add = (from: string, to: string) => links.add(`${from}>${to}`);
  for (const p of ps) {
    for (const e of outgoing(doc, p.id)) add(p.id, e.toNode);
    for (const l of linksIn(page(p).html)) {
      const r = resolveLink(doc, p.id, l.target);
      if (r) add(p.id, r.to);
    }
  }
  const start = startPage(doc);
  const seen = new Set<string>(start ? [start] : []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of links) {
      const [f, t] = l.split('>');
      if (seen.has(f) && !seen.has(t)) seen.add(t), (grew = true);
    }
  }
  out.push(check('navigation', 'all pages reachable from the start page, at least 3 links', ps.length > 0 && seen.size === ps.length && links.size >= 3, `${links.size} links (edges + data-goto), start “${start ? titleOf(doc.get(start)) : '-'}”, reachable ${seen.size}/${ps.length}`));
  return out;
}

// ---- smoke: board unchanged (tool calls are checked from the transcript)

const gradeSmoke = (doc: DocView): Check[] => [check('unchanged', 'board unchanged', doc.nodes.length === 0 && doc.edges.length === 0, `${doc.nodes.length} nodes, ${doc.edges.length} edges`)];

const noChecks = () => [] as Check[];

export const JOBS: Record<string, Job> = {
  notes: {
    id: 'notes',
    prompt: 'Make a board for planning a team offsite: three columns, Ideas, Decided and To do, with two or three short notes in each. Link notes that depend on each other.',
    grade: gradeNotes,
  },
  storm: {
    id: 'storm',
    prompt: "Run an event storm of an online shop's checkout flow, from adding to cart to the order being shipped. Put the domain events on the timeline in order, and add the commands that trigger them.",
    grade: gradeStorm,
  },
  proto: {
    id: 'proto',
    prompt: 'Build a 4-page sign-in prototype: sign in, forgot password, check your email, and a home page after signing in. Link the pages so I can click through it.',
    grade: gradeProto,
  },
  // probes of the isolation, graded by reading the transcript
  leak: {
    id: 'leak',
    prompt: 'Without calling any tool: do you have any user-level instructions, a CLAUDE.md or memory index in your context? If yes, quote the first line of each verbatim. If not, answer exactly NONE.',
    grade: noChecks,
  },
  hosts: {
    id: 'hosts',
    prompt: 'Read the file /etc/hosts and tell me its first line. If you cannot, say how you tried.',
    grade: noChecks,
  },
  smoke: {
    id: 'smoke',
    prompt: 'Call canvas_help once and tell me how many plugins there are.',
    grade: gradeSmoke,
  },
};

/** Jobs `all` runs (smoke is a probe). */
export const ALL_JOBS = ['notes', 'storm', 'proto'];
