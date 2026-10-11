import type { CanvasEdge, CanvasNode, DocView } from '../../core';

// Prototype pages: HTML documents as canvas nodes, edges between them = navigation.
// A page is a JSON Canvas `text` node with `x-page: { title, html, vw }` (`text` holds a short
// markdown stand-in so other JSON Canvas apps show something). A sticky note is a `text` node with
// `x-page: { note: true, on?: <page id> }` (rides the page it was dropped on). Links are plain
// JSON Canvas edges (fromNode → toNode, `label` = the action, e.g. "Continue").

export const FIELD = 'x-page';
/** Height of the page's title bar (canvas px), above the scaled document. */
export const HEADER = 26;

export interface PageField {
  title: string;
  html: string;
  /** The device width the HTML is laid out at (CSS px); the node scales it to its own width. */
  vw: number;
  /** The flow's start page (Play starts here when nothing is selected). */
  start?: true;
}
export interface NoteField {
  note: true;
  /** The page this note annotates: it moves with that page. */
  on?: string;
}

export const DEVICES = [
  { id: 'phone', label: 'Phone (390)', vw: 390, vh: 780 },
  { id: 'tablet', label: 'Tablet (820)', vw: 820, vh: 1100 },
  { id: 'desktop', label: 'Desktop (1280)', vw: 1280, vh: 800 },
] as const;

/** Canvas size of a page node showing a `vw` x `vh` document at `scale`. */
export const pageSize = (vw: number, vh: number, scale = 0.5) => ({ width: Math.round(vw * scale), height: Math.round(vh * scale) + HEADER });

const field = (n: CanvasNode | undefined) => n?.[FIELD] as Record<string, unknown> | undefined;
export const isPage = (n: CanvasNode | undefined): n is CanvasNode => typeof field(n)?.html === 'string';
export const isNote = (n: CanvasNode | undefined): n is CanvasNode => field(n)?.note === true;
export const page = (n: CanvasNode) => n[FIELD] as PageField;
export const note = (n: CanvasNode) => n[FIELD] as NoteField;
export const titleOf = (n: CanvasNode | undefined) => (n && isPage(n) ? page(n).title : '') || 'Untitled';

/** The document height (CSS px) a page node shows at its current size. */
export function docHeight(n: CanvasNode): number {
  const s = n.width / page(n).vw;
  return Math.max(1, Math.round((n.height - HEADER) / s));
}

export const pages = (doc: DocView) => doc.nodes.filter(isPage);
export const outgoing = (doc: DocView, id: string) => doc.edges.filter((e) => e.fromNode === id && isPage(doc.get(e.toNode)));
export const incoming = (doc: DocView, id: string) => doc.edges.filter((e) => e.toNode === id && isPage(doc.get(e.fromNode)));

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

export interface Resolved {
  to: string;
  /** The edge followed; undefined = went by page title without an edge on the canvas. */
  edge?: CanvasEdge;
}

/**
 * Where a link inside page `from` goes. `target` = the `data-goto` value: an outgoing edge's label,
 * else the title of a page an outgoing edge reaches, else any page with that title (no edge: the
 * canvas doesn't show this path yet). Empty target = the only outgoing edge, if there is exactly one.
 */
export function resolveLink(doc: DocView, from: string, target: string | undefined): Resolved | undefined {
  const out = outgoing(doc, from);
  const t = norm(target);
  if (!t) return out.length === 1 ? { to: out[0].toNode, edge: out[0] } : undefined;
  const byLabel = out.find((e) => norm(e.label) === t);
  if (byLabel) return { to: byLabel.toNode, edge: byLabel };
  const byTitle = out.find((e) => norm(titleOf(doc.get(e.toNode))) === t);
  if (byTitle) return { to: byTitle.toNode, edge: byTitle };
  const p = pages(doc).find((n) => n.id !== from && norm(page(n).title) === t);
  return p ? { to: p.id } : undefined;
}

/** The page Play starts at: a selected page, else the start page, else the first page of the flow. */
export function startPage(doc: DocView, selected: string[] = []): string | undefined {
  const sel = selected.map((id) => doc.get(id)).find(isPage);
  if (sel) return sel.id;
  const all = pages(doc);
  const flagged = all.find((n) => page(n).start);
  if (flagged) return flagged.id;
  return flowOrder(doc)[0]?.[0];
}

/**
 * Pages in flow columns, left → right: column 0 = pages nothing links to (the start page first),
 * then each page one step further than the closest page linking to it. Cycles are cut where met.
 */
export function flowOrder(doc: DocView): string[][] {
  const all = pages(doc).sort((a, b) => a.x - b.x || a.y - b.y);
  if (!all.length) return [];
  const depth = new Map<string, number>();
  const roots = all.filter((n) => page(n).start || !incoming(doc, n.id).length);
  roots.sort((a, b) => Number(!!page(b).start) - Number(!!page(a).start));
  const queue = (roots.length ? roots : [all[0]]).map((n) => n.id);
  for (const id of queue) depth.set(id, 0);
  const visit = () => {
    while (queue.length) {
      const id = queue.shift()!;
      for (const e of outgoing(doc, id)) {
        if (depth.has(e.toNode)) continue;
        depth.set(e.toNode, depth.get(id)! + 1);
        queue.push(e.toNode);
      }
    }
  };
  visit();
  // pages only reachable through a cycle: start a new chain from each
  for (const n of all) {
    if (depth.has(n.id)) continue;
    depth.set(n.id, 0);
    queue.push(n.id);
    visit();
  }
  const cols: string[][] = [];
  for (const n of all) (cols[depth.get(n.id)!] ??= []).push(n.id);
  return cols.filter(Boolean);
}

/** `data-goto` targets and their link text, found in a page's HTML (for Auto-link). */
export function linksIn(html: string): { target: string; text: string }[] {
  const out: { target: string; text: string }[] = [];
  const re = /<([a-z][a-z0-9]*)\b[^>]*\bdata-goto\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of html.matchAll(re)) {
    const target = (m[3] ?? m[4] ?? '').trim();
    const text = m[5].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (target) out.push({ target, text: text || target });
  }
  return out;
}

/** Markdown stand-in for JSON Canvas apps that don't know pages. */
export const standIn = (title: string) => `### ${title}\n*Prototype page (HTML in \`${FIELD}.html\`)*`;
