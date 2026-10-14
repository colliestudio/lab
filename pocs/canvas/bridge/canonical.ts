import type { CanvasDoc, CanvasEdge, CanvasNode, Change } from '../src/core/doc';

// The .canvas file as a git-friendly record: the same document always serializes to the same text
// (fixed key order, tabs like Obsidian, nodes in z order, edges by id), so a diff shows only what
// changed. And the way back: a file edit becomes per-field Changes against the live doc, so a
// concurrent edit to another field (or another node) by a player in the browser survives.

const NODE_KEYS = ['id', 'type', 'text', 'file', 'subpath', 'url', 'label', 'x', 'y', 'width', 'height', 'color', 'background', 'backgroundStyle', 'owner'];
const EDGE_KEYS = ['id', 'fromNode', 'fromSide', 'fromEnd', 'toNode', 'toSide', 'toEnd', 'color', 'label'];

function ordered(o: Record<string, unknown>, first: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of first) if (o[k] !== undefined) out[k] = o[k];
  for (const k of Object.keys(o).sort()) if (!(k in out) && o[k] !== undefined) out[k] = sortDeep(o[k]);
  return out;
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return ordered(v as Record<string, unknown>, []);
  return v;
}

/** Canonical JSON Canvas text. `doc.nodes` must already be in z order (Store.exportDoc gives that). */
export function stableSerialize(doc: CanvasDoc): string {
  const nodes = doc.nodes.map(({ z: _z, ...n }) => ordered(n, NODE_KEYS));
  const edges = doc.edges
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ordered(e as unknown as Record<string, unknown>, EDGE_KEYS));
  const extra = ordered(doc.extra ?? {}, []);
  return JSON.stringify({ ...extra, nodes, edges }, null, '\t') + '\n';
}

const same = (a: unknown, b: unknown) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Field changes that turn node `cur` into `next` (plugin namespaces per sub-field). */
function nodeChanges(cur: CanvasNode, next: CanvasNode): Change[] {
  const out: Change[] = [];
  const keys = new Set([...Object.keys(cur), ...Object.keys(next)]);
  keys.delete('z');
  keys.delete('id');
  for (const k of keys) {
    const a = cur[k as keyof CanvasNode] as unknown;
    const b = next[k as keyof CanvasNode] as unknown;
    if (same(a, b)) continue;
    if (k.startsWith('x-') && isObj(b)) {
      if (!isObj(a)) {
        if (a !== undefined) out.push({ op: 'set', id: cur.id, key: k, value: undefined });
        for (const [sk, sv] of Object.entries(b)) out.push({ op: 'set', id: cur.id, key: `${k}.${sk}`, value: sv });
        continue;
      }
      for (const sk of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[sk], b[sk])) out.push({ op: 'set', id: cur.id, key: `${k}.${sk}`, value: b[sk] });
      continue;
    }
    out.push({ op: 'set', id: cur.id, key: k, value: b });
  }
  return out;
}

export interface FileDiff {
  changes: Change[];
  /** New top-level fields (undefined = unchanged). */
  extra?: Record<string, unknown>;
  summary: { added: string[]; changed: string[]; removed: string[]; edges: number };
}

/**
 * What to apply to the live doc (`cur`: nodes with z, any order) so it matches the file (`next`:
 * array order = z order). z: kept when the file's order of the existing nodes is unchanged (new
 * nodes slot in between their neighbours); renumbered 1..n when the file reordered them.
 */
export function diffFile(cur: CanvasDoc, next: CanvasDoc): FileDiff {
  const changes: Change[] = [];
  const byId = new Map(cur.nodes.map((n) => [n.id, n]));
  const nextIds = new Set(next.nodes.map((n) => n.id));
  const summary: FileDiff['summary'] = { added: [], changed: [], removed: [], edges: 0 };
  // z
  const curOrder = cur.nodes
    .slice()
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : 1))
    .map((n) => n.id)
    .filter((id) => nextIds.has(id));
  const fileOrder = next.nodes.map((n) => n.id).filter((id) => byId.has(id));
  const reordered = curOrder.join('\n') !== fileOrder.join('\n');
  const zs: number[] = [];
  if (reordered) next.nodes.forEach((_, i) => zs.push(i + 1));
  else {
    // existing nodes keep z; new ones go between the neighbours they sit between in the file
    next.nodes.forEach((n, i) => {
      const have = byId.get(n.id);
      if (have) return void (zs[i] = have.z ?? 0);
      const prev = i > 0 ? zs[i - 1] : undefined;
      let after: number | undefined;
      for (let j = i + 1; j < next.nodes.length; j++) {
        const h = byId.get(next.nodes[j].id);
        if (h) {
          after = h.z ?? 0;
          break;
        }
      }
      zs[i] = prev === undefined ? (after === undefined ? 1 : after - 1) : after === undefined ? prev + 1 : (prev + after) / 2;
    });
  }
  next.nodes.forEach((n, i) => {
    const have = byId.get(n.id);
    const { z: _z, ...plain } = n;
    if (!have) {
      changes.push({ op: 'add', node: { ...plain, z: zs[i] } as CanvasNode });
      summary.added.push(n.id);
      return;
    }
    const cs = nodeChanges(have, plain as CanvasNode);
    if ((have.z ?? 0) !== zs[i]) cs.push({ op: 'set', id: n.id, key: 'z', value: zs[i] });
    if (cs.length) {
      changes.push(...cs);
      if (cs.some((c) => c.op === 'set' && c.key !== 'z')) summary.changed.push(n.id);
    }
  });
  for (const n of cur.nodes) {
    if (nextIds.has(n.id)) continue;
    changes.push({ op: 'del', id: n.id });
    summary.removed.push(n.id);
  }
  // edges
  const curEdges = new Map(cur.edges.map((e) => [e.id, e]));
  const nextEdges = new Map(next.edges.map((e) => [e.id, e]));
  for (const e of next.edges) {
    if (same(curEdges.get(e.id), e)) continue;
    changes.push({ op: 'edge', edge: e as CanvasEdge });
    summary.edges++;
  }
  for (const e of cur.edges) {
    if (nextEdges.has(e.id)) continue;
    changes.push({ op: 'unedge', id: e.id });
    summary.edges++;
  }
  const extra = same(cur.extra ?? {}, next.extra ?? {}) ? undefined : (next.extra ?? {});
  return { changes, extra, summary };
}

/** "2 added, 1 changed, 1 link" for the log. */
export function describeDiff(s: FileDiff['summary']): string {
  const parts = [
    s.added.length && `${s.added.length} added`,
    s.changed.length && `${s.changed.length} changed`,
    s.removed.length && `${s.removed.length} removed`,
    s.edges && `${s.edges} link${s.edges === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return parts.join(', ') || 'reordered';
}
