import { describe, expect, it } from 'vitest';
import { Store, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { flowOf, flowText, pageFlow, pageWarnings } from './flow';
import { registerPrototypeLogic } from './logic';
import { isNote, page, pages } from './model';

function store() {
  let n = 0;
  const ctx: CommandCtx = { newId: () => `id${++n}`, random: () => 0.5 };
  const s = new Store({ ctx });
  registerCoreCommands(s);
  registerPrototypeLogic(s);
  return s;
}
/** Pages from [title, html] at x = 400 * i; the first is the start page. Returns ids by title. */
function make(defs: [string, string][], arrows: [string, string, string?][] = []) {
  const s = store();
  const id: Record<string, string> = {};
  defs.forEach(([title, html], i) => (id[title] = s.dispatch('page.create', { x: i * 400, y: 0, title, html, start: i === 0 }).select![0]));
  for (const [a, b, label] of arrows) s.dispatch('page.link', { from: id[a], to: id[b], label });
  return { s, id };
}

describe('page flow', () => {
  it('F1 seed: flow order, start Landing, links by arrow label, back, state', () => {
    const s = store();
    s.dispatch('page.seed', { x: 0, y: 0 });
    const f = flowOf(s.doc);
    const byTitle = (t: string) => f.pages.find((p) => p.title === t)!;
    expect(f.pages.map((p) => p.title)).toEqual(['Landing', 'Sign up', 'Plan', 'Checkout', 'Welcome']);
    expect(f.startFlagged).toBe(true);
    expect(byTitle('Landing').start).toBe(true);
    expect(byTitle('Landing').links.find((l) => l.target === 'Get started')).toMatchObject({ toTitle: 'Sign up', arrow: expect.any(String) });
    expect(f.pages.filter((p) => p.back).map((p) => [p.title, p.back])).toEqual([['Sign up', 'data-back'], ['Plan', 'data-back'], ['Checkout', 'data-back']]);
    expect(f.state.name).toMatchObject({ writes: [byTitle('Sign up').id] });
    expect(f.state.name.shows).toContain(byTitle('Plan').id);
    expect(f.state.plan.writes).toEqual([byTitle('Plan').id]);
    expect(f.state.plan.shows).toContain(byTitle('Checkout').id);
    expect(f.broken).toEqual([]);
    expect(f.unreachable).toEqual([]);
  });

  it('F2 a link by title has no arrow yet; an arrow no link uses; an unresolved target', () => {
    const { s, id } = make([['A', '<button data-goto="B">b</button><a data-goto="Nowhere">x</a>'], ['B', '<p>end</p>'], ['C', '<p>c</p>']], [['A', 'C', 'Skip']]);
    const a = pageFlow(s.doc, id.A);
    expect(a.links).toMatchObject([{ target: 'B', to: id.B }, { target: 'Nowhere', broken: true }]);
    expect(a.links[0].arrow).toBeUndefined();
    expect(a.arrowsOnly).toMatchObject([{ label: 'Skip', to: id.C }]);
    const t = flowText(flowOf(s.doc));
    expect(t).toContain('button “b” data-goto “B” → “B” (' + id.B + ') · no arrow yet (page.autoLink draws it)');
    expect(t).toContain('a “x” data-goto “Nowhere” → BROKEN: no page titled “Nowhere”, no arrow labelled “Nowhere”');
    expect(t).toContain('only a chip in Play, nothing in the page links there');
    expect(t).toContain('Broken links: “A” → “Nowhere”.');
  });

  it('F3 reachability: by links vs with arrows; unreachable listed; no start flag', () => {
    const { s, id } = make([['A', '<a data-goto="B">b</a>'], ['B', '<p>b</p>'], ['C', '<p>c</p>']], [['B', 'C']]);
    const f = flowOf(s.doc);
    expect(f.inPage).toEqual([id.A, id.B]);
    expect(f.withArrows).toEqual([id.A, id.B, id.C]);
    expect(f.unreachable).toEqual([id.C]);
    expect(flowText(f)).toContain('Reachable from “A”: 2/3 by links in the pages; 3/3 with Play\'s arrow chips.');
    expect(flowText(f)).toContain('Unreachable: “C”.');
    const bare = store();
    bare.dispatch('page.create', { x: 0, y: 0, title: 'Solo', html: '<p>s</p>' });
    expect(flowText(flowOf(bare.doc))).toContain('Start page: none set; Play starts at “Solo” (' + pages(bare.doc)[0].id + ') (first in the flow). page.start sets one.');
  });

  it('F4 dead anchors and void elements', () => {
    const { s, id } = make([
      ['A', '<a href="#">x</a><a href="#top" data-goto="B">ok</a><a href="#" onclick="go()">js</a><a href="#" data-back>back</a><input type="submit" data-goto="B">'],
      ['B', '<p>b</p>'],
    ]);
    const a = pageFlow(s.doc, id.A);
    expect(a.dead).toBe(1);
    expect(a.links.map((l) => [l.tag, l.target])).toEqual([['a', 'B'], ['input', 'B']]);
    expect(a.links[0].text).toBe('ok');
    expect(a.links[1].text).toBe('');
  });

  it('F4b anchors with a target in the page are not dead; boolean, unquoted and entity data-goto are found', () => {
    const { s, id } = make([
      ['A', '<a href="#faq">FAQ</a><a href="#nope">x</a><section id="faq"></section><button data-goto>next</button><b data-goto=B>b</b><i data-goto="Terms &amp; Co">t</i>'],
      ['B', '<p>b</p>'],
      ['Terms & Co', '<p>t</p>'],
    ]);
    const a = pageFlow(s.doc, id.A);
    expect(a.dead).toBe(1);
    expect(a.links.map((l) => [l.target, l.to ?? null])).toEqual([['', null], ['B', id.B], ['Terms & Co', id['Terms & Co']]]);
  });

  it('F4c autoLink draws arrows for void-element links too; back ignores CSS and a back-only page is not an end page', () => {
    const { s, id } = make([
      ['A', '<form><input type="submit" data-goto="B" value="Go"></form><button data-goto="C">c</button>'],
      ['B', '<style>[data-back]{color:red}</style><p>b</p>'],
      ['C', '<a data-back>Back</a>'],
    ]);
    expect(s.dispatch('page.autoLink', {}).changes).toHaveLength(2);
    expect(s.doc.edges.map((e) => [e.fromNode, e.toNode, e.label]).sort()).toEqual([[id.A, id.B, 'B'], [id.A, id.C, 'c']].sort());
    expect(pageFlow(s.doc, id.B).back).toBeUndefined();
    const t = flowText(flowOf(s.doc));
    expect(t).toContain('no links out (an end page)');
    expect(t).toContain('no links forward (back only)');
    expect(pageWarnings(s.doc, id.C)).toEqual([]);
  });

  it('F5 empty doc and the text format', () => {
    expect(flowText(flowOf(store().doc))).toBe('No prototype pages yet. page.create {title, html} adds one; page.seed adds a 5-page example flow.');
    const { s, id } = make([
      ['Sign in', '<input name="e" data-store="email"><button data-goto="Home">Sign in</button><a href="#">Help</a>'],
      ['Home', '<p data-show="email"></p>'],
    ], [['Sign in', 'Home', 'Go']]);
    s.dispatch('page.note', { x: 0, y: 500, text: 'Do we need the name field? It slows people down a lot', on: id.Home });
    const note = s.doc.nodes.find((n) => isNote(n))!.id;
    expect(flowText(flowOf(s.doc))).toBe(
      [
        `Prototype: 2 pages. Start page: “Sign in” (${id['Sign in']}); Play starts there.`,
        `1. “Sign in” (${id['Sign in']}) · start · phone · 0.1 KB`,
        `   button “Sign in” data-goto “Home” → “Home” (${id.Home}) · arrow id5`,
        '   1 <a href="#…"> without data-goto: clicking it does nothing',
        '   writes: email',
        `2. “Home” (${id.Home}) · phone · 0.0 KB`,
        '   no links out (an end page)',
        '   shows: email',
        `   note: “Do we need the name field? It slows peop…” (${note})`,
        'Reachable from “Sign in”: 2/2 by links in the pages; 2/2 with Play\'s arrow chips.',
        'Unreachable: none.',
        'Broken links: none.',
        'Shared state (Play/Interact only): email written on “Sign in”, shown on “Home”.',
      ].join('\n'),
    );
  });

  it('F6 state shown but never written; written but never shown', () => {
    const { s } = make([['A', '<input data-store="x"><span data-show="y"></span>']]);
    expect(flowText(flowOf(s.doc))).toContain('x written on “A”, never shown; y never written, shown on “A”');
  });

  it('F7 warnings: dead anchors, unresolved target, no links out, blank page', () => {
    const { s, id } = make([['A', '<a href="#">x</a><a href="#">y</a><button data-goto="Z">z</button>'], ['B', '<p>end</p>'], ['C', '']]);
    s.dispatch('page.edit', { id: id.C, html: '' });
    expect(pageWarnings(s.doc, id.A)).toEqual(['2 <a href="#…"> have no data-goto: they do nothing in Play. Use data-goto="<page title>"', 'data-goto “Z” finds no page yet: create it, then page.autoLink']);
    expect(pageWarnings(s.doc, id.B)).toEqual(['no data-goto: nothing in this page navigates (fine for an end page)']);
    expect(pageWarnings(s.doc, id.C)).toEqual(['blank page: page.edit {id, html} writes its HTML']);
  });
});

describe('prototype command changes', () => {
  it('C1 create {start: true} moves the start flag; without it nothing changes', () => {
    const { s, id } = make([['A', '<p>a</p>'], ['B', '<p>b</p>']]);
    expect(pages(s.doc).filter((p) => page(p).start).map((p) => p.id)).toEqual([id.A]);
    s.dispatch('page.create', { x: 900, y: 0, title: 'C', html: '<p>c</p>' });
    expect(pages(s.doc).filter((p) => page(p).start).map((p) => p.id)).toEqual([id.A]);
    const c = s.dispatch('page.create', { x: 1300, y: 0, title: 'D', html: '<p>d</p>', start: true }).select![0];
    expect(pages(s.doc).filter((p) => page(p).start).map((p) => p.id)).toEqual([c]);
  });

  it('C2 seed keeps a start page that exists; on an empty board Landing is start', () => {
    const { s, id } = make([['A', '<p>a</p>']]);
    s.dispatch('page.seed', { x: 600, y: 0 });
    expect(pages(s.doc).filter((p) => page(p).start).map((p) => p.id)).toEqual([id.A]);
    const e = store();
    e.dispatch('page.seed', { x: 0, y: 0 });
    expect(pages(e.doc).filter((p) => page(p).start).map((p) => page(p).title)).toEqual(['Landing']);
  });
});
