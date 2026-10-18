import { describe, expect, it } from 'vitest';
import { JOBS } from '../../../agent-eval/jobs';
import { Host, makeActor } from '../../../bridge/host';
import { isNote, isPage, page, pages } from './model';

const claude = makeActor('Claude');
const run = (h: Host, name: string, args: Record<string, unknown> = {}) => h.run(claude, name, args);
const ok = (h: Host, name: string, args: Record<string, unknown> = {}) => {
  const r = run(h, name, args);
  if (!r.ok) throw new Error(r.error);
  return r.result as any;
};
const error = (h: Host, name: string, args: Record<string, unknown> = {}) => {
  const r = run(h, name, args);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
};
const viewText = (h: Host, name: string, args: Record<string, unknown> = {}) => h.store.viewSpec(name)!.text!(h.view(claude, name, args));
const failing = (h: Host, job: string) => JOBS[job].grade(h.store.doc).filter((c) => !c.pass && !c.info).map((c) => c.id);
const byTitle = (h: Host, t: string) => pages(h.store.doc).find((p) => page(p).title === t)!;
const startTitles = (h: Host) => pages(h.store.doc).filter((p) => page(p).start).map((p) => page(p).title);

const SIGN_IN = '<h1>Sign in</h1><input placeholder="Email"><button data-goto="Home">Sign in</button><a data-goto="Forgot password">Forgot?</a>';
const FORGOT = '<h1>Forgot</h1><input><button data-goto="Check your email">Send</button>';
const CHECK = '<h1>Check your email</h1><a data-goto="Sign in">Back to sign in</a>';
const HOME = '<h1>Welcome</h1><a data-back>Back</a>';

function protoFlow(h: Host) {
  ok(h, 'page.create', { title: 'Sign in', html: SIGN_IN });
  ok(h, 'page.create', { title: 'Forgot password', html: FORGOT });
  ok(h, 'page.create', { title: 'Check your email', html: CHECK });
  ok(h, 'page.create', { title: 'Home', html: HOME });
}

describe('prototype through the bridge', () => {
  it('A1 every command is described, with title, summary, guide and the two views', () => {
    const h = new Host();
    const p = h.catalog.plugin('prototype')!;
    expect(p.undescribed).toEqual([]);
    expect(p.commands).toHaveLength(13);
    expect(p.title).toBe('Prototype');
    expect(p.summary).toBeTruthy();
    expect(p.guide!.split('\n').length).toBeLessThanOrEqual(15);
    expect(p.views).toEqual(expect.arrayContaining(['page.flow', 'page.html']));
    expect(h.catalog.helpText('prototype')).not.toContain('Not described yet');
    expect(h.catalog.helpText()).not.toMatch(/prototype[^\n]*Not described yet/);
    expect(h.catalog.helpText()).toContain('Clickable prototypes');
  });

  it('A2 the proto job flow: pages without positions, one autoLink, the grader passes', () => {
    const h = new Host();
    protoFlow(h);
    const r = ok(h, 'page.autoLink');
    expect(r.linked).toBeGreaterThan(0);
    expect(r.missing).toEqual([]);
    expect(failing(h, 'proto')).toEqual([]);
    expect(JOBS.proto.grade(h.store.doc).find((c) => c.id === 'arrows')!.pass).toBe(true);
  });

  it('A3 create results: start only for the first, placed right of the last, device sets the width', () => {
    const h = new Host();
    const a = ok(h, 'page.create', { title: 'A', html: '<p>a</p>' });
    const b = ok(h, 'page.create', { title: 'B', html: '<p>b</p>', device: 'desktop' });
    expect(a).toMatchObject({ title: 'A', device: 'phone', start: true });
    expect(b).toMatchObject({ device: 'desktop', start: false });
    const na = h.store.doc.get(a.id)!;
    const nb = h.store.doc.get(b.id)!;
    expect(nb.x).toBeGreaterThanOrEqual(na.x + na.width);
    expect(page(nb).vw).toBe(1280);
  });

  it('A4 warnings on create; a target created later resolves in page.flow', () => {
    const h = new Host();
    const r = ok(h, 'page.create', { title: 'A', html: '<a href="#x">Go</a><button data-goto="B">b</button>' });
    expect(r.warnings.join('\n')).toMatch(/data-goto/);
    expect(r.warnings.join('\n')).toContain('“B” finds no page yet');
    expect(r.links).toEqual([{ target: 'B' }]);
    ok(h, 'page.create', { title: 'B', html: '<p>b</p>' });
    expect(viewText(h, 'page.flow')).toContain('data-goto “B” → “B”');
    expect(viewText(h, 'page.flow')).not.toContain('BROKEN');
  });

  it('A5 edit by title; rename lists broken links; html change returns links; same values change nothing', () => {
    const h = new Host();
    protoFlow(h);
    const r = ok(h, 'page.edit', { id: 'Forgot password', title: 'Reset password' });
    expect(r.broken).toEqual(['“Sign in” → “Forgot password”']);
    expect(ok(h, 'page.edit', { id: 'Home', html: '<a data-goto="Sign in">out</a>' }).links).toEqual([{ target: 'Sign in', to: 'Sign in' }]);
    expect(ok(h, 'page.edit', { id: 'Home', html: '<a data-goto="Sign in">out</a>' }).changed).toBe(0);
  });

  it('A6 refusals carry a reason', () => {
    const h = new Host();
    protoFlow(h);
    ok(h, 'page.note', { on: 'Home', text: 'a note' });
    ok(h, 'diagram.add', { kind: 'rect', text: 'Shape', x: 0, y: 2000 });
    expect(error(h, 'page.create', { title: 'home' })).toMatch(/page titled “Home” \(\w+\) exists.*unique/);
    for (const [c, a] of [['page.edit', { title: 'x' }], ['page.start', {}], ['page.device', { device: 'phone' }], ['page.scale', { factor: 2 }]] as const) expect(error(h, c, { id: 'Shape', ...a })).toMatch(/not a page; pages: “Sign in”/);
    expect(error(h, 'page.link', { from: 'Shape', to: 'Home' })).toMatch(/not a page/);
    expect(error(h, 'page.link', { from: 'Home', to: 'Home' })).toMatch(/itself/);
    expect(error(h, 'page.unlink', {})).toMatch(/give the arrow id/);
    expect(error(h, 'page.unlink', { from: 'Home', to: 'Sign in' })).toMatch(/no arrow from/);
    expect(error(h, 'page.unlink', { edge: 'nope' })).toMatch(/no arrow nope/);
    expect(error(h, 'page.unlink', { edge: 'e', from: 'Home' })).toMatch(/not both/);
    expect(error(h, 'page.note', { on: 'Shape', text: 'x' })).toMatch(/not a page/);
    expect(error(h, 'page.noteText', { id: 'Home', text: 'x' })).toMatch(/not a page note/);
    expect(error(h, 'page.edit', { id: 'Home' })).toMatch(/title, html, or both/);
    expect(error(h, 'page.edit', { node: 'Home', html: 'x' })).toMatch(/node/);
    expect(error(h, 'page.edit', { id: 'Home', title: 'Sign in' })).toMatch(/exists/);
    expect(error(h, 'page.device', { id: 'Home', device: 'watch' })).toMatch(/device/);
    expect(error(h, 'page.create', { html: 'x' })).toMatch(/title/);
    expect(error(h, 'page.create', { title: 'X', x: 5 })).toMatch(/both x and y/);
  });

  it('A7 link returns the arrow id; linking again relabels it; unlink by pair and by id', () => {
    const h = new Host();
    protoFlow(h);
    const a = ok(h, 'page.link', { from: 'Home', to: 'Sign in', label: 'Out' });
    const b = ok(h, 'page.link', { from: 'Home', to: 'Sign in', label: 'Sign out' });
    expect(b.arrow).toBe(a.arrow);
    expect(b.label).toBe('Sign out');
    expect(ok(h, 'page.unlink', { from: 'Home', to: 'Sign in' }).changed).toBe(1);
    const c = ok(h, 'page.link', { from: 'Home', to: 'Sign in' });
    expect(ok(h, 'page.unlink', { edge: c.arrow }).changed).toBe(1);
    expect(h.store.doc.edges).toHaveLength(0);
  });

  it('A8 start moves the flag; create {start} too', () => {
    const h = new Host();
    protoFlow(h);
    expect(startTitles(h)).toEqual(['Sign in']);
    ok(h, 'page.start', { id: 'Home' });
    expect(startTitles(h)).toEqual(['Home']);
    ok(h, 'page.create', { title: 'New', start: true });
    expect(startTitles(h)).toEqual(['New']);
  });

  it('A8b create leaves start unset on a board of unflagged pages; seed refuses taken titles; unlink refuses non-page edges', () => {
    const h = new Host();
    h.store.dispatch('page.create', { x: 0, y: 0, title: 'Landing', html: '<p>l</p>' });
    expect(startTitles(h)).toEqual([]);
    expect(ok(h, 'page.create', { title: 'Settings', html: '<p>s</p>' }).start).toBe(false);
    expect(startTitles(h)).toEqual([]);
    expect(error(h, 'page.seed')).toMatch(/“Landing” already exists/);
    ok(h, 'diagram.add', { kind: 'rect', text: 'A', x: 0, y: 3000 });
    ok(h, 'diagram.add', { kind: 'rect', text: 'B', x: 400, y: 3000 });
    const e = ok(h, 'core.connect', { from: 'A', to: 'B' });
    expect(error(h, 'page.unlink', { edge: e.id ?? e.edge ?? h.store.doc.edges[0].id })).toMatch(/between pages/);
  });

  it('A9 notes: under the page, ride it, noteText, attach after a move', () => {
    const h = new Host();
    protoFlow(h);
    const n = ok(h, 'page.note', { on: 'Sign in', text: 'Do we need the name field?' });
    expect(n.on).toBe('Sign in');
    const si = byTitle(h, 'Sign in');
    const note = h.store.doc.get(n.id)!;
    expect(note.y).toBe(si.y + si.height + 24);
    ok(h, 'core.move', { ids: ['Sign in'], dx: 50, dy: 0 });
    expect(h.store.doc.get(n.id)!.x).toBe(note.x + 50);
    expect(ok(h, 'page.noteText', { id: n.id, text: 'Cut it' }).changed).toBe(1);
    const home = byTitle(h, 'Home');
    ok(h, 'core.move', { ids: [n.id], dx: home.x - h.store.doc.get(n.id)!.x, dy: home.y + 40 - h.store.doc.get(n.id)!.y });
    ok(h, 'page.attach', { ids: [n.id] });
    expect(isNote(h.store.doc.get(n.id)) && (h.store.doc.get(n.id) as any)['x-page'].on).toBe(home.id);
  });

  it('A10 seed without a position lands right of everything and keeps the start page', () => {
    const h = new Host();
    protoFlow(h);
    const right = Math.max(...pages(h.store.doc).map((p) => p.x + p.width));
    const r = ok(h, 'page.seed');
    expect(Object.keys(r.pages)).toEqual(['Landing', 'Sign up', 'Plan', 'Checkout', 'Welcome']);
    expect(h.store.doc.get(r.pages.Landing)!.x).toBeGreaterThan(right);
    expect(startTitles(h)).toEqual(['Sign in']);
    expect(r.start).toBe(byTitle(h, 'Sign in').id);
  });

  it('A11 views: page.html is verbatim; page.flow has the format; a note is an error', () => {
    const h = new Host();
    protoFlow(h);
    ok(h, 'page.autoLink');
    const t = viewText(h, 'page.html', { id: 'Sign in' });
    expect(t.split('\n')[0]).toMatch(/^“Sign in” \(\w+\) · start · phone \(390\) · \d\.\d KB$/);
    expect(t.endsWith(`\n${SIGN_IN}`)).toBe(true);
    const f = viewText(h, 'page.flow');
    expect(f).toMatch(/^Prototype: 4 pages\. Start page: “Sign in” \(\w+\); Play starts there\.\n1\. “Sign in”/);
    expect(f).toContain('Reachable from “Sign in”: 4/4 by links in the pages; 4/4 with Play');
    const n = ok(h, 'page.note', { on: 'Home', text: 'n' });
    expect(() => h.view(claude, 'page.html', { id: n.id })).toThrow(/not a page/);
  });

  it('A12 the checkout job flow passes the grader', () => {
    const h = new Host();
    ok(h, 'page.create', { title: 'Cart', html: '<h1>Cart</h1><button data-goto="Shipping">Checkout</button>' });
    ok(h, 'page.create', { title: 'Shipping', html: '<input data-store="name"><input data-store="address"><a data-back>Back</a><button data-goto="Payment">Next</button>' });
    ok(h, 'page.create', { title: 'Payment', html: '<input><a data-back>Back</a><button data-goto="Confirmation">Pay</button>' });
    ok(h, 'page.create', { title: 'Confirmation', html: '<h1>Thanks <span data-show="name"></span></h1>' });
    ok(h, 'page.autoLink');
    expect(failing(h, 'checkout')).toEqual([]);
  });

  it('A13 pages stay pages: the UI path (dispatch without specs) still ignores bad args', () => {
    const h = new Host();
    h.store.dispatch('page.create', { title: 'no position' });
    expect(pages(h.store.doc)).toHaveLength(0);
    h.store.dispatch('page.create', { x: 0, y: 0, title: 'ok' });
    expect(pages(h.store.doc).every(isPage)).toBe(true);
  });
});
