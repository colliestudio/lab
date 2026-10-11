import { isNum, pick, set, type CanvasEdge, type CanvasNode, type Change, type Command, type CommandResult, type DocView } from '../../core';
import { BLANK_HTML, SEED_PAGES } from './seed';
import { DEVICES, FIELD, HEADER, flowOrder, isNote, isPage, linksIn, note, outgoing, page, pageSize, pages, resolveLink, standIn, titleOf, type NoteField, type PageField } from './model';

// Commands: plain data in, changes out (an agent can dispatch the same ones).

const str = (v: unknown, max = 200_000) => (typeof v === 'string' && v.length <= max ? v : undefined);
const SCALE = 0.5;
const GAP_X = 140;
const GAP_Y = 90;
export const NOTE_W = 180;
export const NOTE_H = 110;

export function pageNode(id: string, x: number, y: number, z: number, f: PageField, scale = SCALE): CanvasNode {
  const vh = DEVICES.find((d) => d.vw === f.vw)?.vh ?? Math.round(f.vw * 2);
  return { id, type: 'text', x, y, ...pageSize(f.vw, vh, scale), z, text: standIn(f.title), [FIELD]: f };
}
export function noteNode(id: string, x: number, y: number, z: number, text: string, on?: string): CanvasNode {
  const f: NoteField = on ? { note: true, on } : { note: true };
  return { id, type: 'text', x, y, width: NOTE_W, height: NOTE_H, z, color: '3', text, [FIELD]: f };
}
export const edge = (id: string, from: string, to: string, label?: string): CanvasEdge => ({
  id,
  fromNode: from,
  toNode: to,
  fromSide: 'right',
  toSide: 'left',
  toEnd: 'arrow',
  ...(label ? { label } : {}),
});

/** Move a page and the notes riding on it. */
function movePage(doc: DocView, n: CanvasNode, x: number, y: number): Change[] {
  const dx = x - n.x;
  const dy = y - n.y;
  if (!dx && !dy) return [];
  const out = [set(n.id, 'x', x), set(n.id, 'y', y)];
  for (const r of doc.nodes) if (isNote(r) && note(r).on === n.id) out.push(set(r.id, 'x', r.x + dx), set(r.id, 'y', r.y + dy));
  return out;
}

/** Lay pages out left → right by flow step (one column per step), rows top to bottom. */
export function arrangeChanges(doc: DocView, at?: { x: number; y: number }): Change[] {
  const cols = flowOrder(doc);
  if (!cols.length) return [];
  const all = pages(doc);
  const ox = at?.x ?? Math.min(...all.map((n) => n.x));
  const oy = at?.y ?? Math.min(...all.map((n) => n.y));
  const out: Change[] = [];
  let x = ox;
  for (const col of cols) {
    let y = oy;
    const nodes = col.map((id) => doc.get(id)!);
    for (const n of nodes) {
      out.push(...movePage(doc, n, Math.round(x), Math.round(y)));
      y += n.height + GAP_Y + (doc.nodes.some((r) => isNote(r) && note(r).on === n.id) ? NOTE_H : 0);
    }
    x += Math.max(...nodes.map((n) => n.width)) + GAP_X;
  }
  return out;
}

/** Edges for `data-goto` links that have none yet (to a page with that title). `missing` = targets with no such page. */
export function autoLinkChanges(doc: DocView, ids: string[] | undefined, newId: () => string): { changes: Change[]; missing: string[] } {
  const changes: Change[] = [];
  const missing: string[] = [];
  const src = ids ? pick(doc, ids).filter(isPage) : pages(doc);
  for (const p of src) {
    const made = new Set<string>();
    for (const l of linksIn(page(p).html)) {
      const r = resolveLink(doc, p.id, l.target);
      if (!r) {
        missing.push(`${titleOf(p)} → ${l.target}`);
        continue;
      }
      if (r.edge || made.has(r.to) || outgoing(doc, p.id).some((e) => e.toNode === r.to)) continue;
      made.add(r.to);
      changes.push({ op: 'edge', edge: edge(newId(), p.id, r.to, l.text) });
    }
  }
  return { changes, missing };
}

export const commands: Record<string, Command> = {
  /** A new page at (x, y). `html` default: a blank page. */
  create: (doc, a: { x: number; y: number; title?: string; html?: string; vw?: number }, ctx): CommandResult => {
    if (!isNum(a?.x) || !isNum(a?.y)) return { changes: [] };
    const vw = DEVICES.some((d) => d.vw === a.vw) ? a.vw! : DEVICES[0].vw;
    const id = ctx.newId();
    const n = pageNode(id, Math.round(a.x), Math.round(a.y), doc.topZ + 1, { title: str(a.title, 80) ?? 'New page', html: str(a.html) ?? BLANK_HTML, vw });
    return { changes: [{ op: 'add', node: n }], select: [id], events: [{ type: 'page.create', text: `added page ${titleOf(n)}`, targets: [id] }] };
  },
  /** Change a page's title and/or HTML. */
  edit: (doc, a: { id: string; title?: string; html?: string }): CommandResult => {
    const n = doc.get(a?.id);
    if (!isPage(n)) return { changes: [] };
    const out: Change[] = [];
    const title = str(a.title, 80)?.trim();
    if (title && title !== page(n).title) out.push(set(n.id, `${FIELD}.title`, title), set(n.id, 'text', standIn(title)));
    const html = str(a.html);
    if (html !== undefined && html !== page(n).html) out.push(set(n.id, `${FIELD}.html`, html));
    return { changes: out, events: out.length ? [{ type: 'page.edit', text: `edited page ${title ?? titleOf(n)}`, targets: [n.id], key: `page.edit:${n.id}` }] : [] };
  },
  /** Device width (layout) of a page; keeps the canvas width, so it re-scales. */
  device: (doc, a: { id: string; vw: number }) => {
    const n = doc.get(a?.id);
    const d = DEVICES.find((x) => x.vw === a?.vw);
    if (!isPage(n) || !d) return [];
    const s = pageSize(d.vw, d.vh, n.width / d.vw);
    return [set(n.id, `${FIELD}.vw`, d.vw), set(n.id, 'height', s.height)];
  },
  /** Scale a page on the canvas (keeps its document size). */
  scale: (doc, a: { id: string; factor: number }) => {
    const n = doc.get(a?.id);
    if (!isPage(n) || !isNum(a.factor) || a.factor <= 0) return [];
    const w = Math.round(Math.min(2000, Math.max(120, n.width * a.factor)));
    const s = w / n.width;
    return [set(n.id, 'width', w), set(n.id, 'height', Math.round((n.height - HEADER) * s) + HEADER)];
  },
  /** Mark the flow's start page (only one). */
  start: (doc, a: { id: string }) => {
    const n = doc.get(a?.id);
    if (!isPage(n)) return [];
    return pages(doc).flatMap((p) => (p.id === n.id ? (page(p).start ? [] : [set(p.id, `${FIELD}.start`, true)]) : page(p).start ? [set(p.id, `${FIELD}.start`, undefined)] : []));
  },
  /** Link page `from` → `to` with an action label (replaces an edge between them). */
  link: (doc, a: { from: string; to: string; label?: string }, ctx): CommandResult => {
    const from = doc.get(a?.from);
    const to = doc.get(a?.to);
    if (!isPage(from) || !isPage(to) || from.id === to.id) return { changes: [] };
    const old = doc.edges.find((e) => e.fromNode === from.id && e.toNode === to.id);
    const label = str(a.label, 60)?.trim();
    return {
      changes: [{ op: 'edge', edge: { ...edge(old?.id ?? ctx.newId(), from.id, to.id), ...(label ? { label } : {}) } }],
      events: [{ type: 'page.link', text: `linked ${titleOf(from)} → ${titleOf(to)}${label ? ` (${label})` : ''}`, targets: [from.id, to.id] }],
    };
  },
  unlink: (doc, a: { edge: string }) => (doc.edges.some((e) => e.id === a?.edge) ? [{ op: 'delEdge', id: a.edge }] : []),
  /** Make edges for the `data-goto` links in pages (all pages, or `ids`). */
  autoLink: (doc, a: { ids?: string[] }, ctx): CommandResult => {
    const { changes } = autoLinkChanges(doc, Array.isArray(a?.ids) ? a.ids : undefined, ctx.newId);
    return { changes, events: changes.length ? [{ type: 'page.autolink', text: `linked ${changes.length} page link${changes.length > 1 ? 's' : ''}` }] : [] };
  },
  /** Flow overview: pages left → right by step, notes travel with their page. */
  arrange: (doc, a: { x?: number; y?: number }) => arrangeChanges(doc, isNum(a?.x) && isNum(a?.y) ? { x: a.x, y: a.y } : undefined),
  /** A sticky note at (x, y), optionally on a page. */
  note: (doc, a: { x: number; y: number; text?: string; on?: string }, ctx): CommandResult => {
    if (!isNum(a?.x) || !isNum(a?.y)) return { changes: [] };
    const id = ctx.newId();
    const on = a.on && isPage(doc.get(a.on)) ? a.on : undefined;
    return { changes: [{ op: 'add', node: noteNode(id, Math.round(a.x), Math.round(a.y), doc.topZ + 1, str(a.text, 2000) ?? 'Note', on) }], select: [id] };
  },
  noteText: (doc, a: { id: string; text: string }) => {
    const n = doc.get(a?.id);
    const text = str(a?.text, 2000);
    return isNote(n) && text !== undefined && text !== n.text ? [set(n.id, 'text', text)] : [];
  },
  /** Attach notes to the page under their center (or detach). */
  attach: (doc, a: { ids: string[] }) => {
    const out: Change[] = [];
    for (const n of pick(doc, a?.ids).filter(isNote)) {
      const cx = n.x + n.width / 2;
      const cy = n.y + n.height / 2;
      const under = pages(doc)
        .filter((p) => cx >= p.x - 40 && cx <= p.x + p.width + 40 && cy >= p.y - 40 && cy <= p.y + p.height + 40)
        .at(-1);
      if (under?.id !== note(n).on) out.push(set(n.id, `${FIELD}.on`, under?.id));
    }
    return out;
  },
  /** The example signup/checkout flow, laid out from (x, y). */
  seed: (doc, a: { x: number; y: number }, ctx): CommandResult => {
    if (!isNum(a?.x) || !isNum(a?.y)) return { changes: [] };
    let z = doc.topZ;
    const ids = new Map<string, string>();
    const changes: Change[] = [];
    const vw = DEVICES[0].vw;
    const size = pageSize(vw, DEVICES[0].vh, SCALE);
    SEED_PAGES.forEach((p, i) => {
      const id = ctx.newId();
      ids.set(p.title, id);
      const x = a.x + i * (size.width + GAP_X);
      changes.push({ op: 'add', node: pageNode(id, x, a.y, ++z, { title: p.title, html: p.html, vw, ...(i === 0 ? { start: true as const } : {}) }) });
      if (p.note) changes.push({ op: 'add', node: noteNode(ctx.newId(), x + 16, a.y + size.height + 24, ++z, p.note, id) });
    });
    const links: [string, string, string][] = [
      ['Landing', 'Sign up', 'Get started'],
      ['Sign up', 'Plan', 'Continue'],
      ['Plan', 'Checkout', 'Choose plan'],
      ['Checkout', 'Welcome', 'Pay'],
      ['Checkout', 'Plan', 'Change plan'],
      ['Welcome', 'Landing', 'Back to start'],
    ];
    for (const [f, t, label] of links) changes.push({ op: 'edge', edge: edge(ctx.newId(), ids.get(f)!, ids.get(t)!, label) });
    return { changes, select: [...ids.values()], events: [{ type: 'page.seed', text: 'added the example signup flow' }] };
  },
};

/** Duplicate: a copied note loses its page (it lands beside it); a copied page is never the start. */
export function duplicateRule(node: CanvasNode): CanvasNode | undefined {
  const n: CanvasNode = node;
  if (isNote(node)) return { ...n, [FIELD]: { note: true } };
  if (isPage(n) && page(n).start) {
    const { start: _s, ...f } = page(n);
    return { ...n, [FIELD]: f } as CanvasNode;
  }
}
