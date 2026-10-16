import type { CanvasNode, DocView } from '../src/core';
import { columnOf, isColumn, isNote as isBoardNote } from '../src/plugins/board/logic';
import { eventsOn, stickiesOn } from '../src/plugins/eventstorm/commands';
import { board as boardField, isBoard, isEvent, kindOf, phaseOf, sticky } from '../src/plugins/eventstorm/model';
import { frameAt, isFrame } from '../src/plugins/frames/model';
import { isShape } from '../src/plugins/diagram/model';
import { page, pages, outgoing, resolveLink, startPage, titleOf } from '../src/plugins/prototype/model';
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

// Outcome wording, so "Shipping address entered" or "Payment details entered" are not the shipped / paid stage.
const STAGES: [string, RegExp][] = [
  ['cart', /cart|basket/i],
  ['placed', /order\s+(placed|created|submitted|confirmed)|\bplaced\b|checkout\s+(completed|submitted|finished)/i],
  ['paid', /\bpaid\b|payment\s+(received|captured|authori[sz]ed|succeeded|completed|confirmed|taken|accepted)|\bcharged\b/i],
  ['shipped', /\b(shipped|dispatched)\b|handed\s+(over\s+)?to\s+(the\s+)?carrier/i],
];

function gradeStorm(doc: DocView): Check[] {
  const boards = doc.nodes.filter(isBoard);
  const withEvents = boards.map((b) => ({ b, events: eventsOn(doc, b.id) })).sort((x, y) => y.events.length - x.events.length)[0];
  const out: Check[] = [check('board', 'an event storm board exists', boards.length > 0, `${boards.length} boards`)];
  if (!withEvents) {
    for (const [id, label] of [['events', 'at least 5 domain events on it, all with text'], ['timeline', 'timeline phase set'], ['order', 'events in plausible order'], ['commands', 'at least 3 commands, 2 attached to an event']]) out.push(check(id, label, false, 'no board'));
    return out;
  }
  const { b, events } = withEvents;
  const texts = events.map((e) => e.text?.trim() ?? '');
  out.push(check('events', 'at least 5 domain events on it, all with text', events.length >= 5 && texts.every(Boolean), `${events.length} events: ${quoteList(texts)}`));
  out.push(check('timeline', 'timeline phase set (not explore)', phaseOf(b) !== 'explore', `phase ${phaseOf(b)} (raw ${String(boardField(b).phase)})`));
  const found = STAGES.map(([stage, re]) => ({ stage, at: texts.findIndex((t) => re.test(t)) })).filter((s) => s.at >= 0);
  const at = (stage: string) => found.find((f) => f.stage === stage)?.at;
  // Placed and paid in either order: "Order confirmed" is often logged after "Payment authorized".
  const before = (a: string, b: string) => at(a) === undefined || at(b) === undefined || at(a)! < at(b)!;
  const ordered = before('cart', 'placed') && before('cart', 'paid') && before('placed', 'shipped') && before('paid', 'shipped');
  out.push(check('order', 'cart first, shipped last, placed and paid between in either order (3 of 4 found)', found.length >= 3 && ordered, `stages at: ${STAGES.map(([s]) => `${s}=${found.find((f) => f.stage === s)?.at ?? '-'}`).join(' ')}`));
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

/** Assign each wanted pattern to a different title, if possible. */
function assign(titles: string[], wanted: [string, RegExp][] = TITLES): number[] | undefined {
  const used = new Set<number>();
  const pick = (i: number): number[] | undefined => {
    if (i === wanted.length) return [];
    for (let p = 0; p < titles.length; p++) {
      if (used.has(p) || !wanted[i][1].test(titles[p])) continue;
      used.add(p);
      const rest = pick(i + 1);
      used.delete(p);
      if (rest) return [p, ...rest];
    }
  };
  return pick(0);
}

/** The `data-goto` values in a page's HTML, any element. */
const gotoTargets = (html: string) => [...html.matchAll(/\bdata-goto\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => (m[1] ?? m[2]).trim());

/** Dead anchors: `<a href="#…">` with no data-goto, data-back or onclick (clicking sets location.hash and does nothing). */
function deadAnchors(html: string): number {
  return [...html.matchAll(/<a\b[^>]*>/gi)].filter((m) => /\bhref\s*=\s*["']#/i.test(m[0]) && !/\b(data-goto|data-back|onclick)\b/i.test(m[0])).length;
}

/** Links inside the pages: `p>to` for every data-goto that resolves, and those that don't. */
function inPageLinks(doc: DocView) {
  const edges = new Set<string>();
  const broken: { page: string; target: string }[] = [];
  for (const p of pages(doc)) {
    for (const target of gotoTargets(page(p).html)) {
      const r = resolveLink(doc, p.id, target);
      if (r) edges.add(`${p.id}>${r.to}`);
      else broken.push({ page: titleOf(p), target });
    }
  }
  return { edges, broken };
}

/** Pages reachable from `start` over `p>to` links. */
function reach(start: string | undefined, edges: Iterable<string>): Set<string> {
  const seen = new Set<string>(start ? [start] : []);
  const list = [...edges].map((l) => l.split('>'));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [f, t] of list) if (seen.has(f) && !seen.has(t)) seen.add(t), (grew = true);
  }
  return seen;
}

/** Page P can go back: a data-back element, a data-goto to `prev`, or canvas.back() in a script. */
function backOk(doc: DocView, p: CanvasNode, prev: CanvasNode): boolean {
  const html = page(p).html;
  if (/\bdata-back\b/i.test(html) || /\bcanvas\s*\.\s*back\s*\(/.test(html)) return true;
  return gotoTargets(html).some((t) => resolveLink(doc, p.id, t)?.to === prev.id);
}

/** State keys a page writes (data-store, canvas.set) and shows (data-show, canvas.state). */
function stateKeys(html: string) {
  const writes = new Set<string>();
  const shows = new Set<string>();
  for (const m of html.matchAll(/\bdata-store\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) writes.add((m[1] ?? m[2]).trim());
  for (const m of html.matchAll(/\bcanvas\s*\.\s*set\s*\(\s*(?:"([^"]*)"|'([^']*)')/g)) writes.add(m[1] ?? m[2]);
  for (const m of html.matchAll(/\bdata-show\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) shows.add((m[1] ?? m[2]).trim());
  for (const m of html.matchAll(/\bcanvas\s*\.\s*state\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(?:"([^"]*)"|'([^']*)')\s*\])/g)) shows.add(m[1] ?? m[2] ?? m[3]);
  writes.delete('');
  shows.delete('');
  return { writes: [...writes], shows: [...shows] };
}

const startCheck = (doc: DocView, want: CanvasNode | undefined, wantLabel: string): Check => {
  const flagged = pages(doc).find((p) => page(p).start);
  const fallback = startPage(doc);
  return check('start', `the start page is ${wantLabel}`, !!flagged && !!want && flagged.id === want.id, flagged ? `start “${titleOf(flagged)}”${want && flagged.id !== want.id ? ` (want “${titleOf(want)}”)` : ''}` : `no start page set (Play would start at “${fallback ? titleOf(doc.get(fallback)) : '-'}”)`);
};

function brokenCheck(doc: DocView, info: boolean): Check {
  const { broken } = inPageLinks(doc);
  const dead = pages(doc).map((p) => ({ t: titleOf(p), n: deadAnchors(page(p).html) })).filter((d) => d.n);
  const parts = [...broken.map((b) => `“${b.page}” → “${b.target}”`), ...dead.map((d) => `“${d.t}”: ${d.n} <a href="#"> without data-goto`)];
  return check('no-broken-links', 'no data-goto that finds no page, no <a href="#"> that does nothing', pages(doc).length > 0 && !parts.length, parts.length ? parts.join('; ') : 'none', info);
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
  out.push(startCheck(doc, signIn, 'the sign-in page'));
  // Not covered: unquoted data-goto or inline canvas.goto() calls.
  const { edges: inPage } = inPageLinks(doc);
  const start = startPage(doc);
  const byLinks = reach(start, inPage);
  const unreachable = ps.filter((p) => !byLinks.has(p.id)).map(titleOf);
  out.push(check('in-page-links', 'every page is reachable from the start page by clicking links inside the pages (data-goto)', ps.length > 0 && !unreachable.length, `${inPage.size} resolving data-goto links; reachable ${byLinks.size}/${ps.length}${unreachable.length ? `; unreachable ${quoteList(unreachable)}` : ''}`));
  out.push(brokenCheck(doc, false));
  // What Play's chips add: the page's outgoing arrows.
  const arrows = new Set(ps.flatMap((p) => outgoing(doc, p.id).map((e) => `${e.fromNode}>${e.toNode}`)));
  const byPlay = reach(start, [...inPage, ...arrows]);
  out.push(check('navigation', 'clicking through in Play (arrows or data-goto) reaches all pages from the start page', ps.length > 0 && byPlay.size === ps.length, `${arrows.size} arrows, ${inPage.size} resolving data-goto links, start “${start ? titleOf(doc.get(start)) : '-'}”, reachable ${byPlay.size}/${ps.length}`, true));
  const withEdge = ps.flatMap((p) => gotoTargets(page(p).html).map((t) => resolveLink(doc, p.id, t))).filter((r) => r);
  out.push(check('arrows', 'every resolving data-goto has an arrow on the canvas', withEdge.every((r) => r!.edge), `${withEdge.filter((r) => r!.edge).length}/${withEdge.length} have an arrow`, true));
  return out;
}

// ---- checkout: 4 pages, forward and back links, a form whose value shows on the last page

const CHECKOUT: [string, RegExp][] = [
  ['cart', /cart|basket|bag/i],
  ['shipping', /ship|address|deliver/i],
  ['payment', /pay|card|billing/i],
  ['confirmation', /confirm|thank|success|order|done/i],
];

function gradeCheckout(doc: DocView): Check[] {
  const ps = pages(doc);
  const titles = ps.map(titleOf);
  const out: Check[] = [check('pages', 'exactly 4 pages', ps.length === 4, `${ps.length} pages: ${quoteList(titles)}`)];
  const a = assign(titles, CHECKOUT);
  out.push(check('titles', 'pages cover cart, shipping, payment, confirmation', !!a, a ? `matched ${CHECKOUT.map(([t], i) => `${t}=“${titles[a[i]]}”`).join(', ')}` : `titles: ${quoteList(titles)}`));
  if (!a) {
    for (const [id, label] of [['start', 'the start page is the cart'], ['forward', 'shipping, payment and confirmation reachable from the start by clicking links in the pages'], ['back', 'shipping and payment each have a working back'], ['state', 'a value entered on shipping is shown on confirmation']]) out.push(check(id, label, false, 'pages not matched'));
    out.push(brokenCheck(doc, true));
    return out;
  }
  const [cart, ship, pay, conf] = a.map((i) => ps[i]);
  out.push(startCheck(doc, cart, 'the cart'));
  const { edges } = inPageLinks(doc);
  const seen = reach(cart.id, edges);
  const missing = [ship, pay, conf].filter((p) => !seen.has(p.id)).map(titleOf);
  out.push(check('forward', 'shipping, payment and confirmation reachable from the cart by clicking links in the pages (data-goto)', !missing.length, missing.length ? `not reachable: ${quoteList(missing)}` : `reachable ${seen.size}/4`));
  const noBack = [[ship, cart], [pay, ship]].filter(([p, prev]) => !backOk(doc, p, prev)).map(([p]) => titleOf(p));
  out.push(check('back', 'shipping and payment each have a working back (data-back, data-goto to the previous step, or canvas.back())', !noBack.length, noBack.length ? `no back on ${quoteList(noBack)}` : 'both have one'));
  const w = stateKeys(page(ship).html).writes;
  const sh = stateKeys(page(conf).html).shows;
  const common = w.filter((k) => sh.includes(k));
  out.push(check('state', 'a value entered on shipping is shown on confirmation (data-store / data-show, or canvas.set / canvas.state)', common.length > 0, `shipping writes ${w.join(', ') || '-'}; confirmation shows ${sh.join(', ') || '-'}`));
  out.push(brokenCheck(doc, true));
  return out;
}

// ---- arch: architecture diagram of diagram shapes and labeled arrows, inside a frame

const PARTS: [string, RegExp][] = [
  ['client', /browser|client|front.?end|web\s*app|\bspa\b|mobile/i],
  ['api', /\bapi\b|server|back.?end|gateway|service/i],
  ['database', /database|\bdb\b|postgres|mysql|sql|mongo|dynamo/i],
  ['cache', /cache|redis|memcache/i],
];

function gradeArch(doc: DocView): Check[] {
  const frames = doc.nodes.filter(isFrame);
  const arch = frames.filter((f) => /architecture/i.test(f.label ?? ''));
  const shapes = doc.nodes.filter((n) => isShape(n) && (n.text ?? '').trim());
  const texts = shapes.map((n) => first(n.text));
  const scenes = doc.nodes.filter((n) => n['x-excalidraw'] !== undefined).length;
  const plain = doc.nodes.filter((n) => n.type === 'text' && !isShape(n) && n['x-excalidraw'] === undefined).length;
  const out: Check[] = [check('frame', 'a frame titled Architecture', arch.length > 0, `frames: ${quoteList(frames.map((f) => f.label ?? ''))}`)];
  if (!shapes.length) {
    for (const [id, label] of [['components', 'shapes for a client, an API server, a database and a cache'], ['in-frame', 'every shape inside the Architecture frame'], ['connected', 'at least 3 arrows between shapes, the four components connected'], ['labeled', 'at least 3 arrows, each with a label']]) out.push(check(id, label, false, scenes ? `drew in Excalidraw (${scenes} scene${scenes === 1 ? '' : 's'}), not diagram shapes` : `no diagram shapes (${plain} other text nodes)`));
    return out;
  }
  const a = assign(texts, PARTS);
  out.push(check('components', 'shapes for a client, an API server, a database and a cache', !!a, a ? `matched ${PARTS.map(([t], i) => `${t}=“${texts[a[i]]}”`).join(', ')}` : `shapes: ${quoteList(texts)}${shapes.length < 4 ? `; ${plain} other text nodes` : ''}`));
  const inArch = (id: string) => {
    for (let cur: string | undefined = id, i = 0; cur && i < 20; i++) {
      const n = doc.get(cur);
      cur = n && frameAt(n, doc.nodes);
      if (cur && arch.some((f) => f.id === cur)) return true;
    }
    return false;
  };
  const outside = shapes.filter((n) => !inArch(n.id));
  out.push(check('in-frame', 'every shape inside the Architecture frame', arch.length > 0 && outside.length === 0, arch.length ? `${shapes.length - outside.length}/${shapes.length} inside${outside.length ? `; outside: ${quoteList(outside.map((n) => first(n.text)))}` : ''}` : 'no Architecture frame'));
  const ids = new Set(shapes.map((n) => n.id));
  const arrows = doc.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode) && e.fromNode !== e.toNode);
  const adj = new Map<string, string[]>();
  const link = (x: string, y: string) => adj.set(x, [...(adj.get(x) ?? []), y]);
  for (const e of arrows) link(e.fromNode, e.toNode), link(e.toNode, e.fromNode);
  let linked = false;
  if (a) {
    const seen = new Set<string>([shapes[a[0]].id]);
    for (const queue = [shapes[a[0]].id]; queue.length; ) for (const m of adj.get(queue.pop()!) ?? []) if (!seen.has(m)) seen.add(m), queue.push(m);
    linked = a.every((i) => seen.has(shapes[i].id));
  }
  out.push(check('connected', 'at least 3 arrows between shapes, the four components connected', arrows.length >= 3 && linked, `${arrows.length} shape-to-shape arrows of ${doc.edges.length} edges; components connected: ${a ? linked : 'components not found'}`));
  const unlabeled = arrows.filter((e) => !(e.label ?? '').trim());
  out.push(check('labeled', 'at least 3 arrows, each with a label', arrows.length >= 3 && unlabeled.length === 0, `${arrows.length - unlabeled.length}/${arrows.length} labeled: ${quoteList(arrows.map((e) => e.label ?? ''))}`));
  const overlaps: string[] = [];
  for (let i = 0; i < shapes.length; i++)
    for (let j = i + 1; j < shapes.length; j++) {
      const p = shapes[i];
      const q = shapes[j];
      if (p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height) overlaps.push(`“${first(p.text)}” / “${first(q.text)}”`);
    }
  out.push(check('no-overlap', 'no two shapes overlap', overlaps.length === 0, overlaps.length ? overlaps.join(', ') : 'none', true));
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
  checkout: {
    id: 'checkout',
    prompt: "Build a clickable checkout prototype: a cart page, a shipping page with a form for the customer's name and address, a payment page, and an order confirmation page that greets the customer by the name they entered. Every step after the cart has a back button.",
    grade: gradeCheckout,
  },
  arch: {
    id: 'arch',
    prompt: 'Draw a small architecture diagram of a web app inside a frame titled "Architecture": a browser client, an API server, a database and a cache. Connect them with arrows, each labeled with what flows along it.',
    grade: gradeArch,
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
export const ALL_JOBS = ['notes', 'storm', 'proto', 'checkout', 'arch'];
