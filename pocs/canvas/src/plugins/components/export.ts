import { makeView, type CanvasDoc, type CanvasEdge, type DocView } from '../../core';
import { NS, ctypeOf, data, display, instancesOf, isInstance, library, titleField, titleOf, typeOf, type ComponentType } from './model';

// Instances out as plain data for agents (JSON / Markdown), and the JSON Canvas file shape:
// each instance also gets a Markdown `text` (so Obsidian & co show something) and each reference
// becomes a real JSON Canvas edge. Both are regenerated on export and dropped on import.

export interface RefEdge {
  from: string;
  to: string;
  field: string;
  label: string;
}

/** References between instances (only to instances that exist). */
export function refEdges(doc: DocView): RefEdge[] {
  const out: RefEdge[] = [];
  for (const n of doc.nodes) {
    if (!isInstance(n)) continue;
    const t = typeOf(doc, ctypeOf(n));
    for (const f of t?.fields ?? []) {
      const v = data(n)[f.id];
      if (f.kind === 'ref' && typeof v === 'string' && isInstance(doc.get(v))) out.push({ from: n.id, to: v, field: f.id, label: f.label });
    }
  }
  return out;
}

/** One instance as plain JSON: field values keyed by label-free field id; refs as {id, title}. */
function instanceJson(doc: DocView, t: ComponentType, id: string) {
  const n = doc.get(id)!;
  const out: Record<string, unknown> = { id, title: titleOf(doc, n) };
  for (const f of t.fields) {
    const v = data(n)[f.id];
    if (v === undefined) continue;
    out[f.id] = f.kind === 'ref' ? { id: v, title: display(doc, f, v) } : v;
  }
  return out;
}

/** Library + instances, grouped by type. `only` = one type. */
export function exportJson(doc: DocView, only?: string) {
  const lib = library(doc);
  const types = Object.values(lib).filter((t) => !only || t.id === only);
  return {
    types,
    instances: Object.fromEntries(types.map((t) => [t.id, instancesOf(doc, t.id).map((n) => instanceJson(doc, t, n.id))])),
  };
}

/** One instance as Markdown lines (no heading). */
function fieldLines(doc: DocView, t: ComponentType, values: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const title = titleField(t);
  for (const f of t.fields) {
    if (f === title) continue;
    const v = values[f.id];
    if (v === undefined || v === '') continue;
    if (f.kind === 'list' && Array.isArray(v)) lines.push(`**${f.label}:**`, ...v.map((x) => `- ${x}`));
    else if (f.kind === 'longtext') lines.push(`**${f.label}:** ${String(v).replace(/\n/g, '\n  ')}`);
    else if (f.kind === 'image') lines.push(`**${f.label}:** ![](${v})`);
    else lines.push(`**${f.label}:** ${display(doc, f, v)}`);
  }
  return lines;
}

export function exportMarkdown(doc: DocView, only?: string): string {
  const out: string[] = [];
  for (const t of Object.values(library(doc))) {
    if (only && t.id !== only) continue;
    const list = instancesOf(doc, t.id);
    out.push(`# ${t.icon ? t.icon + ' ' : ''}${t.name} (${list.length})`, '');
    for (const n of list) out.push(`## ${titleOf(doc, n)}`, `<!-- id: ${n.id} -->`, ...fieldLines(doc, t, data(n)), '');
  }
  return out.join('\n').trimEnd() + '\n';
}

/** Export filter: Markdown text on each instance, references as JSON Canvas edges. */
export function shapeExport(doc: CanvasDoc): CanvasDoc {
  const view = makeView(doc);
  const edges: CanvasEdge[] = refEdges(view).map((r) => ({ id: `ref-${r.from}-${r.field}`, fromNode: r.from, toNode: r.to, label: r.label, toEnd: 'arrow', [NS]: { ref: r.field } }));
  const nodes = doc.nodes.map((n) => {
    if (!isInstance(n)) return n;
    const t = typeOf(view, ctypeOf(n));
    if (!t) return n;
    return { ...n, text: [`### ${t.icon ? t.icon + ' ' : ''}${titleOf(view, n)}`, `*${t.name}*`, '', ...fieldLines(view, t, data(n))].join('\n') };
  });
  return { ...doc, nodes, edges: [...doc.edges.filter((e) => !e[NS]), ...edges] };
}

/** Import filter: drop what shapeExport derived (the values are the truth). */
export function repairImport(doc: CanvasDoc): CanvasDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (!isInstance(n)) return n;
      const { text: _t, ...rest } = n;
      return rest;
    }),
    edges: doc.edges.filter((e) => !e[NS]),
  };
}

