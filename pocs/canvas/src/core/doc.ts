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
  /**
   * Nodes shown on the table: everything not contained in another node (e.g. cards inside a deck),
   * plus contained nodes a layout places (e.g. cards fanned out in a hand).
   */
  visible: CanvasNode[];
  isVisible(id: string): boolean;
  /** Display-only extras from layouts (rotation in degrees). Not part of the document. */
  styleOf(id: string): { angle?: number } | undefined;
  /** Nodes contained in `id`, in z order. */
  children(id: string): CanvasNode[];
  /** Id of the containing node, if it exists. */
  parentOf(id: string): string | undefined;
  /** Highest z in the doc (0 if empty). */
  topZ: number;
  /** Nodes that ride on `id` (move and come to front with it), in z order. */
  riders(id: string): CanvasNode[];
  /** Id of the node `id` rides on, if it exists. */
  carrierOf(id: string): string | undefined;
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
  | { op: 'del'; id: string }
  /** Add or replace an edge (JSON Canvas edge, whole object). Ignored if either end is missing. */
  | { op: 'edge'; edge: CanvasEdge }
  | { op: 'delEdge'; id: string };

export const set = (id: string, key: string, value: unknown): Change => ({ op: 'set', id, key, value });

export const emptyDoc = (): CanvasDoc => ({ nodes: [], edges: [] });

export const byZ = (a: CanvasNode, b: CanvasNode) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Containment rule supplied by plugins: return the id of the node that contains `node`, if any.
 * `all` = the nodes being linked, in z order (bottom first), for rules that go by geometry.
 */
export type ParentOf = (node: CanvasNode, get: (id: string) => CanvasNode | undefined, all: readonly CanvasNode[]) => string | undefined;

/**
 * Rider rule supplied by plugins: return the id of the node that carries `node` (e.g. a board its
 * pieces). Riders stay separate, selectable objects; they move and come to front with their carrier.
 */
export type CarrierOf = ParentOf;

/**
 * Duplicate rule supplied by plugins: return the copy's content (id/position/z are set by core),
 * `null` to refuse copying this node, `undefined` for no opinion (next rule; default: a verbatim copy).
 * `copyOf(id)`: the id the copy of another node in the same duplicate gets (undefined if that node
 * isn't being duplicated), so a copy can point at its copied board instead of the original.
 */
export type DuplicateRule = (node: CanvasNode, doc: DocView, copyOf: (id: string) => string | undefined) => CanvasNode | null | undefined;

/** Where a layout puts a node: position/size/stacking override, plus display-only rotation. */
export type Placement = Partial<Pick<CanvasNode, 'x' | 'y' | 'z' | 'width' | 'height'>> & { angle?: number };

/**
 * A layout rule supplied by plugins: given the doc (containment resolved, no layouts applied yet),
 * return placements. A placement for a contained node also makes it visible. Layouts are derived
 * at read time (never written to the doc), so moving a container moves its contents for free and
 * concurrent edits can't leave stale positions behind.
 */
export type LayoutRule = (doc: DocView) => Map<string, Placement>;

export function makeView(
  doc: CanvasDoc,
  parentRules: readonly ParentOf[] = [],
  layouts: readonly LayoutRule[] = [],
  riderRules: readonly CarrierOf[] = [],
): DocView {
  const base = buildView(doc, parentRules, riderRules, new Map());
  if (!layouts.length) return base;
  const placed = new Map<string, Placement>();
  for (const rule of layouts) for (const [id, p] of rule(base)) placed.set(id, { ...placed.get(id), ...p });
  if (!placed.size) return base;
  const nodes = doc.nodes.map((n) => {
    const p = placed.get(n.id);
    if (!p) return n;
    const { angle: _a, ...fields } = p;
    return { ...n, ...fields };
  });
  return buildView({ ...doc, nodes }, parentRules, riderRules, placed);
}

/** Index nodes by the first rule that names an existing other node for them. */
function link(nodes: CanvasNode[], get: (id: string) => CanvasNode | undefined, rules: readonly ParentOf[]) {
  const up = new Map<string, string>();
  const down = new Map<string, CanvasNode[]>();
  if (!rules.length) return { up, down };
  for (const n of nodes) {
    for (const rule of rules) {
      const p = rule(n, get, nodes);
      if (p && p !== n.id && get(p)) {
        up.set(n.id, p);
        let list = down.get(p);
        if (!list) down.set(p, (list = []));
        list.push(n);
        break;
      }
    }
  }
  return { up, down };
}

function buildView(doc: CanvasDoc, parentRules: readonly ParentOf[], riderRules: readonly CarrierOf[], placed: Map<string, Placement>): DocView {
  const nodes = doc.nodes.slice().sort(byZ);
  const map = new Map(nodes.map((n) => [n.id, n]));
  const get = (id: string) => map.get(id);
  const { up: parent, down: kids } = link(nodes, get, parentRules);
  // contained nodes don't ride (their container already carries them)
  const { up: carrier, down: riders } = link(
    nodes.filter((n) => !parent.has(n.id)),
    get,
    riderRules,
  );
  const shown = (id: string) => !parent.has(id) || placed.has(id);
  return {
    nodes,
    edges: doc.edges,
    extra: doc.extra,
    get,
    visible: nodes.filter((n) => shown(n.id)),
    isVisible: (id) => map.has(id) && shown(id),
    styleOf: (id) => {
      const a = placed.get(id)?.angle;
      return a ? { angle: a } : undefined;
    },
    children: (id) => kids.get(id) ?? [],
    parentOf: (id) => parent.get(id),
    topZ: nodes.length ? (nodes[nodes.length - 1].z ?? 0) : 0,
    riders: (id) => riders.get(id) ?? [],
    carrierOf: (id) => carrier.get(id),
  };
}
