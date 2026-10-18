import type { CanvasNode, DocView } from './doc';

// Reading the board for agents: compact node summaries and filters, plus "which node does this
// name mean" so agents can say `connect "Order placed" "Payment taken"` instead of ids.

export interface NodeSummary {
  id: string;
  type: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  /** Column (group) this node sits in, by label. */
  column?: string;
  /** Plugin namespaces on it (x-cards, x-sync…). */
  ext?: string[];
  /** The plugin fields a plugin marked as worth listing (`Store.summaryExt`), by namespace. */
  data?: Record<string, unknown>;
  links?: { id: string; to: string; label?: string }[];
}

export const titleOf = (n: CanvasNode) => (n.label ?? n.text ?? n.url ?? n.file ?? '').split('\n')[0].replace(/^#+\s*/, '').trim();

export function summarize(doc: DocView, n: CanvasNode, keep: ReadonlySet<string> = new Set()): NodeSummary {
  const carrier = doc.carrierOf(n.id);
  const ext = Object.keys(n).filter((k) => k.startsWith('x-'));
  const links = doc.edges.filter((e) => e.fromNode === n.id).map((e) => ({ id: e.id, to: e.toNode, ...(e.label ? { label: e.label } : {}) }));
  const data = Object.fromEntries(ext.filter((k) => keep.has(k)).map((k) => [k, n[k as keyof CanvasNode]]));
  const text = n.text ?? n.label ?? n.url ?? n.file;
  return {
    id: n.id,
    type: n.type,
    ...(text !== undefined ? { text } : {}),
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    ...(n.color ? { color: n.color } : {}),
    ...(carrier ? { column: titleOf(doc.get(carrier)!) } : {}),
    ...(ext.length ? { ext } : {}),
    ...(Object.keys(data).length ? { data } : {}),
    ...(links.length ? { links } : {}),
  };
}

/** Filters: type, text (substring, case-insensitive), column (label), ext (namespace, e.g. x-sync). */
export function queryNodes(doc: DocView, q: { type?: string; text?: string; column?: string; ext?: string }, keep?: ReadonlySet<string>, unlisted: readonly ((n: CanvasNode, doc: DocView) => boolean)[] = []): NodeSummary[] {
  const text = q.text?.toLowerCase();
  const column = q.column?.toLowerCase();
  return doc.nodes
    .filter((n) => !unlisted.some((f) => f(n, doc)))
    .map((n) => summarize(doc, n, keep))
    .filter((s) => !q.type || s.type === q.type)
    .filter((s) => !text || (s.text ?? '').toLowerCase().includes(text))
    .filter((s) => !column || (s.column ?? '').toLowerCase() === column)
    .filter((s) => !q.ext || (s.ext ?? []).includes(q.ext.startsWith('x-') ? q.ext : `x-${q.ext}`));
}

/** A node by id, else by exact title, else by a unique title prefix/substring. Throws when ambiguous. */
export function resolveNode(doc: { nodes: CanvasNode[] }, ref: string): CanvasNode {
  const byId = doc.nodes.find((n) => n.id === ref);
  if (byId) return byId;
  const r = ref.toLowerCase();
  for (const test of [(t: string) => t === r, (t: string) => t.startsWith(r), (t: string) => t.includes(r)]) {
    const hits = doc.nodes.filter((n) => test(titleOf(n).toLowerCase()));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} nodes: ${hits.slice(0, 5).map((n) => `${n.id} (${titleOf(n)})`).join(', ')}`);
  }
  throw new Error(`no node "${ref}"`);
}
