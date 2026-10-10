// Document model: JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/).
// Plugins keep their data in namespaced `x-<plugin>` fields on standard nodes,
// so any JSON Canvas reader (Obsidian) still opens the file.

export type ExtFields = { [ext: `x-${string}`]: unknown };

export interface CanvasNode extends ExtFields {
  id: string;
  type: 'text' | 'file' | 'link' | 'group' | (string & {});
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
}

export interface CanvasEdge extends ExtFields {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  toSide?: string;
  fromEnd?: string;
  toEnd?: string;
  color?: string;
  label?: string;
}

/** Node array order is z-order (first = bottom), as in the spec. */
export interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** The only ways a document changes. Plain data, so they can later be sent over the wire. */
export type Change =
  | { op: 'put'; node: CanvasNode } // add (on top) or replace in place
  | { op: 'del'; id: string }
  | { op: 'front'; ids: string[] }; // move to top, keeping relative order

export const emptyDoc = (): CanvasDoc => ({ nodes: [], edges: [] });

export function applyChanges(doc: CanvasDoc, changes: readonly Change[]): CanvasDoc {
  let nodes = doc.nodes.slice();
  let edges = doc.edges;
  for (const c of changes) {
    switch (c.op) {
      case 'put': {
        const i = nodes.findIndex((n) => n.id === c.node.id);
        if (i >= 0) nodes[i] = c.node;
        else nodes.push(c.node);
        break;
      }
      case 'del':
        nodes = nodes.filter((n) => n.id !== c.id);
        edges = edges.filter((e) => e.fromNode !== c.id && e.toNode !== c.id);
        break;
      case 'front': {
        const ids = new Set(c.ids);
        nodes = [...nodes.filter((n) => !ids.has(n.id)), ...nodes.filter((n) => ids.has(n.id))];
        break;
      }
    }
  }
  return { nodes, edges };
}

export const getNode = (doc: CanvasDoc, id: string) => doc.nodes.find((n) => n.id === id);
