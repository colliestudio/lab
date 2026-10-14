import type { CanvasDoc, CanvasEdge, CanvasNode } from './doc';

/** Serialize to a JSON Canvas file. Node array order = z order. Unknown fields are kept. */
export function serialize(doc: CanvasDoc): string {
  return JSON.stringify({ ...doc.extra, nodes: doc.nodes, edges: doc.edges }, null, '\t') + '\n';
}

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/**
 * Parse a JSON Canvas file. Throws only if the file isn't a JSON Canvas at all; malformed nodes and
 * edges are skipped (reported in `skipped`). Unknown top-level fields land in `extra`.
 */
export function parse(text: string): CanvasDoc & { skipped: string[] } {
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a JSON Canvas file');
  const { nodes = [], edges = [], ...extra } = raw as Record<string, unknown>;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('nodes/edges must be arrays');
  const skipped: string[] = [];
  const seen = new Set<string>();
  const okNodes = nodes.filter((n, i): n is CanvasNode => {
    const ok =
      !!n &&
      typeof n === 'object' &&
      typeof n.id === 'string' &&
      !seen.has(n.id) &&
      typeof n.type === 'string' &&
      ['x', 'y', 'width', 'height'].every((k) => isNum(n[k]));
    if (ok) seen.add(n.id);
    else skipped.push(`node #${i}${n?.id ? ` (${n.id})` : ''}`);
    return ok;
  });
  const okEdges = edges.filter((e, i): e is CanvasEdge => {
    const ok = !!e && typeof e.id === 'string' && seen.has(e.fromNode) && seen.has(e.toNode);
    if (!ok) skipped.push(`edge #${i}`);
    return ok;
  });
  // z is a live-doc field; a file's array order is its z order.
  const out = okNodes.map(({ z: _z, ...n }) => n as CanvasNode);
  return { nodes: out, edges: okEdges, extra: Object.keys(extra).length ? extra : undefined, skipped };
}
