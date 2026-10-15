import { isIds, isNum, pick } from '../../core/commands';
import { set } from '../../core/doc';
import type { CanvasNode, Change, Command, DocView } from '../../core';
import { own } from '../cards/commands';
import { FIELD as CARDS, LAYOUTS, card, cardsIn, groupNode, isDeck, isHand, isHomeDeck, isStacked, pileAt, type Facing, type Layout } from '../cards/deck';
import {
  DEFAULT_MAT_COLOR,
  FIELD,
  MAT_COLORS,
  MAT_MAX,
  MAT_MIN,
  MAT_PACK,
  ZONE_KINDS,
  ZONE_KIND_NAMES,
  ZONE_MIN,
  clamp,
  deckField,
  freeZoneNode,
  isFreeZone,
  isMat,
  isZone,
  matNode,
  zone,
  zoneName,
  zoneSize,
  type ZoneField,
  type ZoneKind,
} from './model';

// Pure commands (doc, args, ctx) -> changes. A zone's cards are the cards plugin's business; these
// only make, configure, move and remove mats and zones.

const C = (k: string) => `${CARDS}.${k}`;
const M = (k: string) => `${FIELD}.${k}`;
const get = (doc: DocView, id: unknown) => (typeof id === 'string' ? doc.get(id) : undefined);
const okColor = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined);
const okName = (s: unknown) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, 40) : undefined);
const isLayout = (v: unknown): v is Layout => typeof v === 'string' && (LAYOUTS as string[]).includes(v);

export interface ZoneSpec {
  kind: Layout;
  /** Top-left and size. */
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  max?: number;
  enter?: Facing;
  /** Private to this player (a seat): owner, hand label, color. */
  owner?: { id: string; label: string; color?: string };
  role?: string;
  /** A pack's home deck (`pack`): Gather all / Reset bring its cards back here. */
  home?: boolean;
  pack?: string;
  cols?: number;
}

/** Outlined slots: a row or column with a max shows them (a pile, fan or grid doesn't). */
const slotsFor = (kind: Layout, max: number | undefined) => (max && max <= 13 && (kind === 'row' || kind === 'column' || kind === 'column-up') ? max : undefined);

/** A zone container node on mat `matId`. */
export function zoneNode(id: string, matId: string, z: number, s: ZoneSpec): CanvasNode {
  const n = groupNode(id, Math.round(s.x), Math.round(s.y), z, {
    layout: s.kind,
    pack: s.pack ?? MAT_PACK,
    spot: true,
    max: s.max,
    slots: slotsFor(s.kind, s.max),
    area: { w: s.w, h: s.h },
    enter: s.enter,
    home: s.home,
    owner: s.owner?.id,
    label: s.owner?.label ?? s.name,
    color: s.owner?.color,
  });
  const f: ZoneField = { zone: matId, name: s.name };
  if (s.role) f.role = s.role;
  n[FIELD] = f;
  if (s.cols) (n[CARDS] as { cols?: number }).cols = s.cols;
  if (s.owner) Object.assign(n[CARDS] as object, { fixed: true, width: Math.round(s.w) });
  if (s.home) n.text = 'Deck';
  return n;
}

/** A new empty mat centered on (x, y). */
export const create: Command<{ x?: number; y?: number; w?: number; h?: number; label?: string; color?: string }> = (doc, a, ctx) => {
  const w = clamp(isNum(a?.w) ? a.w : 1000, MAT_MIN.w, MAT_MAX);
  const h = clamp(isNum(a?.h) ? a.h : 640, MAT_MIN.h, MAT_MAX);
  const x = (isNum(a?.x) ? a.x : 0) - w / 2;
  const y = (isNum(a?.y) ? a.y : 0) - h / 2;
  const node = matNode(ctx.newId(), x, y, w, h, Math.floor(doc.topZ) + 1, { label: okName(a?.label) ?? 'Mat', color: okColor(a?.color) ?? DEFAULT_MAT_COLOR });
  return { changes: [{ op: 'add', node }], select: [node.id] };
};

/** Lock (default) or unlock a mat: unlocked, dragging its surface moves it. */
export const lock: Command<{ id: string; locked: boolean }> = (doc, a) => {
  const m = get(doc, a?.id);
  if (!m || !isMat(m) || typeof a.locked !== 'boolean') return [];
  return [set(m.id, M('unlocked'), a.locked ? undefined : true)];
};

/** Rename and/or recolor a mat. */
export const setMat: Command<{ id: string; label?: string; color?: string }> = (doc, a) => {
  const m = get(doc, a?.id);
  if (!m || !isMat(m)) return [];
  const out: Change[] = [];
  const label = okName(a.label);
  if (label && label !== m.label) out.push(set(m.id, 'label', label));
  const color = okColor(a.color);
  if (color && color !== m.color) out.push(set(m.id, 'color', color));
  return out;
};

/** Keep a zone's box inside its mat (a zone wider than the mat sticks to its left / top edge). */
function inside(m: CanvasNode, x: number, y: number, w: number, h: number) {
  return { x: Math.round(clamp(x, m.x, Math.max(m.x, m.x + m.width - w))), y: Math.round(clamp(y, m.y, Math.max(m.y, m.y + m.height - h))) };
}

/** Add a zone of `kind` to a mat, centered on (x, y) (default: the mat's middle), kept inside the mat. Selects it. */
export const addZone: Command<{ mat: string; kind: ZoneKind; x?: number; y?: number; name?: string }> = (doc, a, ctx) => {
  const m = get(doc, a?.mat);
  if (!m || !isMat(m) || !ZONE_KINDS.includes(a.kind)) return [];
  const s = zoneSize(a.kind);
  const p = inside(m, (isNum(a.x) ? a.x : m.x + m.width / 2) - s.w / 2, (isNum(a.y) ? a.y : m.y + m.height / 2) - s.h / 2, s.w, s.h);
  const name = okName(a.name) ?? ZONE_KIND_NAMES[a.kind].replace(/ \(.*\)$/, '');
  const z = Math.floor(doc.topZ) + 1;
  const node = a.kind === 'free' ? freeZoneNode(ctx.newId(), m.id, p.x, p.y, s.w, s.h, z, name) : zoneNode(ctx.newId(), m.id, z, { kind: a.kind, ...p, ...s, name });
  return { changes: [{ op: 'add', node }], select: [node.id] };
};

/**
 * Configure a zone: layout, most cards (`max: null` = no limit), facing on entry (`keep` = cards
 * keep theirs), name. A private zone (a seat) can't be a pile (its top card would show). A free
 * area only has a name.
 */
export const configZone: Command<{ id: string; layout?: Layout; max?: number | null; enter?: Facing | 'keep'; name?: string }> = (doc, a) => {
  const n = get(doc, a?.id);
  if (!n || !isZone(n)) return [];
  const out: Change[] = [];
  const name = a.name === undefined ? undefined : okName(a.name);
  if (name && name !== zoneName(n)) {
    out.push(set(n.id, M('name'), name));
    if (!n.owner) out.push(set(n.id, 'label', name), ...(isFreeZone(n) ? [] : [set(n.id, 'text', name)]));
  }
  if (isFreeZone(n)) return out;
  const f = deckField(n)!;
  let layout = (f.layout ?? 'stack') as Layout;
  if (a.layout !== undefined) {
    if (!isLayout(a.layout) || (a.layout === 'stack' && isHand(n))) return [];
    if (a.layout !== layout) out.push(set(n.id, C('layout'), a.layout === 'stack' ? undefined : a.layout));
    layout = a.layout;
  }
  let max = f.max;
  if (a.max !== undefined) {
    if (a.max !== null && !(isNum(a.max) && a.max >= 1 && a.max <= 60)) return [];
    max = a.max === null ? undefined : Math.floor(a.max);
    if (max !== f.max) out.push(set(n.id, C('max'), max));
  }
  const slots = slotsFor(layout, max);
  if (slots !== f.slots) out.push(set(n.id, C('slots'), slots));
  if (a.enter !== undefined) {
    if (a.enter !== 'up' && a.enter !== 'down' && a.enter !== 'keep') return [];
    const e = a.enter === 'keep' ? undefined : a.enter;
    if (e !== f.enter) out.push(set(n.id, C('enter'), e));
  }
  return out;
};

/**
 * A zone's visibility: private to player `owner` (a seat: it becomes their hand, so others see its
 * cards face down, with every hand option) or public (`owner: null`: its name comes back). Who may
 * do it is the UI's call (as for Give to ▸).
 */
export const visibility: Command<{ id: string; owner: string | null; label?: string; color?: string }> = (doc, a, ctx) => {
  const n = get(doc, a?.id);
  if (!n || !isZone(n) || isFreeZone(n)) return [];
  if (a.owner === null) {
    if (!n.owner) return [];
    const r = own(doc, { id: n.id, owner: null }, ctx);
    return [...(Array.isArray(r) ? r : r.changes), set(n.id, 'label', zoneName(n)), set(n.id, 'text', zoneName(n))];
  }
  if (typeof a.owner !== 'string' || !a.owner || a.owner === n.owner) return [];
  const r = own(doc, { id: n.id, owner: a.owner, label: a.label, color: a.color }, ctx);
  return [...(Array.isArray(r) ? r : r.changes), set(n.id, C('fixed'), true), set(n.id, C('width'), Math.round(deckField(n)!.area?.w ?? n.width))];
};

/** Resize a mat or a zone (its area; a seat's frame too). */
export const resize: Command<{ id: string; w: number; h: number }> = (doc, a) => {
  const n = get(doc, a?.id);
  if (!n || !isNum(a.w) || !isNum(a.h)) return [];
  if (isMat(n)) {
    const w = Math.round(clamp(a.w, MAT_MIN.w, MAT_MAX));
    const h = Math.round(clamp(a.h, MAT_MIN.h, MAT_MAX));
    return [...(w !== n.width ? [set(n.id, 'width', w)] : []), ...(h !== n.height ? [set(n.id, 'height', h)] : [])];
  }
  if (!isZone(n)) return [];
  const w = Math.round(clamp(a.w, ZONE_MIN.w, MAT_MAX));
  const h = Math.round(clamp(a.h, ZONE_MIN.h, MAT_MAX));
  if (isFreeZone(n)) return [set(n.id, 'width', w), set(n.id, 'height', h)];
  const out = [set(n.id, C('area'), { w, h })];
  if (isHand(n)) out.push(set(n.id, C('width'), w));
  return out;
};

/** After zones were dragged (edit mode): each back inside its mat. */
export const placeZones: Command<{ ids: string[] }> = (doc, a) => {
  if (!isIds(a?.ids)) return [];
  return pick(doc, a.ids)
    .filter(isZone)
    .flatMap((n) => {
      const m = doc.get(zone(n).zone);
      if (!m || !isMat(m)) return [];
      const p = inside(m, n.x, n.y, n.width, n.height);
      return [...(p.x !== n.x ? [set(n.id, 'x', p.x)] : []), ...(p.y !== n.y ? [set(n.id, 'y', p.y)] : [])];
    });
};

/** Changes that make zone `n` a plain container (its cards stay: a pile, group or hand), or remove it if empty. */
function unzone(doc: DocView, n: CanvasNode): Change[] {
  if (isFreeZone(n) || !isDeck(n)) return [{ op: 'del', id: n.id }];
  if (!cardsIn(doc, n.id).length && !isHomeDeck(n)) return [{ op: 'del', id: n.id }];
  const f = deckField(n)!;
  const out: Change[] = [set(n.id, FIELD, undefined)];
  for (const k of ['spot', 'area', 'enter', 'max', 'slots'] as const) if (f[k] !== undefined) out.push(set(n.id, C(k), undefined));
  if (isStacked(n)) {
    const p = pileAt(n);
    out.push(set(n.id, 'x', p.x), set(n.id, 'y', p.y));
  }
  return out;
}

/** Delete zones: their cards stay where they are (as a plain pile, group or hand); empty ones just go. */
export const deleteZone: Command<{ ids: string[] }> = (doc, a) => pick(doc, a?.ids).filter(isZone).flatMap((n) => unzone(doc, n));

/** Remove a mat but keep everything on it (zones become plain piles / groups). */
export const removeMat: Command<{ id: string }> = (doc, a) => {
  const m = get(doc, a?.id);
  if (!m || !isMat(m)) return [];
  return [...doc.riders(m.id).filter(isZone).flatMap((n) => unzone(doc, n)), { op: 'del', id: m.id }];
};

/** Zones of a mat (optionally with a preset role), left to right. */
export const zonesOf = (doc: DocView, matId: string, role?: string) =>
  doc
    .riders(matId)
    .filter((n) => isZone(n) && (role === undefined || zone(n).role === role))
    .sort((p, q) => p.x - q.x || p.y - q.y);

/**
 * Klondike deal on a solitaire mat: from the stock, column k gets k cards, only the top one face up
 * (dealt in rows, like at a table). Needs an empty tableau and 28 cards in the stock.
 */
export const dealKlondike: Command<{ id: string }> = (doc, a) => {
  const m = get(doc, a?.id);
  if (!m || !isMat(m)) return [];
  const stock = zonesOf(doc, m.id, 'stock')[0];
  const cols = zonesOf(doc, m.id, 'tableau');
  if (!stock || cols.length !== 7 || cols.some((c) => cardsIn(doc, c.id).length)) return [];
  const pile = cardsIn(doc, stock.id).slice();
  if (pile.length < 28) return [];
  const out: Change[] = [];
  for (let r = 0; r < 7; r++)
    for (let k = r; k < 7; k++) {
      const c = pile.pop()!;
      const up = r === k;
      out.push(set(c.id, C('stack'), cols[k].id), set(c.id, C('order'), r + 1), set(c.id, 'x', cols[k].x), set(c.id, 'y', cols[k].y));
      if (card(c).faceUp !== up) out.push(set(c.id, C('faceUp'), up));
    }
  return { changes: out, select: [], events: [{ type: 'mats.deal', text: 'dealt Klondike', targets: [stock.id, ...cols.map((c) => c.id)], cue: 'deal' }] };
};

export { MAT_COLORS };
