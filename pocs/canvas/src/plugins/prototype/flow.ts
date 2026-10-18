import type { DocView } from '../../core';
import { BLANK_HTML } from './seed';
import { DEVICES, flowOrder, isNote, note, outgoing, page, resolveLink, startPage, titleOf } from './model';

// The prototype as a flow, for agents: what Play would do on each link, without playing. Node-safe
// (no DOM). Links are found by scanning the page HTML for attributes (void, bare and unquoted
// data-goto too; Auto-link adds what `linksIn` misses from this scan): an attribute inside a comment
// or a script string counts too.

export interface PageLink {
  tag: string;
  /** The element's text (empty for elements with no closing tag, like <input>). */
  text: string;
  /** The data-goto value. */
  target: string;
  to?: string;
  toTitle?: string;
  /** The arrow the link resolved through; none = resolved by page title alone. */
  arrow?: string;
  broken?: true;
}
export interface ArrowOnly {
  id: string;
  label?: string;
  to: string;
  toTitle: string;
}
export interface PageFlow {
  id: string;
  title: string;
  start: boolean;
  device: string;
  vw: number;
  kb: number;
  links: PageLink[];
  arrowsOnly: ArrowOnly[];
  /** How the page goes back: `data-back` or `canvas.back()`. */
  back?: string;
  /** A script calls canvas.goto(): not followed. */
  script: boolean;
  /** `<a href="#…">` with no data-goto, data-back or onclick, and no id/name in the page for the fragment: clicking does nothing. */
  dead: number;
  writes: string[];
  shows: string[];
  notes: { id: string; text: string }[];
}
export interface Flow {
  /** The page Play starts at. */
  start?: string;
  startFlagged: boolean;
  pages: PageFlow[];
  /** Reachable from the start page by links in the pages. */
  inPage: string[];
  /** ... plus the arrows (Play's chips). */
  withArrows: string[];
  unreachable: string[];
  broken: { from: string; fromTitle: string; target: string }[];
  state: Record<string, { writes: string[]; shows: string[] }>;
}

const clean = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');

/** Every element with a data-goto attribute, in document order. */
export function gotoElements(html: string): { tag: string; text: string; target: string }[] {
  const out: { tag: string; text: string; target: string }[] = [];
  const re = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  // quoted, unquoted or bare (bare = empty target: the page's only arrow); entities decoded for & < > "
  const goto = /\bdata-goto(?![\w-])(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/i;
  const decode = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const m of html.matchAll(re)) {
    const g = goto.exec(m[2]);
    if (!g) continue;
    const tag = m[1].toLowerCase();
    const rest = html.slice(m.index! + m[0].length);
    const close = rest.toLowerCase().indexOf(`</${tag}>`);
    const text = close >= 0 && !/^(input|img|br|hr|meta|link)$/.test(tag) ? clean(rest.slice(0, close)) : '';
    out.push({ tag, text, target: decode(g[1] ?? g[2] ?? g[3] ?? '').trim() });
  }
  return out;
}

/**
 * `<a href="#">` / `href="#x"` with no id/name "x" in the page and no data-goto, data-back or onclick on the
 * anchor: clicking does nothing. An anchor inside a data-goto container still counts (the container navigates).
 */
const deadAnchors = (html: string) => {
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...html.matchAll(/<a\b[^>]*>/gi)].filter((m) => {
    const h = /\bhref\s*=\s*["']#([^"']*)["']/i.exec(m[0]);
    if (!h || /\b(data-goto|data-back|onclick)\b/i.test(m[0])) return false;
    return !h[1] || !new RegExp(`(?<![\\w-])id\\s*=\\s*["']${esc(h[1])}["']|<a\\b[^>]*\\bname\\s*=\\s*["']${esc(h[1])}["']`, 'i').test(html);
  }).length;
};

function stateOf(html: string) {
  const writes = new Set<string>();
  const shows = new Set<string>();
  for (const m of html.matchAll(new RegExp(ATTR('data-store'), 'gi'))) writes.add((m[1] ?? m[2]).trim());
  for (const m of html.matchAll(/\bcanvas\s*\.\s*set\s*\(\s*(?:"([^"]*)"|'([^']*)')/g)) writes.add(m[1] ?? m[2]);
  for (const m of html.matchAll(new RegExp(ATTR('data-show'), 'gi'))) shows.add((m[1] ?? m[2]).trim());
  for (const m of html.matchAll(/\bcanvas\s*\.\s*state\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(?:"([^"]*)"|'([^']*)')\s*\])/g)) shows.add(m[1] ?? m[2] ?? m[3]);
  writes.delete('');
  shows.delete('');
  return { writes: [...writes], shows: [...shows] };
}

/** Links, arrows, back, dead anchors and state keys of one page. */
export function pageFlow(doc: DocView, id: string): PageFlow {
  const n = doc.get(id)!;
  const html = page(n).html;
  const links: PageLink[] = gotoElements(html).map((e) => {
    const r = resolveLink(doc, id, e.target);
    return r ? { ...e, to: r.to, toTitle: titleOf(doc.get(r.to)), ...(r.edge ? { arrow: r.edge.id } : {}) } : { ...e, broken: true as const };
  });
  const used = new Set(links.map((l) => l.arrow));
  const arrowsOnly = outgoing(doc, id)
    .filter((e) => !used.has(e.id))
    .map((e) => ({ id: e.id, ...(e.label ? { label: e.label } : {}), to: e.toNode, toTitle: titleOf(doc.get(e.toNode)) }));
  const markup = html.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const back = /<[a-z][^>]*\bdata-back\b/i.test(markup) ? 'data-back' : /\bcanvas\s*\.\s*back\s*\(/.test(html) ? 'canvas.back()' : undefined;
  const notes = doc.nodes.filter((r) => isNote(r) && note(r).on === id).map((r) => ({ id: r.id, text: (r.text ?? '').trim() }));
  return {
    id,
    title: titleOf(n),
    start: !!page(n).start,
    device: DEVICES.find((d) => d.vw === page(n).vw)?.id ?? `${page(n).vw}px`,
    vw: page(n).vw,
    kb: Math.round((html.length / 1024) * 10) / 10,
    links,
    arrowsOnly,
    ...(back ? { back } : {}),
    script: /\bcanvas\s*\.\s*goto\s*\(/.test(html),
    dead: deadAnchors(html),
    ...stateOf(html),
    notes,
  };
}

function reach(start: string | undefined, edges: [string, string][]): string[] {
  const seen = new Set<string>(start ? [start] : []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [f, t] of edges) if (seen.has(f) && !seen.has(t)) seen.add(t), (grew = true);
  }
  return [...seen];
}

export function flowOf(doc: DocView): Flow {
  const order = flowOrder(doc).flat();
  const ps = order.map((id) => pageFlow(doc, id));
  const start = startPage(doc);
  const links: [string, string][] = ps.flatMap((p) => p.links.filter((l) => l.to).map((l) => [p.id, l.to!] as [string, string]));
  const arrows: [string, string][] = ps.flatMap((p) => outgoing(doc, p.id).map((e) => [e.fromNode, e.toNode] as [string, string]));
  const inPage = reach(start, links);
  const withArrows = reach(start, [...links, ...arrows]);
  const state: Flow['state'] = {};
  for (const p of ps) {
    for (const k of p.writes) (state[k] ??= { writes: [], shows: [] }).writes.push(p.id);
    for (const k of p.shows) (state[k] ??= { writes: [], shows: [] }).shows.push(p.id);
  }
  return {
    ...(start ? { start } : {}),
    startFlagged: ps.some((p) => p.start),
    pages: ps,
    inPage,
    withArrows,
    unreachable: order.filter((id) => !inPage.includes(id)),
    broken: ps.flatMap((p) => p.links.filter((l) => l.broken).map((l) => ({ from: p.id, fromTitle: p.title, target: l.target }))),
    state,
  };
}

const q = (s: string) => `“${s}”`;
const ref = (title: string, id: string) => `${q(title)} (${id})`;
const cut = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function flowText(f: Flow): string {
  if (!f.pages.length) return 'No prototype pages yet. page.create {title, html} adds one; page.seed adds a 5-page example flow.';
  const title = (id: string) => f.pages.find((p) => p.id === id)!.title;
  const lines: string[] = [];
  const st = f.start ? ref(title(f.start), f.start) : '';
  lines.push(`Prototype: ${f.pages.length} page${f.pages.length === 1 ? '' : 's'}. ${f.startFlagged ? `Start page: ${st}; Play starts there.` : `Start page: none set; Play starts at ${st} (first in the flow). page.start sets one.`}`);
  f.pages.forEach((p, i) => {
    lines.push(`${i + 1}. ${ref(p.title, p.id)}${p.start ? ' · start' : ''} · ${p.device} · ${p.kb.toFixed(1)} KB`);
    for (const l of p.links) {
      const what = `${l.tag}${l.text ? ` ${q(cut(l.text))}` : ''} data-goto ${q(l.target)}`;
      if (l.broken) lines.push(`   ${what} → BROKEN: ${l.target ? `no page titled ${q(l.target)}, no arrow labelled ${q(l.target)}` : 'empty data-goto needs exactly one arrow out of this page'}`);
      else lines.push(`   ${what} → ${ref(l.toTitle!, l.to!)} · ${l.arrow ? `arrow ${l.arrow}` : 'no arrow yet (page.autoLink draws it)'}`);
    }
    for (const a of p.arrowsOnly) lines.push(`   arrow ${a.id}${a.label ? ` ${q(a.label)}` : ''} → ${ref(a.toTitle, a.to)}: only a chip in Play, nothing in the page links there`);
    if (p.dead) lines.push(`   ${p.dead} <a href="#…"> without data-goto: clicking ${p.dead === 1 ? 'it does' : 'them does'} nothing`);
    if (p.script) lines.push('   script calls canvas.goto: not checked');
    if (!p.links.length && !p.arrowsOnly.length && !p.script) lines.push(p.back ? '   no links forward (back only)' : '   no links out (an end page)');
    if (p.back) lines.push(`   back: ${p.back}`);
    if (p.writes.length) lines.push(`   writes: ${p.writes.join(', ')}`);
    if (p.shows.length) lines.push(`   shows: ${p.shows.join(', ')}`);
    for (const n of p.notes) lines.push(`   note: ${q(cut(n.text.replace(/\s+/g, ' ')))} (${n.id})`);
  });
  const from = f.start ? q(title(f.start)) : 'the start';
  lines.push(`Reachable from ${from}: ${f.inPage.length}/${f.pages.length} by links in the pages; ${f.withArrows.length}/${f.pages.length} with Play's arrow chips.`);
  lines.push(`Unreachable: ${f.unreachable.length ? f.unreachable.map((id) => q(title(id))).join(', ') : 'none'}.`);
  lines.push(`Broken links: ${f.broken.length ? f.broken.map((b) => `${q(b.fromTitle)} → ${q(b.target)}`).join(', ') : 'none'}.`);
  const keys = Object.entries(f.state);
  if (keys.length) {
    const names = (ids: string[]) => ids.map((id) => q(title(id))).join(', ');
    lines.push(
      `Shared state (Play/Interact only): ${keys.map(([k, v]) => `${k} ${v.writes.length ? `written on ${names(v.writes)}` : 'never written'}, ${v.shows.length ? `shown on ${names(v.shows)}` : 'never shown'}`).join('; ')}.`,
    );
  }
  return lines.join('\n');
}

/** What `page.html` returns: the page's facts and its HTML verbatim. */
export function pageHtml(doc: DocView, id: string) {
  const { title, start, device, vw, kb } = pageFlow(doc, id);
  return { id, title, start, device, vw, kb, html: page(doc.get(id)!).html };
}
export const pageHtmlText = (v: ReturnType<typeof pageHtml>) => `${q(v.title)} (${v.id})${v.start ? ' · start' : ''} · ${v.device} (${v.vw}) · ${v.kb.toFixed(1)} KB\n${v.html}`;

/** Hints for a create or edit result. */
export function pageWarnings(doc: DocView, id: string): string[] {
  const p = pageFlow(doc, id);
  const html = page(doc.get(id)!).html.trim();
  const out: string[] = [];
  if (!html || html === BLANK_HTML.trim()) return ['blank page: page.edit {id, html} writes its HTML'];
  if (p.dead) out.push(`${p.dead} <a href="#…"> ${p.dead === 1 ? 'has' : 'have'} no data-goto: ${p.dead === 1 ? 'it does' : 'they do'} nothing in Play. Use data-goto="<page title>"`);
  for (const l of p.links) if (l.broken) out.push(l.target ? `data-goto ${q(l.target)} finds no page yet: create it, then page.autoLink` : 'empty data-goto: needs exactly one arrow out of this page');
  if (!p.links.length && !p.script && !p.arrowsOnly.length && !p.back) out.push('no data-goto: nothing in this page navigates (fine for an end page)');
  return out;
}
