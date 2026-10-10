import type { CanvasDoc, CanvasEdge, CanvasNode } from './doc';

/** Serialize to a JSON Canvas file. Unknown/plugin fields are kept as-is. */
export function serialize(doc: CanvasDoc): string {
  return JSON.stringify({ nodes: doc.nodes, edges: doc.edges }, null, '\t') + '\n';
}

export function parse(text: string): CanvasDoc {
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a JSON Canvas file');
  const { nodes = [], edges = [] } = raw as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('nodes/edges must be arrays');
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || typeof n.type !== 'string') throw new Error('node needs id and type');
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      if (typeof n[k] !== 'number' || !Number.isFinite(n[k])) throw new Error(`node ${n.id}: ${k} must be a number`);
    }
  }
  for (const e of edges) {
    if (!e || typeof e.id !== 'string' || typeof e.fromNode !== 'string' || typeof e.toNode !== 'string') {
      throw new Error('edge needs id, fromNode, toNode');
    }
  }
  return { nodes: nodes as CanvasNode[], edges: edges as CanvasEdge[] };
}
