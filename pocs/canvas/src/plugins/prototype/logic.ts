import * as z from 'zod/mini';
import { command, nodeRef, view, type CommandSpec } from '../../core/agent';
import type { CanvasNode, Command, DocView, Store } from '../../core';
import { titleOf as nodeTitle } from '../../core/query';
import type { PluginLogic } from '../logic';
import { NOTE_W, NOTE_H, commands, duplicateRule, freeSpot } from './commands';
import { flowOf, flowText, pageFlow, pageHtml, pageHtmlText, pageWarnings } from './flow';
import { repairImport } from './io';
import { SEED_PAGES } from './seed';
import { DEVICES, isNote, isPage, note, page, pageSize, pages, startPage, titleOf } from './model';

// Agent side: a spec per command, the page.flow and page.html views, the guide. Refusals with a reason
// are thrown in the adapters (`toCommand`); the commands keep the store contract (bad args do
// nothing), so the UI, which dispatches without specs, is unchanged.

const ref = nodeRef('page (id or its title)');
const noteRef = nodeRef('sticky note (id or its text)');
const device = z.enum(['phone', 'tablet', 'desktop']).check(z.meta({ description: 'phone (390 wide), tablet (820) or desktop (1280): the width the HTML is laid out at' }));
const title = z.string().check(z.minLength(1), z.maxLength(80));
const html = z.string().check(z.maxLength(200_000));

const q = (s: string) => `“${s}”`;
const norm = (s: string) => s.trim().toLowerCase();
const quoted = (n: CanvasNode | undefined, id: string) => (n ? `${q(nodeTitle(n) || n.type)} (${id})` : `no node ${id}`);
const pagesList = (doc: DocView) => pages(doc).map((p) => `${q(titleOf(p))} (${p.id})`).join(', ') || 'none yet (page.create makes one)';

function needPage(doc: DocView, id: string): CanvasNode {
  const n = doc.get(id);
  if (isPage(n)) return n!;
  throw new Error(n ? `${quoted(n, id)} is not a page; pages: ${pagesList(doc)}` : `no node ${id}`);
}
function needNote(doc: DocView, id: string): CanvasNode {
  const n = doc.get(id);
  if (isNote(n)) return n!;
  throw new Error(n ? `${quoted(n, id)} is not a page note` : `no node ${id}`);
}
/** Links and refs find pages by title, so agents may not make two pages with one title. */
function titleTaken(doc: DocView, t: string, except?: string) {
  const hit = pages(doc).find((p) => p.id !== except && norm(titleOf(p)) === norm(t));
  if (hit) throw new Error(`a page titled ${q(titleOf(hit))} (${hit.id}) exists: page titles must be unique, since data-goto and refs find pages by title`);
}
const bothOrNeither = (a: { x?: number; y?: number }) => {
  if ((a.x === undefined) !== (a.y === undefined)) throw new Error('give both x and y (top-left), or neither');
};
const changed = (r: { changes: unknown[] }) => r.changes.length;
const vwOf = (d: 'phone' | 'tablet' | 'desktop') => DEVICES.find((x) => x.id === d)!;
const deviceOf = (n: CanvasNode) => DEVICES.find((d) => d.vw === page(n).vw)?.id ?? `${page(n).vw}px`;
const linkRows = (doc: DocView, id: string) => pageFlow(doc, id).links.map((l) => ({ target: l.target, ...(l.toTitle ? { to: l.toTitle } : {}), ...(l.arrow ? { arrow: l.arrow } : {}) }));
/** The CLI prints only the id of a result that has one; links and warnings must show. */
const asJson = (v: unknown) => JSON.stringify(v, null, 2);
const arrowBetween = (doc: DocView, from: string, to: string) => doc.edges.find((e) => e.fromNode === from && e.toNode === to);

/** The title a rename started from, per call (the adapter and the result share the ctx). */
const renamed = new WeakMap<object, string>();

const GUIDE = `A prototype is HTML pages linked into a flow that people click through (Play, ⇧↵, or Interact on the canvas).
- page.create {title, html} adds a page right of everything (phone width; device: tablet/desktop). The first page on an empty board is the start page; page.start {id} picks another.
- Clicks live in the page HTML: data-goto="<page title>" on any element (button, a, div) goes to that page; data-back goes back. <a href="#…"> without data-goto does nothing.
- Make the pages, then run page.autoLink once: it draws an arrow for each data-goto that finds its page (the flow on the canvas; chips under the page in Play). page.link {from, to, label} draws an arrow by hand; it makes nothing in the page clickable.
- State across pages: data-store="name" on an input keeps what is typed; data-show="name" shows it on later pages (in Play and Interact only). Scripts: canvas.set(k, v), canvas.state, canvas.goto(title), canvas.back().
- Pages are self-contained: inline <style> and <script>, images as data: URLs; network is blocked.
- page.edit {id, title?, html?} changes a page; the view page.html {id} reads its HTML. Renaming breaks data-goto links that use the old title: the result lists them.
- Check with the view page.flow: every link and where it goes, broken links, pages Play can't reach, shared state.
- page.arrange lays the pages out by step; page.note {on, text} adds a sticky note to a page; page.seed adds a 5-page example flow.
- Play and Interact are people's screens: an agent can't play, or see what someone typed while playing.`;

export const specs: Record<string, CommandSpec> = {
  create: command({
    description:
      'Add a page: an HTML document shown as a node. Make things clickable with data-goto="<page title>" (href="#" does nothing); then page.autoLink draws the arrows. No x/y puts it right of everything; the first page of an empty board becomes the start page. Returns the id, the links found in the HTML and warnings.',
    args: z.strictObject({
      title,
      html: z.optional(html.check(z.meta({ description: 'the whole page: inline <style>/<script>, self-contained (default: a blank page)' }))),
      device: z.optional(device),
      x: z.optional(z.number()),
      y: z.optional(z.number()),
      start: z.optional(z.boolean().check(z.meta({ description: 'make it the start page (default: true for the first page of an empty board)' }))),
    }),
    example: { title: 'Sign in', html: '<h1>Sign in</h1><input placeholder="Email"><button data-goto="Home">Sign in</button>' },
    text: asJson,
    toCommand: ({ device: d, start, title: t, ...a }, ctx) => {
      bothOrNeither(a);
      const name = t.trim();
      if (!name) throw new Error('the title is empty');
      titleTaken(ctx.doc, name);
      const dev = vwOf(d ?? 'phone');
      const at = a.x !== undefined ? { x: a.x, y: a.y } : freeSpot(ctx.doc, pageSize(dev.vw, dev.vh).width, pageSize(dev.vw, dev.vh).height);
      return { ...a, ...at, title: name, vw: dev.vw, start: start ?? !pages(ctx.doc).length };
    },
    result: (r, _a, ctx) => {
      const id = r.select![0] as string;
      const n = ctx.doc.get(id)!;
      const w = pageWarnings(ctx.doc, id);
      return { id, title: titleOf(n), device: deviceOf(n), start: !!page(n).start, x: n.x, y: n.y, links: linkRows(ctx.doc, id), ...(w.length ? { warnings: w } : {}) };
    },
  }),
  edit: command({
    description: "Change a page's title and/or HTML (give at least one; html replaces the whole page, read it first with the view page.html). Renaming breaks data-goto links in other pages that used the old title: the result lists them.",
    args: z.strictObject({ id: ref, title: z.optional(title), html: z.optional(html) }),
    example: { id: 'Sign in', html: '<h1>Sign in</h1><input placeholder="Email"><button data-goto="Home">Go</button>' },
    text: asJson,
    toCommand: ({ id, title: t, html: h }, ctx) => {
      const n = needPage(ctx.doc, id);
      if (t === undefined && h === undefined) throw new Error('give a title, html, or both');
      const name = t?.trim();
      if (t !== undefined && !name) throw new Error('the title is empty');
      if (name) titleTaken(ctx.doc, name, id);
      if (name && norm(name) !== norm(titleOf(n))) renamed.set(ctx, titleOf(n));
      return { id, ...(name ? { title: name } : {}), ...(h !== undefined ? { html: h } : {}) };
    },
    result: (r, a, ctx) => {
      const old = renamed.get(ctx);
      const w = pageWarnings(ctx.doc, a.id);
      const broken = old
        ? pages(ctx.doc)
            .filter((p) => p.id !== a.id)
            .flatMap((p) => pageFlow(ctx.doc, p.id).links.filter((l) => l.broken && norm(l.target) === norm(old)).map((l) => `${q(titleOf(p))} → ${q(l.target)}`))
        : [];
      return { id: a.id, title: titleOf(ctx.doc.get(a.id)!), changed: changed(r), links: linkRows(ctx.doc, a.id), ...(broken.length ? { broken } : {}), ...(w.length ? { warnings: w } : {}) };
    },
  }),
  device: command({
    description: 'Set the device width a page is laid out at (phone 390, tablet 820, desktop 1280). Its width on the canvas stays, so it re-scales.',
    args: z.strictObject({ id: ref, device }),
    example: { id: 'Home', device: 'desktop' },
    toCommand: ({ id, device: d }, ctx) => (needPage(ctx.doc, id), { id, vw: vwOf(d).vw }),
    result: (r, a, ctx) => ({ id: a.id, device: deviceOf(ctx.doc.get(a.id)!), changed: changed(r) }),
  }),
  scale: command({
    description: 'Make a page bigger or smaller on the canvas (width 120..2000 px) by a factor, e.g. 1.25. Only its size on the canvas: the device width the HTML is laid out at stays (see device).',
    args: z.strictObject({ id: ref, factor: z.number().check(z.gt(0)) }),
    example: { id: 'Home', factor: 1.25 },
    toCommand: (a, ctx) => (needPage(ctx.doc, a.id), a),
    result: (r, a, ctx) => ({ id: a.id, width: ctx.doc.get(a.id)!.width, height: ctx.doc.get(a.id)!.height, changed: changed(r) }),
  }),
  start: command({
    description: 'Make a page the start page: where Play begins and the first step of the flow. Only one page is the start page. Doing it again changes nothing.',
    args: z.strictObject({ id: ref }),
    example: { id: 'Sign in' },
    toCommand: (a, ctx) => (needPage(ctx.doc, a.id), a),
    result: (r, a, ctx) => ({ id: a.id, title: titleOf(ctx.doc.get(a.id)!), changed: changed(r) }),
  }),
  link: command({
    description:
      'Draw an arrow from one page to another (the flow on the canvas, a chip under the page in Play, and what data-goto="<label>" finds). It makes nothing in the page clickable: that needs data-goto in the HTML. Linking the same pair again replaces the label. Most arrows come from page.autoLink.',
    args: z.strictObject({ from: ref, to: ref, label: z.optional(z.string().check(z.maxLength(60))) }),
    example: { from: 'Sign in', to: 'Home', label: 'Sign in' },
    toCommand: (a, ctx) => {
      needPage(ctx.doc, a.from);
      needPage(ctx.doc, a.to);
      if (a.from === a.to) throw new Error('a page cannot link to itself');
      return a;
    },
    result: (r, a, ctx) => {
      const e = arrowBetween(ctx.doc, a.from, a.to)!;
      return { arrow: e.id, from: titleOf(ctx.doc.get(a.from)!), to: titleOf(ctx.doc.get(a.to)!), ...(e.label ? { label: e.label } : {}), changed: changed(r) };
    },
  }),
  unlink: command({
    description: 'Remove an arrow between pages, by its id (from page.link, page.autoLink or the page.flow view) or by the two pages it joins. The data-goto in the HTML stays.',
    args: z.strictObject({ edge: z.optional(z.string().check(z.meta({ description: 'arrow id' }))), from: z.optional(ref), to: z.optional(ref) }),
    example: { from: 'Sign in', to: 'Home' },
    toCommand: ({ edge, from, to }, ctx) => {
      if (edge !== undefined && (from !== undefined || to !== undefined)) throw new Error('give the arrow id, or from and to, not both');
      if (edge !== undefined) {
        const e = ctx.doc.edges.find((x) => x.id === edge);
        if (!e || !isPage(ctx.doc.get(e.fromNode)) || !isPage(ctx.doc.get(e.toNode))) throw new Error(`no arrow ${edge} between pages`);
        return { edge };
      }
      if (from === undefined || to === undefined) throw new Error('give the arrow id (edge), or from and to');
      needPage(ctx.doc, from);
      needPage(ctx.doc, to);
      const e = arrowBetween(ctx.doc, from, to);
      if (!e) throw new Error(`no arrow from ${quoted(ctx.doc.get(from), from)} to ${quoted(ctx.doc.get(to), to)}`);
      return { edge: e.id };
    },
    result: (r) => ({ changed: changed(r) }),
  }),
  autoLink: command({
    description:
      'Draw an arrow for every data-goto in the pages (or only in `ids`) that finds its page and has no arrow yet; the arrow is labelled with the link text. Run it once after making the pages. `missing` lists data-goto targets that find no page.',
    args: z.strictObject({ ids: z.optional(z.array(ref)) }),
    example: {},
    toCommand: ({ ids }, ctx) => {
      for (const id of ids ?? []) needPage(ctx.doc, id);
      return ids ? { ids } : {};
    },
    result: (r, a, ctx) => {
      const arrows = r.changes.flatMap((c) => (c.op === 'edge' ? [c.edge] : []));
      const scope = (a.ids ?? pages(ctx.doc).map((p) => p.id)).filter((id, i, all) => all.indexOf(id) === i);
      const missing = scope.flatMap((id) => pageFlow(ctx.doc, id).links.filter((l) => l.broken).map((l) => `${q(titleOf(ctx.doc.get(id)!))} → ${l.target ? q(l.target) : '(empty data-goto)'}`));
      return { linked: arrows.length, arrows: arrows.map((e) => ({ id: e.id, from: titleOf(ctx.doc.get(e.fromNode)!), to: titleOf(ctx.doc.get(e.toNode)!), ...(e.label ? { label: e.label } : {}) })), missing };
    },
  }),
  arrange: command({
    description: 'Lay the pages out as a flow, left to right by step (the start page first), notes riding along. x/y is the top-left of the layout (default: where the pages are now).',
    args: z.strictObject({ x: z.optional(z.number()), y: z.optional(z.number()) }),
    example: {},
    toCommand: (a) => (bothOrNeither(a), a),
    result: (r) => ({ changed: changed(r) }),
  }),
  note: command({
    description: 'Add a sticky note, on a page (it moves with the page) or free. With `on` and no x/y it goes under that page; with neither it goes right of everything.',
    args: z.strictObject({ text: z.string().check(z.maxLength(2000)), on: z.optional(ref), x: z.optional(z.number()), y: z.optional(z.number()) }),
    example: { on: 'Sign in', text: 'Do we need the name field?' },
    toCommand: ({ text, on, ...a }, ctx) => {
      bothOrNeither(a);
      const p = on !== undefined ? needPage(ctx.doc, on) : undefined;
      const at = a.x !== undefined ? { x: a.x, y: a.y } : p ? { x: p.x + 16, y: p.y + p.height + 24 } : freeSpot(ctx.doc, NOTE_W, NOTE_H);
      return { text, ...at, ...(p ? { on: p.id } : {}) };
    },
    result: (r, _a, ctx) => {
      const id = r.select![0] as string;
      const on = note(ctx.doc.get(id)!).on;
      return { id, ...(on ? { on: titleOf(ctx.doc.get(on)!) } : {}) };
    },
  }),
  noteText: command({
    description: "Change a page note's text.",
    args: z.strictObject({ id: noteRef, text: z.string().check(z.maxLength(2000)) }),
    example: { id: 'Do we need', text: 'Name field: cut it.' },
    toCommand: (a, ctx) => (needNote(ctx.doc, a.id), a),
    result: (r, a) => ({ id: a.id, changed: changed(r) }),
  }),
  attach: command({
    description: 'Attach notes to the page under their center, or detach them when they sit on none (after core.move of a note). page.note {on} is the usual way.',
    args: z.strictObject({ ids: z.array(noteRef).check(z.minLength(1)) }),
    example: { ids: ['Do we need'] },
    toCommand: (a, ctx) => {
      for (const id of a.ids) needNote(ctx.doc, id);
      return a;
    },
    result: (r) => ({ changed: changed(r) }),
  }),
  seed: command({
    description:
      'Add the 5-page example flow (Landing → Sign up → Plan → Checkout → Welcome) with notes: data-goto by page title and arrow label, data-back, data-store/data-show, and a script with canvas.set. Read a page with the view page.html to copy the patterns. No x/y puts it right of everything. A start page that already exists stays. Refuses if a page already has one of its titles.',
    args: z.strictObject({ x: z.optional(z.number()), y: z.optional(z.number()) }),
    example: {},
    toCommand: (a, ctx) => {
      bothOrNeither(a);
      const taken = SEED_PAGES.filter((p) => pages(ctx.doc).some((n) => norm(titleOf(n)) === norm(p.title)));
      if (taken.length) throw new Error(`the example's page titles must be unique, but ${taken.map((p) => q(p.title)).join(', ')} already exist${taken.length === 1 ? 's' : ''}: rename those pages first`);
      return a.x !== undefined ? a : freeSpot(ctx.doc, 1, 1);
    },
    result: (r, _a, ctx) => {
      const ids = (r.select ?? []) as string[];
      return { pages: Object.fromEntries(ids.map((id) => [titleOf(ctx.doc.get(id)!), id])), start: startPage(ctx.doc) };
    },
  }),
};

/** The data side (commands, rider rule, views). No DOM; used by the browser, the bridge and tests. */
export function registerPrototypeLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`page.${name}`, cmd as Command, specs[name]);
  store.registerView(
    'page.flow',
    view({
      description:
        "The prototype as a flow: pages in step order with the start page, every link in each page (data-goto, data-back) and where it goes, arrows with no link in the page, broken and dead links, pages no link in the pages reaches, and shared state keys.",
      args: z.strictObject({}),
      example: {},
      read: (doc) => flowOf(doc),
      text: (v) => flowText(v as ReturnType<typeof flowOf>),
    }),
  );
  store.registerView(
    'page.html',
    view({
      description: "One page's HTML, verbatim (to change it with page.edit).",
      args: z.strictObject({ id: ref }),
      example: { id: 'Sign in' },
      read: (doc, a) => {
        const n = needPage(doc, a.id);
        return pageHtml(doc, n.id);
      },
      text: (v) => pageHtmlText(v as ReturnType<typeof pageHtml>),
    }),
  );
  // a note rides the page it annotates
  store.addRiderRule((n) => (isNote(n) ? note(n).on : undefined));
  store.importFilters.push(repairImport);
  store.duplicateRules.push((n) => duplicateRule(n));
}

export const logic: PluginLogic = {
  id: 'prototype',
  title: 'Prototype',
  summary: 'Clickable prototypes: HTML pages linked into a flow, played full screen.',
  guide: GUIDE,
  register: registerPrototypeLogic,
};
