import type { CanvasNode, DocView } from '../../core';

// Components: custom object types defined as DATA, no code. A type = a schema (fields) plus a small
// declarative look (icon, color, which field is the title, which fields show on the card at mid zoom).
// The library of types lives in the document itself (top-level `x-components` of the JSON Canvas
// file, the doc's meta map live), so it travels with the file, syncs to peers and is undoable.
// An instance is a standard node whose `x-components` holds `$type` plus one key per field value.

export const NS = 'x-components';
export const TYPE_KEY = '$type';

export const KINDS = ['text', 'longtext', 'enum', 'number', 'image', 'list', 'ref'] as const;
export type FieldKind = (typeof KINDS)[number];

export interface FieldDef {
  /** Stable key in instance data (never shown; renaming a field keeps it). */
  id: string;
  label: string;
  kind: FieldKind;
  /** enum: the allowed values. */
  options?: string[];
  /** ref: the component type id it points to (any instance when unset). */
  to?: string;
  /** Shown on the card at mid zoom (summary). Everything shows when zoomed in. */
  card?: boolean;
}

export interface ComponentType {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  /** Field id used as the card's title. Default: the first field. */
  title?: string;
  fields: FieldDef[];
}

export type Library = Record<string, ComponentType>;
export type Values = Record<string, unknown>;

export const CARD_W = 300;
const MAX_TEXT = 200;
const MAX_LONG = 4000;
const MAX_LIST = 50;
const MAX_FIELDS = 40;
const MAX_OPTIONS = 30;

export const library = (doc: DocView): Library => {
  const lib = doc.extra?.[NS];
  return lib && typeof lib === 'object' ? (lib as Library) : {};
};
export const typeOf = (doc: DocView, id: string | undefined): ComponentType | undefined => (id ? library(doc)[id] : undefined);

export const isInstance = (n: CanvasNode | undefined): n is CanvasNode & { [NS]: Values } => {
  const d = n?.[NS] as Values | undefined;
  return !!d && typeof d === 'object' && typeof d[TYPE_KEY] === 'string';
};
export const data = (n: CanvasNode): Values => (n[NS] as Values | undefined) ?? {};
export const ctypeOf = (n: CanvasNode): string | undefined => data(n)[TYPE_KEY] as string | undefined;
export const instancesOf = (doc: DocView, type: string) => doc.nodes.filter((n) => isInstance(n) && ctypeOf(n) === type);

export const titleField = (t: ComponentType): FieldDef | undefined => t.fields.find((f) => f.id === t.title) ?? t.fields[0];

/** The instance's display title (its title field, or the type name). */
export function titleOf(doc: DocView, n: CanvasNode): string {
  const t = typeOf(doc, ctypeOf(n));
  const f = t && titleField(t);
  const v = f ? display(doc, f, data(n)[f.id]) : '';
  return v || `Untitled ${t?.name ?? 'component'}`;
}

/** A value as one line of text (refs → the target's title). */
export function display(doc: DocView, f: FieldDef, v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (f.kind === 'list') return Array.isArray(v) ? v.join(', ') : '';
  if (f.kind === 'ref') {
    const target = doc.get(String(v));
    return target && isInstance(target) ? titleOf(doc, target) : '(missing)';
  }
  return String(v);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'field';

/** A field id from a label, unique among `taken`. */
export function fieldId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slug(label);
  let id = base === TYPE_KEY ? 'type' : base;
  for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
  return id;
}
export const typeId = fieldId;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const COLOR = /^#[0-9a-f]{3,8}$/i;
const SAFE_URL = /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|svg\+xml);)/i;

/** A clean field definition, or undefined if it isn't one. Unknown keys are dropped (data only). */
export function cleanField(raw: unknown, taken: Set<string> = new Set()): FieldDef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const label = str(r.label, 60)?.trim() || str(r.id, 60)?.trim();
  const kind = KINDS.includes(r.kind as FieldKind) ? (r.kind as FieldKind) : 'text';
  if (!label) return undefined;
  const wanted = str(r.id, 32);
  const id = wanted && /^[a-z0-9_]+$/i.test(wanted) && !taken.has(wanted) && wanted !== TYPE_KEY ? wanted : fieldId(label, taken);
  const f: FieldDef = { id, label, kind };
  if (kind === 'enum') {
    const opts = Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).map((o) => o.trim().slice(0, 40)) : [];
    f.options = [...new Set(opts)].slice(0, MAX_OPTIONS);
  }
  if (kind === 'ref' && typeof r.to === 'string' && r.to) f.to = r.to.slice(0, 32);
  if (r.card === true) f.card = true;
  return f;
}

/** A clean type definition (pure data, bounded), or undefined. */
export function cleanType(raw: unknown): ComponentType | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 40)?.trim();
  const id = str(r.id, 32);
  if (!name || !id || !/^[a-z0-9_-]+$/i.test(id)) return undefined;
  const taken = new Set<string>();
  const fields: FieldDef[] = [];
  for (const raw of Array.isArray(r.fields) ? r.fields.slice(0, MAX_FIELDS) : []) {
    const f = cleanField(raw, taken);
    if (!f) continue;
    taken.add(f.id);
    fields.push(f);
  }
  const t: ComponentType = { id, name, fields };
  const icon = str(r.icon, 4);
  if (icon) t.icon = icon;
  if (typeof r.color === 'string' && COLOR.test(r.color)) t.color = r.color;
  if (typeof r.title === 'string' && taken.has(r.title)) t.title = r.title;
  return t;
}

/**
 * A value as the field stores it: `undefined` = clear, `null` = not valid for this field (refuse).
 * `doc` lets refs check their target.
 */
export function coerce(f: FieldDef, v: unknown, doc?: DocView): unknown {
  if (v === undefined || v === null || v === '') return undefined;
  switch (f.kind) {
    case 'text':
      return typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s*\n\s*/g, ' ').slice(0, MAX_TEXT) : null;
    case 'longtext':
      return typeof v === 'string' ? v.slice(0, MAX_LONG) : null;
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[, _]/g, '')) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case 'enum':
      return typeof v === 'string' && f.options?.includes(v) ? v : null;
    case 'image':
      return typeof v === 'string' && SAFE_URL.test(v.trim()) ? v.trim().slice(0, 2000) : null;
    case 'list': {
      const items = typeof v === 'string' ? v.split('\n') : Array.isArray(v) ? v : null;
      if (!items) return null;
      const clean = items
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim().slice(0, MAX_TEXT))
        .filter(Boolean)
        .slice(0, MAX_LIST);
      return clean.length ? clean : undefined;
    }
    case 'ref': {
      if (typeof v !== 'string') return null;
      if (!doc) return v;
      const t = doc.get(v);
      return t && isInstance(t) && (!f.to || ctypeOf(t) === f.to) ? v : null;
    }
  }
}

/** Card height for an instance with every field shown (derived by a layout, never stored). */
export function heightOf(t: ComponentType | undefined, v: Values, width = CARD_W): number {
  if (!t) return 80;
  const chars = Math.max(10, Math.floor((width - 28) / 7.4));
  const lines = (s: string) => s.split('\n').reduce((a, l) => a + Math.max(1, Math.ceil(l.length / chars)), 0);
  let h = 52; // header
  const title = titleField(t);
  for (const f of t.fields) {
    if (f === title) continue;
    const x = v[f.id];
    h += 16; // label
    if (f.kind === 'image') h += x ? 72 : 20;
    else if (f.kind === 'list') h += Math.max(1, Array.isArray(x) ? x.reduce((a: number, s) => a + lines(String(s)), 0) : 1) * 19;
    else if (f.kind === 'longtext') h += Math.min(6, lines(typeof x === 'string' && x ? x : ' ')) * 19;
    else h += 20;
    h += 6;
  }
  return Math.round(h + 10);
}
