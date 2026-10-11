import { isNum, set, setMeta, type CanvasNode, type Change, type Command, type DocView } from '../../core';
import { CARD_W, NS, TYPE_KEY, cleanField, cleanType, coerce, data, heightOf, instancesOf, isInstance, library, typeId, typeOf, type ComponentType, type Values } from './model';
import { STARTER_SAMPLES, STARTER_TYPES } from './starter';

// Commands: plain data in, plain changes out (an agent drives the same API through dispatch).

const defineChange = (t: ComponentType) => setMeta(`${NS}.${t.id}`, t);

/** Add or replace a component type. A type without an id gets one from its name. */
const defineType: Command<{ def: unknown }> = (doc, a) => {
  const raw = a?.def as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return [];
  const id = typeof raw.id === 'string' && raw.id ? raw.id : typeId(String(raw.name ?? ''), Object.keys(library(doc)));
  const t = cleanType({ ...raw, id });
  if (!t) return [];
  const had = !!typeOf(doc, t.id);
  return { changes: [defineChange(t)], events: [{ type: 'components.define', text: `${had ? 'changed' : 'defined'} component type ${t.name}` }] };
};

/** Remove a type (only when it has no instances: never orphans data). */
const deleteType: Command<{ type: string }> = (doc, a) => {
  const t = typeOf(doc, a?.type);
  if (!t || instancesOf(doc, t.id).length) return [];
  return { changes: [setMeta(`${NS}.${t.id}`, undefined)], events: [{ type: 'components.undefine', text: `removed component type ${t.name}` }] };
};

/** Append a field to a type: every instance shows it at once (they read the type when drawn). */
const addField: Command<{ type: string; field: unknown }> = (doc, a) => {
  const t = typeOf(doc, a?.type);
  if (!t) return [];
  const f = cleanField(a.field, new Set(t.fields.map((x) => x.id)));
  if (!f) return [];
  return { changes: [defineChange({ ...t, fields: [...t.fields, f] })], select: undefined, events: [{ type: 'components.field', text: `added field ${f.label} to ${t.name}` }] };
};

/** Change one field definition (label, kind, options, card...). Values stay; ones the new kind can't hold show blank. */
const updateField: Command<{ type: string; field: string; patch: Record<string, unknown> }> = (doc, a) => {
  const t = typeOf(doc, a?.type);
  const i = t ? t.fields.findIndex((f) => f.id === a.field) : -1;
  if (!t || i < 0 || !a.patch || typeof a.patch !== 'object') return [];
  const others = new Set(t.fields.filter((_, j) => j !== i).map((f) => f.id));
  const f = cleanField({ ...t.fields[i], ...a.patch, id: t.fields[i].id }, others);
  if (!f) return [];
  const fields = t.fields.slice();
  fields[i] = f;
  return [defineChange({ ...t, fields })];
};

/** Remove a field from a type; instance values are cleared with it (one undo step brings both back). */
const removeField: Command<{ type: string; field: string }> = (doc, a) => {
  const t = typeOf(doc, a?.type);
  const f = t?.fields.find((x) => x.id === a.field);
  if (!t || !f) return [];
  const fields = t.fields.filter((x) => x !== f);
  const changes: Change[] = [defineChange({ ...t, fields, title: t.title === f.id ? undefined : t.title })];
  for (const n of instancesOf(doc, t.id)) if (data(n)[f.id] !== undefined) changes.push(set(n.id, `${NS}.${f.id}`, undefined));
  return { changes, events: [{ type: 'components.field', text: `removed field ${f.label} from ${t.name}` }] };
};

/** Move a field up or down. */
const moveField: Command<{ type: string; field: string; by: number }> = (doc, a) => {
  const t = typeOf(doc, a?.type);
  const i = t ? t.fields.findIndex((f) => f.id === a.field) : -1;
  const j = i + (a?.by === -1 ? -1 : 1);
  if (!t || i < 0 || j < 0 || j >= t.fields.length) return [];
  const fields = t.fields.slice();
  [fields[i], fields[j]] = [fields[j], fields[i]];
  return [defineChange({ ...t, fields })];
};

function instanceNode(doc: DocView, id: string, t: ComponentType, x: number, y: number, z: number, raw: Values = {}, refs?: (v: string) => string | undefined): CanvasNode {
  const values: Values = { [TYPE_KEY]: t.id };
  for (const f of t.fields) {
    let v = raw[f.id];
    if (f.kind === 'ref' && typeof v === 'string' && refs) v = refs(v) ?? v;
    const c = coerce(f, v, f.kind === 'ref' && refs ? undefined : doc);
    if (c !== undefined && c !== null) values[f.id] = c;
  }
  return { id, type: 'text', x: Math.round(x), y: Math.round(y), width: CARD_W, height: heightOf(t, values), z, [NS]: values };
}

/** New instance of a type at (x, y) (its top-left), optionally with values. Selects it. */
const create: Command<{ type: string; x: number; y: number; values?: Values }> = (doc, a, ctx) => {
  const t = typeOf(doc, a?.type);
  if (!t || !isNum(a.x) || !isNum(a.y)) return [];
  const id = ctx.newId();
  const node = instanceNode(doc, id, t, a.x, a.y, doc.topZ + 1, a.values && typeof a.values === 'object' ? a.values : {});
  return { changes: [{ op: 'add', node }], select: [id], events: [{ type: 'components.create', text: `added a ${t.name}`, targets: [id] }] };
};

/** Set one field of an instance (validated against its type; invalid = no-op). */
const setValue: Command<{ id: string; field: string; value: unknown }> = (doc, a) => {
  const n = doc.get(a?.id);
  if (!isInstance(n)) return [];
  const f = typeOf(doc, data(n)[TYPE_KEY] as string)?.fields.find((x) => x.id === a.field);
  if (!f) return [];
  const v = coerce(f, a.value, doc);
  if (v === null) return [];
  if (JSON.stringify(v) === JSON.stringify(data(n)[f.id])) return [];
  return [set(n.id, `${NS}.${f.id}`, v)];
};

/** Define the starter types that are missing, and lay out sample instances around (x, y) (the middle). */
const starter: Command<{ x: number; y: number }> = (doc, a, ctx) => {
  if (!isNum(a?.x) || !isNum(a?.y)) return [];
  const lib = library(doc);
  const changes: Change[] = STARTER_TYPES.filter((t) => !lib[t.id]).map(defineChange);
  const types = { ...Object.fromEntries(STARTER_TYPES.map((t) => [t.id, t])), ...lib };
  const ids = new Map(STARTER_SAMPLES.map(([, key]) => [key, ctx.newId()]));
  let z = doc.topZ;
  const ox = a.x - 530;
  const oy = a.y - 400;
  for (const [type, key, values, dx, dy] of STARTER_SAMPLES) {
    const t = types[type];
    if (!t) continue;
    changes.push({ op: 'add', node: instanceNode(doc, ids.get(key)!, t, ox + dx, oy + dy, ++z, values, (v) => ids.get(v)) });
  }
  return { changes, select: [...ids.values()], events: [{ type: 'components.starter', text: 'added the product discovery starter' }] };
};

export const commands: Record<string, Command> = {
  defineType,
  deleteType,
  addField,
  updateField,
  removeField,
  moveField,
  create,
  set: setValue,
  starter,
};

