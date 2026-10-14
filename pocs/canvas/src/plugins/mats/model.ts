import type { CanvasNode, CarrierOf } from '../../core';
import { CARD_H, CARD_W, FIELD as CARDS, type DeckField, type Layout } from '../cards/deck';
import { COLUMN_STEP, PAD } from '../cards/layout';

// Mats: a surface (like a chessboard) that carries what lies on it, with zones where cards go.
// A mat is a JSON Canvas `group` node with `x-mats: { kind: 'mat' }`. A zone is a cards container
// (a table spot with a fixed `area`, so the cards plugin lays it out, takes drops, keeps privacy)
// marked `x-mats: { zone: <mat id> }`; a free area (no container: a labelled spot such as a pot) is a
// `group` node with `x-mats: { zone, free: true }`. Zones ride their mat by id; anything else rides
// the topmost mat under its center (geometry, nothing stored), so moving the mat moves it all.

export const FIELD = 'x-mats';
/** Pack id of zone containers (no card carries it). */
export const MAT_PACK = 'mats';

export interface MatField {
  kind: 'mat';
  /** Mats are locked by default: dragging the surface box-selects; the tab moves the mat. */
  unlocked?: true;
  /** Which preset made it (e.g. "solitaire": preset actions like Deal Klondike). */
  preset?: string;
}
export interface ZoneField {
  /** The mat it belongs to. */
  zone: string;
  /** The zone's own name (a private zone shows its owner's hand label; this comes back when public). */
  name?: string;
  /** A free area: a labelled spot, not a container (cards dropped there just lie on the mat). */
  free?: true;
  /** A preset's role for it ("stock", "tableau"...). */
  role?: string;
}

const field = (n: CanvasNode | undefined) => n?.[FIELD] as Record<string, unknown> | undefined;
export const isMat = (n: CanvasNode | undefined): boolean => field(n)?.kind === 'mat';
export const isZone = (n: CanvasNode | undefined): boolean => typeof field(n)?.zone === 'string';
export const isFreeZone = (n: CanvasNode | undefined): boolean => isZone(n) && field(n)?.free === true;
export const mat = (n: CanvasNode) => n[FIELD] as MatField;
export const zone = (n: CanvasNode) => n[FIELD] as ZoneField;
export const zoneName = (n: CanvasNode) => zone(n).name ?? n.label ?? 'Zone';
export const deckField = (n: CanvasNode) => n[CARDS] as DeckField | undefined;

export const MAT_COLORS = [
  { name: 'Green felt', hex: '#2f6b45' },
  { name: 'Blue', hex: '#24506e' },
  { name: 'Red', hex: '#7a2f34' },
  { name: 'Wood', hex: '#6b4a2b' },
  { name: 'Purple', hex: '#4d3a6b' },
  { name: 'Slate', hex: '#3d434c' },
];
export const DEFAULT_MAT_COLOR = MAT_COLORS[0].hex;
export const MAT_MIN = { w: 240, h: 200 };
export const MAT_MAX = 6000;
export const ZONE_MIN = { w: 80, h: 80 };

/** What a new zone of each kind is (and its default size, a little roomier than the cards need). */
export type ZoneKind = Layout | 'free';
export const ZONE_KINDS: ZoneKind[] = ['stack', 'row', 'fan', 'grid', 'column', 'column-up', 'free'];
export const ZONE_KIND_NAMES: Record<ZoneKind, string> = {
  stack: 'Pile',
  row: 'Row',
  fan: 'Fan',
  grid: 'Grid',
  column: 'Column',
  'column-up': 'Column (upward)',
  free: 'Free area (no container)',
};
const spanW = (n: number) => 2 * PAD + n * CARD_W + (n - 1) * 10;
export const zoneSize = (k: ZoneKind): { w: number; h: number } =>
  k === 'stack'
    ? { w: CARD_W + 2 * PAD + 20, h: CARD_H + 2 * PAD + 20 }
    : k === 'row'
      ? { w: spanW(5), h: CARD_H + 2 * PAD }
      : k === 'fan'
        ? { w: spanW(3), h: CARD_H + 2 * PAD + 22 }
        : k === 'grid'
          ? { w: spanW(3), h: 2 * CARD_H + 2 * PAD + 10 }
          : k === 'column' || k === 'column-up'
            ? { w: CARD_W + 2 * PAD, h: CARD_H + 2 * PAD + 5 * COLUMN_STEP }
            : { w: 260, h: 180 };

/** Mats under a node list (cached per list: the rider rule runs for every node on every read). */
const matsCache = new WeakMap<readonly CanvasNode[], CanvasNode[]>();
function matsIn(all: readonly CanvasNode[]): CanvasNode[] {
  let m = matsCache.get(all);
  if (!m) matsCache.set(all, (m = all.filter(isMat)));
  return m;
}

/** Topmost mat lying under `n` (lower z) whose box holds its center. */
export function matUnder(n: CanvasNode, all: readonly CanvasNode[]): CanvasNode | undefined {
  const mats = matsIn(all);
  if (!mats.length) return;
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  const z = n.z ?? 0;
  for (let i = mats.length - 1; i >= 0; i--) {
    const m = mats[i];
    if (m.id !== n.id && (m.z ?? 0) < z && cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) return m;
  }
}

/** Rider rule: a zone rides its mat; a mat rides nothing; anything else the mat under its center. */
export const matCarrierOf: CarrierOf = (n, get, all) => {
  if (isMat(n)) return;
  if (isZone(n)) {
    const m = zone(n).zone;
    return isMat(get(m)) ? m : undefined;
  }
  return matUnder(n, all)?.id;
};

/** A mat node centered on nothing: top-left (x, y). */
export function matNode(id: string, x: number, y: number, w: number, h: number, z: number, o: { label?: string; color?: string; preset?: string } = {}): CanvasNode {
  const f: MatField = { kind: 'mat' };
  if (o.preset) f.preset = o.preset;
  return { id, type: 'group', x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h), z, label: o.label ?? 'Mat', color: o.color ?? DEFAULT_MAT_COLOR, [FIELD]: f };
}

/** A free area (a labelled spot that holds nothing itself). */
export function freeZoneNode(id: string, matId: string, x: number, y: number, w: number, h: number, z: number, name: string, role?: string): CanvasNode {
  const f: ZoneField = { zone: matId, name, free: true };
  if (role) f.role = role;
  return { id, type: 'group', x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h), z, label: name, [FIELD]: f };
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
