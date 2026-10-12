import type { CanvasEdge, CanvasNode, Change, Command, CommandResult, DocView, EventSpec, Store } from '../../core';

// Board: plain JSON Canvas work objects (notes, columns, links, edges) and the commands agents and
// tools use to edit them. No DOM: the browser plugin (index.ts) and the Node bridge (bridge/) both
// register this, so an agent's "add a note" is the same command a person's Add menu runs, logged the
// same way (the actor is whoever dispatched it).
//
// Columns are `group` nodes. A note rides on the column its center sits in (moves with it).
// `board.sync` mirrors an outside list (Backlog.md tasks, GitHub issues) into columns: items keep
// stable ids (`<source>:<key>`), human placement survives a re-sync unless the item changed column.

export const NOTE_W = 260;
export const NOTE_H = 90;
export const COL_W = 300;
export const GAP = 16;
export const LINK_GAP = 70;
const COL_HEAD = 44;

/** Plain JSON Canvas: no other plugin's `x-` fields (a card or a mat is not a note or a column). */
export const isPlain = (n: CanvasNode) => Object.keys(n).every((k) => !k.startsWith('x-') || k === 'x-sync');
export const isNote = (n: CanvasNode) => (n.type === 'text' || n.type === 'link' || n.type === 'file') && isPlain(n);
export const isColumn = (n: CanvasNode) => n.type === 'group' && isPlain(n);

/** Where an outside item came from (`x-sync` on notes and columns made by `board.sync`). */
export interface SyncInfo {
  source: string;
  key: string;
  column?: string;
  hash?: string;
}
export const syncOf = (n: CanvasNode | undefined) => n?.['x-sync'] as SyncInfo | undefined;

const SAFE_ID = /[^A-Za-z0-9_.:-]+/g;
export const syncId = (source: string, key: string) => `${source}:${key}`.replace(SAFE_ID, '-');
const colId = (source: string, key: string) => syncId(source, `col:${key}`);

/** Short name for log lines: first line of the text, or the label. */
export function nameOf(n: CanvasNode | undefined): string {
  if (!n) return 'something';
  const s = (n.label ?? n.text ?? n.url ?? n.file ?? n.type).split('\n')[0].replace(/^#+\s*/, '').trim();
  return `“${s.length > 40 ? s.slice(0, 39) + '…' : s}”`;
}

const ev = (type: string, text: string, targets: string[], cue = 'pulse'): EventSpec => ({ type: `board.${type}`, text, targets, cue });

/** Rider rule: a note rides on the topmost column that holds its center. */
export function columnOf(node: CanvasNode, _get: (id: string) => CanvasNode | undefined, all: readonly CanvasNode[]): string | undefined {
  if (!isNote(node)) return undefined;
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  for (let i = all.length - 1; i >= 0; i--) {
    const g = all[i];
    if (isColumn(g) && g.id !== node.id && cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height) return g.id;
  }
  return undefined;
}

/** A free spot: right of everything on the board, top-aligned (or below `near`, if given). */
export function freeSpot(doc: DocView, w: number, h: number, near?: string): { x: number; y: number } {
  const n = near ? doc.get(near) : undefined;
  if (n) {
    // below `near`, then further down until nothing overlaps
    // room for an arrow and its label between them
    let y = n.y + n.height + LINK_GAP;
    const hit = () => doc.visible.some((o) => o.x < n.x + w && o.x + o.width > n.x && o.y < y + h && o.y + o.height > y && !isColumn(o));
    while (hit()) y += GAP + 10;
    return { x: n.x, y };
  }
  if (!doc.visible.length) return { x: 0, y: 0 };
  const right = Math.max(...doc.visible.map((o) => o.x + o.width));
  const top = Math.min(...doc.visible.map((o) => o.y));
  return { x: Math.round(right + GAP * 3), y: Math.round(top) };
}

/** Next free slot at the bottom of a column. */
export function columnSlot(doc: DocView, col: CanvasNode, skip: ReadonlySet<string> = new Set()): { x: number; y: number } {
  const inside = doc.nodes.filter((n) => !skip.has(n.id) && !isColumn(n) && columnOf(n, doc.get, doc.nodes) === col.id);
  const bottom = inside.length ? Math.max(...inside.map((n) => n.y + n.height)) : col.y + COL_HEAD - GAP;
  return { x: col.x + (col.width - NOTE_W) / 2, y: bottom + GAP };
}

export interface AddArgs {
  id?: string;
  type?: 'text' | 'group' | 'link';
  text?: string;
  label?: string;
  url?: string;
  color?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Put it below this node. */
  near?: string;
  /** Put it at the bottom of this column (group id). */
  column?: string;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const add: Command<AddArgs> = (doc, a, ctx) => {
  const type = a.type ?? (a.url ? 'link' : 'text');
  if (!['text', 'group', 'link'].includes(type)) return [];
  const id = a.id ?? ctx.newId();
  if (doc.get(id)) return [];
  const width = num(a.width) ? a.width : type === 'group' ? COL_W : NOTE_W;
  const height = num(a.height) ? a.height : type === 'group' ? 400 : NOTE_H;
  const col = a.column ? doc.get(a.column) : undefined;
  const spot = num(a.x) && num(a.y) ? { x: a.x, y: a.y } : col && isColumn(col) ? columnSlot(doc, col) : freeSpot(doc, width, height, a.near);
  const node: CanvasNode = { id, type, x: Math.round(spot.x), y: Math.round(spot.y), width, height };
  if (type === 'text') node.text = a.text ?? '';
  if (type === 'link') node.url = a.url ?? '';
  if (type === 'group') node.label = a.label ?? a.text ?? 'Column';
  if (a.color) node.color = a.color;
  // columns go under everything (notes ride on them), the rest on top
  const z = type === 'group' ? Math.min(0, ...doc.nodes.map((n) => n.z ?? 0)) - 1 : doc.topZ + 1;
  node.z = z;
  const changes: Change[] = [{ op: 'add', node }];
  if (col && isColumn(col)) changes.push(...growColumn(col, spot.y + height));
  return { changes, select: [id], events: [ev('add', `added ${type === 'group' ? 'column' : 'note'} ${nameOf(node)}`, [id])] };
};

function growColumn(col: CanvasNode, bottom: number): Change[] {
  const need = Math.ceil(bottom + GAP - col.y);
  return need > col.height ? [{ op: 'set', id: col.id, key: 'height', value: need }] : [];
}

export interface UpdateArgs {
  id: string;
  text?: string;
  label?: string;
  url?: string;
  color?: string | null;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  width?: number;
  height?: number;
  /** Move to the bottom of this column. */
  column?: string;
}

const update: Command<UpdateArgs> = (doc, a) => {
  const n = doc.get(a?.id);
  if (!n) return [];
  const changes: Change[] = [];
  const put = (key: string, v: unknown) => {
    if (v !== undefined && n[key as keyof CanvasNode] !== v) changes.push({ op: 'set', id: n.id, key, value: v });
  };
  put('text', a.text);
  put('label', a.label);
  put('url', a.url);
  if (a.color === null) {
    if (n.color !== undefined) changes.push({ op: 'set', id: n.id, key: 'color', value: undefined });
  } else put('color', a.color);
  let x = num(a.x) ? a.x : num(a.dx) ? n.x + a.dx : undefined;
  let y = num(a.y) ? a.y : num(a.dy) ? n.y + a.dy : undefined;
  const col = a.column ? doc.get(a.column) : undefined;
  if (col && isColumn(col) && columnOf(n, doc.get, doc.nodes) !== col.id) {
    const s = columnSlot(doc, col, new Set([n.id]));
    x = s.x;
    y = s.y;
    changes.push(...growColumn(col, s.y + n.height));
  }
  let moved = false;
  // a column moves its riders along
  const dx = x !== undefined ? Math.round(x) - n.x : 0;
  const dy = y !== undefined ? Math.round(y) - n.y : 0;
  if (dx || dy) {
    moved = true;
    for (const m of [n, ...doc.riders(n.id)]) {
      if (dx) changes.push({ op: 'set', id: m.id, key: 'x', value: m.x + dx });
      if (dy) changes.push({ op: 'set', id: m.id, key: 'y', value: m.y + dy });
    }
  }
  put('width', num(a.width) ? Math.round(a.width) : undefined);
  put('height', num(a.height) ? Math.round(a.height) : undefined);
  if (!changes.length) return [];
  const edited = changes.some((c) => c.op === 'set' && !['x', 'y'].includes(c.key));
  const what = col ? `moved ${nameOf(n)} to ${nameOf(col)}` : edited ? `edited ${nameOf(n)}` : moved ? `moved ${nameOf(n)}` : `changed ${nameOf(n)}`;
  return { changes, events: [ev(moved && !edited ? 'move' : 'edit', what, [n.id])] };
};

const remove: Command<{ ids: string[] }> = (doc, a) => {
  const ns = (a?.ids ?? []).map((id) => doc.get(id)).filter((n): n is CanvasNode => !!n);
  if (!ns.length) return [];
  return {
    changes: ns.map((n) => ({ op: 'del', id: n.id })),
    events: [ev('remove', ns.length === 1 ? `removed ${nameOf(ns[0])}` : `removed ${ns.length} objects`, [], 'pulse')],
  };
};

export interface ConnectArgs {
  from: string;
  to: string;
  label?: string;
  color?: string;
  id?: string;
}

const connect: Command<ConnectArgs> = (doc, a, ctx) => {
  const f = doc.get(a?.from);
  const t = doc.get(a?.to);
  if (!f || !t || f.id === t.id) return [];
  const old = doc.edges.find((e) => e.fromNode === f.id && e.toNode === t.id);
  const edge: CanvasEdge = { id: a.id ?? old?.id ?? ctx.newId(), fromNode: f.id, toNode: t.id };
  if (a.label) edge.label = a.label;
  if (a.color) edge.color = a.color;
  if (old && JSON.stringify(old) === JSON.stringify(edge)) return [];
  return { changes: [{ op: 'edge', edge }], events: [ev('connect', `linked ${nameOf(f)} → ${nameOf(t)}${a.label ? ` (${a.label})` : ''}`, [f.id, t.id])] };
};

const disconnect: Command<{ id?: string; from?: string; to?: string }> = (doc, a) => {
  const es = doc.edges.filter((e) => (a?.id ? e.id === a.id : e.fromNode === a?.from && e.toNode === a?.to));
  if (!es.length) return [];
  const e = es[0];
  return { changes: es.map((x) => ({ op: 'unedge' as const, id: x.id })), events: [ev('disconnect', `unlinked ${nameOf(doc.get(e.fromNode))} → ${nameOf(doc.get(e.toNode))}`, [e.fromNode, e.toNode])] };
};

export interface SyncItem {
  key: string;
  column: string;
  text: string;
  color?: string;
  /** Extra plain fields kept under x-sync (labels, priority…). */
  data?: Record<string, unknown>;
}
export interface SyncArgs {
  source: string;
  /** Column keys and labels, left to right. */
  columns: { key: string; label: string }[];
  items: SyncItem[];
  /** Top-left of the first column when the board has none yet. */
  at?: { x: number; y: number };
}

const hashOf = (i: SyncItem) => JSON.stringify([i.text, i.color ?? null, i.data ?? null]);

/**
 * Mirror an outside list into columns: new items go to the bottom of their column, changed items
 * get their text, items that changed column move, items gone from the source are removed. Items a
 * person moved around inside their column stay put. Idempotent: same input, no changes.
 */
export const sync: Command<SyncArgs> = (doc, a) => {
  if (!a?.source || !Array.isArray(a.columns) || !Array.isArray(a.items)) return [];
  const src = a.source;
  const changes: Change[] = [];
  // a working view of node positions as we go (to stack new notes under each other)
  const cols = new Map<string, CanvasNode>();
  const existingCols = doc.nodes.filter((n) => isColumn(n) && syncOf(n)?.source === src);
  let next = existingCols.length
    ? { x: Math.max(...existingCols.map((c) => c.x + c.width)) + GAP * 2, y: Math.min(...existingCols.map((c) => c.y)) }
    : (a.at ?? freeSpot(doc, COL_W, 400));
  let z = Math.min(0, ...doc.nodes.map((n) => n.z ?? 0));
  for (const c of a.columns) {
    const id = colId(src, c.key);
    const have = doc.get(id);
    if (have) {
      cols.set(c.key, { ...have });
      if (have.label !== c.label) changes.push({ op: 'set', id, key: 'label', value: c.label });
      continue;
    }
    const node: CanvasNode = { id, type: 'group', label: c.label, x: Math.round(next.x), y: Math.round(next.y), width: COL_W, height: COL_HEAD + GAP, z: --z, 'x-sync': { source: src, key: `col:${c.key}` } };
    changes.push({ op: 'add', node });
    cols.set(c.key, { ...node });
    next = { x: next.x + COL_W + GAP * 2, y: next.y };
  }
  // bottom of each column so far (existing notes in it)
  const bottom = new Map<string, number>();
  for (const [key, col] of cols) {
    const inside = doc.nodes.filter((n) => !isColumn(n) && columnOf(n, doc.get, doc.nodes) === col.id);
    bottom.set(key, inside.length ? Math.max(...inside.map((n) => n.y + n.height)) : col.y + COL_HEAD - GAP);
  }
  const place = (key: string) => {
    const col = cols.get(key)!;
    const y = bottom.get(key)! + GAP;
    bottom.set(key, y + NOTE_H);
    return { x: col.x + (col.width - NOTE_W) / 2, y };
  };
  let added = 0;
  let moved = 0;
  let edited = 0;
  let removed = 0;
  let top = doc.topZ;
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const it of a.items) {
    if (!cols.has(it.column)) continue;
    const id = syncId(src, it.key);
    seen.add(id);
    const info: SyncInfo = { source: src, key: it.key, column: it.column, hash: hashOf(it), ...(it.data ?? {}) };
    const have = doc.get(id);
    if (!have) {
      const p = place(it.column);
      const node: CanvasNode = { id, type: 'text', text: it.text, x: Math.round(p.x), y: Math.round(p.y), width: NOTE_W, height: NOTE_H, z: ++top, 'x-sync': info };
      if (it.color) node.color = it.color;
      changes.push({ op: 'add', node });
      added++;
      targets.push(id);
      continue;
    }
    const old = syncOf(have);
    if (old?.hash !== info.hash) {
      if (have.text !== it.text) changes.push({ op: 'set', id, key: 'text', value: it.text });
      if ((have.color ?? undefined) !== it.color) changes.push({ op: 'set', id, key: 'color', value: it.color });
      for (const [k, v] of Object.entries(info)) if (JSON.stringify(old?.[k as keyof SyncInfo]) !== JSON.stringify(v)) changes.push({ op: 'set', id, key: `x-sync.${k}`, value: v });
      edited++;
      targets.push(id);
    }
    // moved column at the source, or not in its column on the board: put it at the bottom of its column
    const col = cols.get(it.column)!;
    if (old?.column !== it.column || columnOf(have, doc.get, doc.nodes) !== col.id) {
      const p = place(it.column);
      changes.push({ op: 'set', id, key: 'x', value: Math.round(p.x) }, { op: 'set', id, key: 'y', value: Math.round(p.y) });
      if (old?.column !== it.column) changes.push({ op: 'set', id, key: 'x-sync.column', value: it.column });
      moved++;
      targets.push(id);
    }
  }
  for (const n of doc.nodes) {
    const s = syncOf(n);
    if (s?.source === src && !isColumn(n) && !seen.has(n.id)) {
      changes.push({ op: 'del', id: n.id });
      removed++;
    }
  }
  // columns grow to fit
  for (const [key, col] of cols) changes.push(...growColumn(col, bottom.get(key)!));
  if (!changes.length) return [];
  const parts = [added && `${added} added`, edited && `${edited} updated`, moved && `${moved} moved`, removed && `${removed} removed`].filter(Boolean);
  const res: CommandResult = { changes, events: [ev('sync', `synced ${src}: ${parts.join(', ') || 'columns'}`, targets.slice(0, 20))] };
  return res;
};

export const commands = { add, update, remove, connect, disconnect, sync };

/** The data side of the plugin. No DOM: used by the app, the bridge and tests. */
export function registerBoardLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`board.${name}`, cmd as Command);
  store.addRiderRule(columnOf);
}
