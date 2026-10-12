import { describe, expect, it } from 'vitest';
import { Store, parse, serialize, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { TAG, readMessage } from './bridge';
import { fromFrame, pageDocument } from '../../sandbox/page';
import { registerPrototypeLogic } from './logic';
import { FIELD, flowOrder, isNote, isPage, note, page, pages, resolveLink, startPage, titleOf } from './model';
import { History } from './history';

function ctx(): CommandCtx {
  let n = 0;
  return { newId: () => `id${++n}`, random: () => 0.5 };
}
function store() {
  const s = new Store({ ctx: ctx() });
  registerCoreCommands(s);
  registerPrototypeLogic(s);
  return s;
}
const byTitle = (s: Store, t: string) => pages(s.doc).find((n) => page(n).title === t)!;
function seeded() {
  const s = store();
  s.dispatch('page.seed', { x: 0, y: 0 });
  return s;
}

describe('prototype pages', () => {
  it('seed: 5 pages, start page, 6 labelled edges, notes ride their page', () => {
    const s = seeded();
    expect(pages(s.doc).map((n) => page(n).title)).toEqual(['Landing', 'Sign up', 'Plan', 'Checkout', 'Welcome']);
    expect(s.doc.edges.length).toBe(6);
    expect(startPage(s.doc)).toBe(byTitle(s, 'Landing').id);
    const notes = s.doc.nodes.filter(isNote);
    expect(notes.length).toBe(3);
    const landing = byTitle(s, 'Landing');
    expect(s.doc.riders(landing.id).map((n) => n.id)).toEqual([notes[0].id]);
    // moving the page moves its note
    s.dispatch('core.move', { ids: [landing.id], dx: 10, dy: 5 });
    expect(s.doc.get(notes[0].id)!.x).toBe(notes[0].x + 10);
  });

  it('resolves links by edge label, by target title, by any page title, and the only edge', () => {
    const s = seeded();
    const [landing, signup, plan, checkout, welcome] = ['Landing', 'Sign up', 'Plan', 'Checkout', 'Welcome'].map((t) => byTitle(s, t).id);
    expect(resolveLink(s.doc, landing, 'Get started')?.to).toBe(signup);
    expect(resolveLink(s.doc, landing, 'sign UP')?.to).toBe(signup);
    expect(resolveLink(s.doc, checkout, 'Plan')?.to).toBe(plan);
    expect(resolveLink(s.doc, checkout, 'Pay')?.to).toBe(welcome);
    expect(resolveLink(s.doc, signup, '')?.to).toBe(plan); // the only edge
    expect(resolveLink(s.doc, checkout, '')).toBeUndefined(); // two edges: ambiguous
    const r = resolveLink(s.doc, landing, 'Checkout'); // no edge, but a page with that title
    expect(r).toEqual({ to: checkout });
    expect(resolveLink(s.doc, landing, 'Nowhere')).toBeUndefined();
  });

  it('flow order: steps from the start page, cycles cut', () => {
    const s = seeded();
    const cols = flowOrder(s.doc).map((c) => c.map((id) => titleOf(s.doc.get(id))));
    expect(cols).toEqual([['Landing'], ['Sign up'], ['Plan'], ['Checkout'], ['Welcome']]);
    // an unlinked page left of the start page still comes after it in the first column
    s.dispatch('page.create', { x: -5000, y: -5000, title: 'Loose' });
    expect(flowOrder(s.doc)[0].map((id) => titleOf(s.doc.get(id)))).toEqual(['Landing', 'Loose']);
  });

  it('arrange lays pages out left → right and takes notes along', () => {
    const s = seeded();
    const ids = pages(s.doc).map((n) => n.id);
    // scramble
    s.dispatch('core.move', { ids: [ids[0]], dx: 3000, dy: 700 });
    s.dispatch('core.move', { ids: [ids[3]], dx: -2000, dy: -300 });
    s.dispatch('page.arrange', { x: 0, y: 0 });
    const xs = ['Landing', 'Sign up', 'Plan', 'Checkout', 'Welcome'].map((t) => byTitle(s, t).x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(['Landing', 'Plan', 'Welcome'].map((t) => byTitle(s, t).y))).toEqual(new Set([0]));
    const landing = byTitle(s, 'Landing');
    const n = s.doc.nodes.find((x) => isNote(x) && note(x).on === landing.id)!;
    expect(n.x - landing.x).toBe(16);
  });

  it('edit, link, unlink, start are undoable steps', () => {
    const s = seeded();
    const plan = byTitle(s, 'Plan').id;
    const welcome = byTitle(s, 'Welcome').id;
    s.dispatch('page.edit', { id: plan, title: 'Plans', html: '<p>x</p>' });
    expect(page(s.doc.get(plan)!)).toMatchObject({ title: 'Plans', html: '<p>x</p>' });
    expect(s.doc.get(plan)!.text).toContain('Plans');
    s.dispatch('page.link', { from: plan, to: welcome, label: 'Skip' });
    expect(resolveLink(s.doc, plan, 'Skip')?.to).toBe(welcome);
    const e = s.doc.edges.find((x) => x.label === 'Skip')!;
    s.dispatch('page.unlink', { edge: e.id });
    expect(resolveLink(s.doc, plan, 'Skip')).toBeUndefined();
    s.dispatch('page.start', { id: plan });
    expect(pages(s.doc).filter((n) => page(n).start).map((n) => n.id)).toEqual([plan]);
    s.undo();
    s.undo();
    expect(resolveLink(s.doc, plan, 'Skip')?.to).toBe(welcome);
    s.undo();
    s.undo();
    expect(page(s.doc.get(plan)!).title).toBe('Plan');
  });

  it('deleting a page drops its edges', () => {
    const s = seeded();
    s.dispatch('core.delete', { ids: [byTitle(s, 'Checkout').id] });
    expect(s.doc.edges.length).toBe(3);
  });

  it('auto-link makes edges for data-goto links to existing pages, labelled by the link text', () => {
    const s = store();
    s.dispatch('page.create', { x: 0, y: 0, title: 'A', html: '<a data-goto="B">Next step</a><button data-goto=\'C\'>C!</button><a data-goto="Z">z</a>' });
    s.dispatch('page.create', { x: 400, y: 0, title: 'B' });
    s.dispatch('page.create', { x: 800, y: 0, title: 'C' });
    s.dispatch('page.autoLink', {});
    const a = byTitle(s, 'A').id;
    expect(s.doc.edges.filter((e) => e.fromNode === a).map((e) => [titleOf(s.doc.get(e.toNode)), e.label])).toEqual([
      ['B', 'Next step'],
      ['C', 'C!'],
    ]);
    s.dispatch('page.autoLink', {}); // idempotent
    expect(s.doc.edges.filter((e) => e.fromNode === a).length).toBe(2);
  });

  it('notes attach to the page under them', () => {
    const s = seeded();
    const plan = byTitle(s, 'Plan');
    s.dispatch('page.note', { x: 5000, y: 5000, text: 'hi' });
    const id = s.doc.nodes.filter(isNote).at(-1)!.id;
    expect(note(s.doc.get(id)!).on).toBeUndefined();
    s.dispatch('core.move', { ids: [id], dx: plan.x + 20 - 5000, dy: plan.y + 20 - 5000 });
    s.dispatch('page.attach', { ids: [id] });
    expect(note(s.doc.get(id)!).on).toBe(plan.id);
  });

  it('round-trips through a .canvas file; import repairs bad page fields', () => {
    const s = seeded();
    const file = serialize(s.exportDoc());
    const t = store();
    t.load(parse(file));
    expect(pages(t.doc).length).toBe(5);
    expect(t.doc.edges.length).toBe(6);
    const bad = store();
    bad.load(
      parse(
        JSON.stringify({
          nodes: [
            { id: 'p', type: 'text', x: 0, y: 0, width: 200, height: 300, [FIELD]: { html: 5, title: 'x' } },
            { id: 'q', type: 'text', x: 0, y: 0, width: 200, height: 300, [FIELD]: { html: '<p>', vw: 'big' } },
          ],
          edges: [],
        }),
      ),
    );
    expect(isPage(bad.doc.get('p'))).toBe(false);
    expect(page(bad.doc.get('q')!)).toEqual({ html: '<p>', vw: 390, title: 'Untitled' });
  });
});

describe('sandbox bridge', () => {
  it('the page document is the bridge, then the page (no CSP meta: the frame host sends the header)', () => {
    const d = pageDocument('<h1>Hi</h1>', { name: '</script><script>alert(1)</script>' });
    expect(d).not.toContain('Content-Security-Policy');
    expect(d.indexOf('<script>')).toBeLessThan(d.indexOf('<h1>Hi</h1>'));
    expect(d.endsWith('<h1>Hi</h1>')).toBe(true);
    // state can't break out of the bridge script
    expect(d.match(/<\/script>/g)!.length).toBe(1);
  });
  it('trusts a message only from the frame itself, on the sandbox origin it was opened on', () => {
    const frame = { contentWindow: {}, src: 'http://page-ab12.localhost:5227/page' } as unknown as HTMLIFrameElement;
    const msg = (source: unknown, origin: string) => ({ source, origin }) as unknown as MessageEvent;
    expect(fromFrame(frame, msg(frame.contentWindow, 'http://page-ab12.localhost:5227'))).toBe(true);
    expect(fromFrame(frame, msg(frame.contentWindow, 'https://evil.example'))).toBe(false);
    expect(fromFrame(frame, msg(frame.contentWindow, 'null'))).toBe(false);
    expect(fromFrame(frame, msg({}, 'http://page-ab12.localhost:5227'))).toBe(false);
  });
  it('accepts only tagged, well-formed messages', () => {
    expect(readMessage({ tag: TAG, kind: 'goto', target: 'Plan' })).toEqual({ kind: 'goto', target: 'Plan' });
    expect(readMessage({ tag: TAG, kind: 'goto' })).toEqual({ kind: 'goto', target: '' });
    expect(readMessage({ tag: TAG, kind: 'back' })).toEqual({ kind: 'back' });
    expect(readMessage({ tag: TAG, kind: 'escape' })).toEqual({ kind: 'escape' });
    expect(readMessage({ tag: TAG, kind: 'set', key: 'name', value: 'Ada' })).toEqual({ kind: 'set', key: 'name', value: 'Ada' });
    expect(readMessage({ kind: 'goto', target: 'x' })).toBeUndefined();
    expect(readMessage({ tag: TAG, kind: 'eval', code: '1' })).toBeUndefined();
    expect(readMessage({ tag: TAG, kind: 'set', key: 5, value: 'x' })).toBeUndefined();
    expect(readMessage('goto')).toBeUndefined();
  });
});

describe('play history', () => {
  it('go, back, jump to a breadcrumb, restart', () => {
    const h = new History('a');
    h.go('b');
    h.go('c');
    expect(h.path).toEqual(['a', 'b', 'c']);
    expect(h.back()).toBe(true);
    expect(h.current).toBe('b');
    h.go('d');
    expect(h.path).toEqual(['a', 'b', 'd']);
    h.jump(0);
    expect(h.path).toEqual(['a']);
    expect(h.back()).toBe(false);
    h.go('b');
    h.restart();
    expect(h.path).toEqual(['a']);
  });
  it('a page reached again folds the loop back (breadcrumb stays short)', () => {
    const h = new History('a');
    h.go('b');
    h.go('c');
    h.go('b');
    expect(h.path).toEqual(['a', 'b']);
  });
});
