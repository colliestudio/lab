import { describe, expect, it } from 'vitest';
import { Store, serialize, type CommandCtx } from '../src/core';
import { registerCoreCommands } from '../src/core/commands';
import { registerPluginLogic } from '../src/plugins/logic';
import { loadDoc } from './grade';
import { JOBS } from './jobs';

function store() {
  let n = 0;
  const ctx: CommandCtx = { newId: () => `id${++n}`, random: () => 0.5, now: () => 1000 };
  const s = new Store({ ctx });
  registerCoreCommands(s);
  registerPluginLogic(s);
  s.actor = () => ({ id: 'agent', name: 'Agent', color: '#d97757' });
  return s;
}
const text = (s: Store) => serialize(s.exportDoc());
const grade = (job: string, s: Store | string) => JOBS[job].grade(loadDoc(typeof s === 'string' ? s : text(s)));
const failed = (job: string, s: Store | string) => grade(job, s).filter((c) => !c.pass && !c.info).map((c) => c.id);

// ---- notes

function notes(o: { columns?: string[]; skip?: string; outside?: boolean; links?: number; empty?: boolean } = {}) {
  const s = store();
  const cols = o.columns ?? ['Ideas', 'Decided', 'To do'];
  cols.forEach((label, i) => s.dispatch('board.add', { id: `c${i}`, type: 'group', label, x: i * 400, y: 0 }));
  const ids: string[] = [];
  cols.forEach((_, i) => {
    for (let k = 0; k < 2; k++) {
      const id = `n${i}${k}`;
      ids.push(id);
      if (o.skip === id) continue;
      s.dispatch('board.add', o.outside && id === 'n00' ? { id, text: 'Loose', x: 3000, y: 3000 } : { id, text: o.empty && id === 'n01' ? ' ' : `Note ${id}`, column: `c${i}` });
    }
  });
  for (let i = 0; i < (o.links ?? 2); i++) s.dispatch('board.connect', { from: ids[i], to: ids[i + 2] });
  return s;
}

describe('notes grader', () => {
  it('passes a board built by the board commands', () => {
    expect(failed('notes', notes())).toEqual([]);
  });
  it('fails a missing column, a note outside its column, no links, an empty note', () => {
    expect(failed('notes', notes({ columns: ['Ideas', 'Decided'] }))).toContain('columns');
    expect(failed('notes', notes({ skip: 'n01' }))).toContain('notes-per-column');
    expect(failed('notes', notes({ outside: true }))).toContain('notes-per-column');
    expect(failed('notes', notes({ links: 0 }))).toEqual(['links']);
    expect(failed('notes', notes({ empty: true }))).toContain('no-empty-notes');
  });
  it('accepts label variants (case, To-do)', () => {
    expect(failed('notes', notes({ columns: ['IDEAS', 'decided ', 'To-do'] }))).toEqual([]);
  });
  it('grades hand-written JSON the same: the structure counts, not the commands used', () => {
    const col = (id: string, label: string, x: number) => ({ id, type: 'group', label, x, y: 0, width: 300, height: 400 });
    const note = (id: string, t: string, x: number) => ({ id, type: 'text', text: t, x, y: 50, width: 200, height: 60 });
    const raw = JSON.stringify({
      nodes: [col('a', 'Ideas', 0), col('b', 'Decided', 400), col('c', 'To do', 800), note('1', 'x', 10), note('2', 'y', 10), note('3', 'z', 410), note('4', 'w', 410), note('5', 'v', 810), note('6', 'u', 810)],
      edges: [{ id: 'e1', fromNode: '1', toNode: '3' }, { id: 'e2', fromNode: '3', toNode: '5' }],
    });
    expect(failed('notes', raw)).toEqual([]);
  });
});

// ---- storm

const EVENTS = ['Item added to cart', 'Checkout started', 'Order placed', 'Payment received', 'Order packed', 'Order shipped'];

function storm(o: { events?: string[]; phase?: string; commands?: 'attached' | 'loose' | 'none'; noBoard?: boolean } = {}) {
  const s = store();
  if (o.noBoard) {
    (o.events ?? EVENTS).forEach((t, i) => s.dispatch('board.add', { id: `e${i}`, text: t }));
    return s;
  }
  const b = s.dispatch('storm.createBoard', { x: 0, y: 0 }).select![0];
  let prev: string | undefined;
  for (const t of o.events ?? EVENTS) prev = s.dispatch('storm.add', { board: b, kind: 'event', text: t, ...(prev ? { after: prev } : {}) }).select![0];
  s.dispatch('storm.phase', { board: b, phase: o.phase ?? 'process' });
  const evs = [...s.doc.riders(b)].filter((n) => (n as any)['x-storm']?.st === 'event').sort((x, y) => x.x - y.x);
  if (o.commands !== 'none')
    ['Add to cart', 'Start checkout', 'Place order'].forEach((t, i) => s.dispatch('storm.add', { board: b, kind: 'command', text: t, ...(o.commands === 'loose' ? { x: 200 + i * 200, y: 100 } : { on: evs[i].id }) }));
  return s;
}

describe('storm grader', () => {
  it('passes a storm built by the storm commands', () => {
    expect(failed('storm', storm())).toEqual([]);
  });
  it('fails without a board, with events loose on the canvas', () => {
    expect(failed('storm', storm({ noBoard: true }))).toContain('board');
  });
  it('fails the explore phase', () => {
    expect(failed('storm', storm({ phase: 'explore', commands: 'none' }))).toContain('timeline');
  });
  it('fails a reversed order, fine with synonyms', () => {
    expect(failed('storm', storm({ events: [...EVENTS].reverse() }))).toContain('order');
    expect(failed('storm', storm({ events: ['Product added to basket', 'Checkout submitted', 'Order created', 'Payment authorised', 'Parcel dispatched', 'Delivered'] }))).toEqual([]);
  });
  it('early events with shipping / payment words do not count as shipped / paid', () => {
    const events = ['Item added to cart', 'Shipping address entered', 'Payment details entered', 'Order placed', 'Payment captured', 'Order shipped'];
    expect(failed('storm', storm({ events }))).toEqual([]);
  });
  it('accepts placed and paid in either order, still checks cart first and shipped last', () => {
    expect(failed('storm', storm({ events: ['Item added to cart', 'Checkout started', 'Payment authorized', 'Order confirmed', 'Order packed', 'Order shipped'] }))).toEqual([]);
    expect(failed('storm', storm({ events: ['Order shipped', 'Order placed', 'Payment received', 'Item added to cart', 'Checkout started', 'Order packed'] }))).toContain('order');
    expect(failed('storm', storm({ events: ['Item added to cart', 'Order shipped', 'Order placed', 'Payment received', 'Checkout started'] }))).toContain('order');
    expect(failed('storm', storm({ events: ['Payment received', 'Item added to cart', 'Order placed', 'Checkout started', 'Order shipped'] }))).toContain('order');
  });
  it('five events are enough, four are not', () => {
    expect(failed('storm', storm({ events: ['Item added to cart', 'Checkout started', 'Order placed', 'Payment received', 'Order shipped'] }))).toEqual([]);
  });
  it('fails too few events and commands that are not attached', () => {
    expect(failed('storm', storm({ events: EVENTS.slice(0, 4) }))).toContain('events');
    const f = failed('storm', storm({ commands: 'loose', phase: 'process' }));
    expect(f).toContain('commands');
  });
  it('fails missing commands', () => {
    expect(failed('storm', storm({ commands: 'none' }))).toEqual(['commands']);
  });
});

// ---- proto

const PAGES = [
  ['Sign in', '<h1>Sign in</h1><input name="email"><button data-goto="Home">Sign in</button><a data-goto="Forgot password">Forgot?</a>'],
  ['Forgot password', '<h1>Forgot</h1><input><button data-goto="Check your email">Send</button>'],
  ['Check your email', '<h1>Check your email</h1><a data-goto="Sign in">Back</a>'],
  ['Home', '<h1>Welcome</h1>'],
];

function proto(o: { pages?: string[][]; edges?: [number, number][]; blank?: boolean; start?: number | false } = {}) {
  const s = store();
  const ids = (o.pages ?? PAGES).map(([title, html], i) => s.dispatch('page.create', { x: i * 400, y: 0, title, ...(o.blank && i === 3 ? {} : { html }) }).select![0]);
  for (const [a, b] of o.edges ?? []) s.dispatch('page.link', { from: ids[a], to: ids[b] });
  if (o.start !== false) s.dispatch('page.start', { id: ids[o.start ?? 0] });
  return s;
}

const EDGES: [number, number][] = [[0, 1], [1, 2], [0, 3]];
const ALL_EDGES: [number, number][] = [...EDGES, [2, 0]];
const bare = PAGES.map(([t]) => [t, `<h1>${t}</h1><input><a href="#x">go</a>`]);
const info = (job: string, s: Store | string) => Object.fromEntries(grade(job, s).filter((c) => c.info).map((c) => [c.id, c.pass]));
const detail = (job: string, s: Store | string, id: string) => grade(job, s).find((c) => c.id === id)!.detail;

describe('proto grader', () => {
  it('an in-page #id anchor with a target is not dead; one without a target, or a bare #, is', () => {
    const withAnchor = (a: string) => PAGES.map(([t, h], i) => [t, i === 3 ? `${h}${a}` : h]);
    expect(failed('proto', proto({ pages: withAnchor('<a href="#faq">FAQ</a><section id="faq"></section>') }))).toEqual([]);
    expect(failed('proto', proto({ pages: withAnchor('<a href="#faq">FAQ</a>') }))).toEqual(['no-broken-links']);
    expect(failed('proto', proto({ pages: withAnchor('<a href="#faq">FAQ</a><input name="faq"><i data-id="faq"></i>') }))).toEqual(['no-broken-links']);
    expect(failed('proto', proto({ pages: withAnchor('<a href="#faq">FAQ</a><a name="faq"></a>') }))).toEqual([]);
    expect(failed('proto', proto({ pages: withAnchor('<a href="#">x</a>') }))).toEqual(['no-broken-links']);
  });
  it('passes links in the pages, a start page and arrows: 6 required, both info pass', () => {
    const s = proto({ edges: ALL_EDGES });
    expect(failed('proto', s)).toEqual([]);
    expect(grade('proto', s).filter((c) => !c.info)).toHaveLength(6);
    expect(info('proto', s)).toEqual({ navigation: true, arrows: true });
  });
  it('data-goto alone is enough: resolveLink needs no arrow (the arrows info says so)', () => {
    const s = proto();
    expect(failed('proto', s)).toEqual([]);
    expect(info('proto', s)).toEqual({ navigation: true, arrows: false });
    expect(detail('proto', s, 'arrows')).toBe('0/4 have an arrow');
  });
  it('arrows alone no longer pass: the pages must link (href="#" does nothing); navigation (info) still passes', () => {
    const s = proto({ pages: bare, edges: EDGES });
    expect(failed('proto', s)).toEqual(['in-page-links', 'no-broken-links']);
    expect(info('proto', s)).toMatchObject({ navigation: true });
    expect(detail('proto', s, 'no-broken-links')).toContain('“Sign in”: 1 <a href="#"> without data-goto');
  });
  it('info checks do not count toward pass or x/y', async () => {
    const { summarize } = await import('./summary');
    const { parseStream } = await import('./stream');
    const s = summarize(parseStream([]), grade('proto', proto({ pages: bare, edges: EDGES })), { run: 'r', job: 'proto', head: 'h', dirty: false, model: 'm', startedAt: 's', durationMs: 1 });
    expect([s.passed, s.total, s.pass]).toEqual([4, 6, false]);
    const ok = summarize(parseStream([]), grade('proto', proto()), { run: 'r', job: 'proto', head: 'h', dirty: false, model: 'm', startedAt: 's', durationMs: 1 });
    expect([ok.passed, ok.total, ok.pass]).toEqual([6, 6, true]);
  });
  it('fails 3 pages, blank HTML, no links at all', () => {
    expect(failed('proto', proto({ pages: PAGES.slice(0, 3) }))).toContain('pages');
    expect(failed('proto', proto({ blank: true }))).toContain('html');
    expect(failed('proto', proto({ pages: bare }))).toEqual(['in-page-links', 'no-broken-links']);
  });
  it('a data-goto that finds no page is a broken link, named', () => {
    const p = PAGES.map(([t, h]) => [t, h.replace('data-goto="Home"', 'data-goto="Hoem"')]);
    const s = proto({ pages: p });
    expect(failed('proto', s)).toEqual(['in-page-links', 'no-broken-links']);
    expect(detail('proto', s, 'no-broken-links')).toBe('“Sign in” → “Hoem”');
  });
  it('start: unset names the fallback; another page names it', () => {
    expect(failed('proto', proto({ start: false }))).toEqual(['start']);
    expect(detail('proto', proto({ start: false }), 'start')).toBe('no start page set (Play would start at “Sign in”)');
    expect(failed('proto', proto({ start: 3 }))).toContain('start');
    expect(detail('proto', proto({ start: 3 }), 'start')).toBe('start “Home” (want “Sign in”)');
  });
  it('an empty data-goto follows the only outgoing arrow; with two arrows it is broken', () => {
    const p = [['Sign in', '<input><button data-goto="">Go</button>'], ['Forgot password', '<input><button data-goto="">Go</button>'], ['Check your email', '<button data-goto="">Go</button>'], ['Home', '<h1>Welcome</h1>']];
    expect(failed('proto', proto({ pages: p, edges: [[0, 1], [1, 2], [2, 3]] }))).toEqual([]);
    expect(failed('proto', proto({ pages: p, edges: [[0, 1], [0, 2], [1, 2], [2, 3]] }))).toContain('no-broken-links');
  });
  it('a 4th page only an arrow reaches fails in-page-links; navigation (info) passes', () => {
    const p = PAGES.map(([t, h]) => [t, h.replace(/data-goto="Home"/, 'data-goto="Forgot password"')]);
    const s = proto({ pages: p, edges: [[0, 3]] });
    expect(failed('proto', s)).toEqual(['in-page-links']);
    expect(detail('proto', s, 'in-page-links')).toContain('unreachable “Home”');
    expect(info('proto', s).navigation).toBe(true);
  });
  it('fails a missing sign-in input', () => {
    const p = PAGES.map(([t, h], i) => [t, i === 0 ? h.replace('<input name="email">', '') : h]);
    expect(failed('proto', proto({ pages: p, edges: EDGES }))).toEqual(['html']);
  });
});

// ---- checkout

const CART = ['Cart', '<h1>Cart</h1><button data-goto="Shipping">Checkout</button>'];
const SHIP = ['Shipping', '<h1>Shipping</h1><input data-store="name"><input data-store="address"><button data-back>Back</button><button data-goto="Payment">Next</button>'];
const PAY = ['Payment', '<h1>Payment</h1><input><button data-back>Back</button><button data-goto="Confirmation">Pay</button>'];
const CONF = ['Confirmation', '<h1>Thanks <span data-show="name"></span></h1>'];

function checkout(pages: string[][] = [CART, SHIP, PAY, CONF], start = 0) {
  const s = store();
  const ids = pages.map(([title, html], i) => s.dispatch('page.create', { x: i * 400, y: 0, title, html }).select![0]);
  s.dispatch('page.start', { id: ids[start] });
  return s;
}
const swap = (p: string[], from: string | RegExp, to: string) => [p[0], p[1].replace(from, to)];

describe('checkout grader', () => {
  it('a CSS [data-back] selector is not a back button', () => {
    const css = swap(PAY, '<button data-back>Back</button>', '<style>[data-back]{color:red}</style>');
    expect(failed('checkout', checkout([CART, SHIP, css, CONF]))).toEqual(['back']);
  });
  it('passes the good flow: forward links, back, shared name; no-broken-links is info', () => {
    const s = checkout();
    expect(failed('checkout', s)).toEqual([]);
    expect(grade('checkout', s).filter((c) => !c.info)).toHaveLength(6);
    expect(grade('checkout', s).find((c) => c.id === 'no-broken-links')).toMatchObject({ pass: true, info: true });
    expect(detail('checkout', s, 'state')).toBe('shipping writes name, address; confirmation shows name');
  });
  it('back counts via data-goto to the previous page or canvas.back(); a missing one names the page', () => {
    expect(failed('checkout', checkout([CART, swap(SHIP, '<button data-back>Back</button>', '<button data-goto="Cart">Back</button>'), swap(PAY, '<button data-back>Back</button>', '<script>canvas.back()</script>'), CONF]))).toEqual([]);
    const s = checkout([CART, SHIP, swap(PAY, '<button data-back>Back</button>', ''), CONF]);
    expect(failed('checkout', s)).toEqual(['back']);
    expect(detail('checkout', s, 'back')).toBe('no back on “Payment”');
  });
  it('state: a different key fails, listing both; canvas.set and canvas.state pass', () => {
    const s = checkout([CART, SHIP, PAY, swap(CONF, 'data-show="name"', 'data-show="fullName"')]);
    expect(failed('checkout', s)).toEqual(['state']);
    expect(detail('checkout', s, 'state')).toBe('shipping writes name, address; confirmation shows fullName');
    const js = checkout([CART, swap(SHIP, /<input data-store="name">/, `<script>canvas.set('name', 'Ada')</script>`), PAY, swap(CONF, '<span data-show="name"></span>', '<script>document.title = canvas.state.name</script>')]);
    expect(failed('checkout', js)).toEqual([]);
  });
  it('forward needs links in the pages, start must be the cart, titles must match', () => {
    expect(failed('checkout', checkout([CART, SHIP, swap(PAY, 'data-goto="Confirmation"', 'data-goto="Cart"'), CONF]))).toEqual(['forward']);
    expect(failed('checkout', checkout(undefined, 1))).toEqual(['start']);
    expect(failed('checkout', checkout([CART, SHIP, PAY, ['Welcome', '<h1>Hi</h1>']]))).toContain('titles');
  });
  it('a broken link is only info here', () => {
    const s = checkout([CART, swap(SHIP, '<button data-back>Back</button>', '<button data-back>Back</button><a data-goto="Help">?</a>'), PAY, CONF]);
    expect(grade('checkout', s).find((c) => c.id === 'no-broken-links')).toMatchObject({ pass: false, info: true });
    expect(JOBS.checkout.grade(loadDoc(text(s))).filter((c) => !c.info && !c.pass)).toEqual([]);
  });
});

// ---- arch

const PARTS_ARCH = ['Browser', 'API server', 'Postgres database', 'Redis cache'];
const ARCH_ARROWS: [number, number, string][] = [[0, 1, 'HTTPS requests'], [1, 2, 'SQL queries'], [1, 3, 'cached reads']];

function arch(o: { parts?: string[]; frame?: string | false; arrows?: [number, number, string][]; outside?: number; plain?: boolean; overlap?: boolean } = {}) {
  const s = store();
  const parts = o.parts ?? PARTS_ARCH;
  const ids = parts.map((text, i) => {
    const pos = o.overlap && i === 1 ? { x: 20, y: 20 } : { x: i * 300, y: o.outside === i ? 2000 : 0 };
    return o.plain ? s.dispatch('board.add', { text, ...pos }).select![0] : s.dispatch('diagram.add', { kind: 'rect', text, ...pos }).select![0];
  });
  for (const [a, b, label] of o.arrows ?? ARCH_ARROWS) s.dispatch('core.connect', { from: ids[a], to: ids[b], label });
  if (o.frame !== false) s.dispatch('frames.create', { around: ids.filter((_, i) => o.outside !== i), label: o.frame ?? 'Architecture' });
  return s;
}

describe('arch grader', () => {
  it('passes a framed, connected, labeled diagram; no-overlap is info', () => {
    expect(failed('arch', arch())).toEqual([]);
    expect(grade('arch', arch()).find((c) => c.id === 'no-overlap')).toMatchObject({ pass: true, info: true });
    expect(grade('arch', arch({ overlap: true })).find((c) => c.id === 'no-overlap')).toMatchObject({ pass: false, info: true });
  });
  it('fails without a frame or with another title', () => {
    expect(failed('arch', arch({ frame: false }))).toEqual(['frame', 'in-frame']);
    expect(failed('arch', arch({ frame: 'Diagram' }))).toEqual(['frame', 'in-frame']);
  });
  it('fails a shape outside the frame and names it', () => {
    const c = grade('arch', arch({ outside: 3 })).find((x) => x.id === 'in-frame')!;
    expect([c.pass, c.detail]).toEqual([false, expect.stringContaining('Redis cache')]);
  });
  it('fails an unlabeled arrow, too few arrows, a cache left unconnected', () => {
    expect(failed('arch', arch({ arrows: [[0, 1, 'HTTPS'], [1, 2, ''], [1, 3, 'reads']] }))).toEqual(['labeled']);
    expect(failed('arch', arch({ arrows: ARCH_ARROWS.slice(0, 2) }))).toEqual(['connected', 'labeled']);
    expect(failed('arch', arch({ arrows: [[0, 1, 'a'], [1, 2, 'b'], [0, 2, 'c']] }))).toEqual(['connected']);
  });
  it('accepts an intermediate shape on the path', () => {
    const s = arch({ parts: [...PARTS_ARCH, 'Load balancer'], arrows: [[0, 4, 'a'], [4, 1, 'b'], [1, 2, 'c'], [1, 3, 'd']] });
    expect(failed('arch', s)).toEqual([]);
  });
  it('plain text nodes are not shapes: components fails and the detail counts them', () => {
    const f = grade('arch', arch({ plain: true }));
    expect(f.filter((c) => !c.pass).map((c) => c.id)).toContain('components');
    expect(f.find((c) => c.id === 'components')!.detail).toContain('4 other text nodes');
  });
  it('an Excalidraw scene is named as such; "spa" needs to be a word', () => {
    const s = store();
    s.dispatch('core.add', { nodes: [{ id: 'x', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '', 'x-excalidraw': {} }] });
    expect(grade('arch', s).find((c) => c.id === 'components')!.detail).toBe('drew in Excalidraw (1 scene), not diagram shapes');
    expect(failed('arch', arch({ parts: ['Workspace', 'API', 'Database', 'Cache'] }))).toContain('components');
  });
  it('one shape cannot be two components', () => {
    expect(failed('arch', arch({ parts: ['Web app', 'API', 'Database', 'Cache'] }))).toEqual([]);
    // "API client" matches both client and api, but is one shape: needs a second one
    expect(failed('arch', arch({ parts: ['API client', 'Database', 'Cache', 'Notes'], arrows: ARCH_ARROWS }))).toContain('components');
    expect(failed('arch', arch({ parts: ['API client', 'Database', 'Cache', 'Server'], arrows: ARCH_ARROWS }))).not.toContain('components');
  });
});

describe('smoke grader', () => {
  it('passes an empty board', () => {
    expect(failed('smoke', store())).toEqual([]);
    expect(failed('smoke', notes())).toEqual(['unchanged']);
  });
});
