// Document model. The live doc is a Y.Doc (see store.ts); commands read a plain, read-only
// snapshot of it (DocView) and return per-field Changes. JSON Canvas 1.0
// (https://jsoncanvas.org/spec/1.0/) is the import/export format (see io.ts).
// Plugins keep their data in namespaced `x-<plugin>` fields on standard nodes.

export type ExtFields = { [ext: `x-${string}`]: unknown };

export interface CanvasNode extends ExtFields {
  id: string;
  type: 'text' | 'file' | 'link' | 'group' | (string & {});
  x: number;
  y: number;
  width: number;
  height: number;
  /** Stacking order (higher = on top). Live doc only; on export it becomes array order. */
  z?: number;
  /** Player id that owns this node (private hands, peeking). Unused until fog of war. */
  owner?: string;
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

/** Plain document: what JSON Canvas files hold. `extra` = unknown top-level fields, kept verbatim. */
export interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  extra?: Record<string, unknown>;
}

/** Read-only snapshot handed to commands and renderers. `nodes` sorted by z (bottom first). */
export interface DocView extends CanvasDoc {
  get(id: string): CanvasNode | undefined;
  /** Nodes shown on the table: everything not contained in another node (e.g. cards inside a deck). */
  visible: CanvasNode[];
  /** Nodes contained in `id`, in z order. */
  children(id: string): CanvasNode[];
  /** Id of the containing node, if it exists. */
  parentOf(id: string): string | undefined;
  /** Highest z in the doc (0 if empty). */
  topZ: number;
}

/**
 * The only ways a document changes. Plain data (sendable, replayable).
 * `set` targets one field; `key` may be "x-plugin.field" to reach into a plugin namespace,
 * so concurrent edits to different fields of the same node both survive.
 * `value: undefined` deletes the field.
 */
export type Change =
  | { op: 'add'; node: CanvasNode }
  | { op: 'set'; id: string; key: string; value: unknown }
  | { op: 'del'; id: string };

export const set = (id: string, key: string, value: unknown): Change => ({ op: 'set', id, key, value });

export const emptyDoc = (): CanvasDoc => ({ nodes: [], edges: [] });

export const byZ = (a: CanvasNode, b: CanvasNode) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Containment rule supplied by plugins: return the id of the node that contains `node`, if any. */
export type ParentOf = (node: CanvasNode, get: (id: string) => CanvasNode | undefined) => string | undefined;

export function makeView(doc: CanvasDoc, parentRules: readonly ParentOf[] = []): DocView {
  const nodes = doc.nodes.slice().sort(byZ);
  const map = new Map(nodes.map((n) => [n.id, n]));
  const get = (id: string) => map.get(id);
  const parent = new Map<string, string>();
  const kids = new Map<string, CanvasNode[]>();
  for (const n of nodes) {
    for (const rule of parentRules) {
      const p = rule(n, get);
      if (p && p !== n.id && map.has(p)) {
        parent.set(n.id, p);
        let list = kids.get(p);
        if (!list) kids.set(p, (list = []));
        list.push(n);
        break;
      }
    }
  }
  return {
    nodes,
    edges: doc.edges,
    extra: doc.extra,
    get,
    visible: nodes.filter((n) => !parent.has(n.id)),
    children: (id) => kids.get(id) ?? [],
    parentOf: (id) => parent.get(id),
    topZ: nodes.length ? (nodes[nodes.length - 1].z ?? 0) : 0,
  };
}
