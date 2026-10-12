// Change-map layout (ELK layered) and its quality metrics. Pure: no DOM, so tests can run it on the samples.
import type { ElkNode, ElkExtendedEdge, LayoutOptions } from "elkjs/lib/elk.bundled.js";
export interface MapNode { id: string; label: string; group?: string; state?: string }
export interface MapEdge { from: string; to: string; label?: string; state?: string }
export interface MapGroup { id: string; label: string }
export interface DocMap { groups: MapGroup[]; nodes: MapNode[]; edges: MapEdge[] }

export const FONT = "500 13px ui-sans-serif, system-ui, sans-serif";
export const LABEL_FONT = "400 11px ui-sans-serif, system-ui, sans-serif";
export const GROUP_FONT = "600 10.5px ui-sans-serif, system-ui, sans-serif";
export const LINE_H = 16;              // node label line height
export const NODE_PAD_X = 12, ICON_W = 12;
export const EDGE_LINE_H = 13;
const NODE_TEXT_MAX = 150;             // node labels wrap to two lines past this width
const EDGE_LABEL_MAX = 72;             // edge labels wrap past this width (to at most 3 lines)

export type Measure = (s: string, font: string) => number;
/** Rough text width for non-DOM callers (tests): average glyph widths of a system sans. */
export const approxMeasure: Measure = (s, font) => s.length * (font.includes("13px") ? 7.4 : 6.1);

export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }
export type Dir = "RIGHT" | "DOWN";
export interface LayoutEdge {
  key: string; from: string; to: string; d: string; pts: Pt[];
  label?: string; lines?: string[]; lbox?: Box; state?: string;
  both?: boolean;          // two edges a→b and b→a bundled into one line, arrows at both ends
}
export interface Layout {
  dir: Dir;
  w: number; h: number;
  nodes: Map<string, Box & { lines: string[] }>;
  groups: { id: string; label: string; box: Box }[];
  edges: LayoutEdge[];
}

/** Greedy word wrap into at most `maxLines` lines (the last one takes the rest). */
export function wrapText(s: string, font: string, max: number, measure: Measure, maxLines = 2): string[] {
  if (measure(s, font) <= max) return [s];
  const words = s.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const t = cur ? `${cur} ${words[i]}` : words[i];
    if (cur && measure(t, font) > max && lines.length < maxLines - 1) { lines.push(cur); cur = words[i]; } else cur = t;
  }
  lines.push(cur);
  return lines;
}

export function roundedPath(pts: Pt[], r = 8) {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1], c = pts[i], n = pts[i + 1];
    const d1 = Math.hypot(c.x - p.x, c.y - p.y), d2 = Math.hypot(n.x - c.x, n.y - c.y);
    if (d1 === 0 || d2 === 0) continue;
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const a = { x: c.x - ((c.x - p.x) / d1) * rr, y: c.y - ((c.y - p.y) / d1) * rr };
    const b = { x: c.x + ((n.x - c.x) / d2) * rr, y: c.y + ((n.y - c.y) / d2) * rr };
    d += ` L${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${last.x},${last.y}`;
}

let elkP: Promise<InstanceType<typeof import("elkjs/lib/elk.bundled.js").default>> | undefined;
const getElk = () => (elkP ??= import("elkjs/lib/elk.bundled.js").then((m) => new m.default()));

type BundledEdge = MapEdge & { both?: boolean };
/** Edges between the same two nodes become one line (labels joined): parallel lines only add clutter and crossings. */
function bundleEdges(edges: MapEdge[]): BundledEdge[] {
  const out: BundledEdge[] = [];
  const byPair = new Map<string, BundledEdge>();
  for (const e of edges) {
    const k = [e.from, e.to].sort().join("\u0000");
    const b = byPair.get(k);
    if (!b) { const n = { ...e }; byPair.set(k, n); out.push(n); continue; }
    if (b.from !== e.from) b.both = true;
    b.label = [b.label, e.label].filter(Boolean).join(" · ") || undefined;
    if (!b.state && e.state) b.state = e.state;
  }
  return out;
}

/** Greedy feedback arc set (Eades, Lin, Smyth): an order of `ids` with few edges pointing backwards. Ties keep input order. */
function fasOrder(ids: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const left = new Set(ids);
  const w = (a: string, b: string) => edges.filter((e) => e.from === a && e.to === b).length;
  const deg = (n: string, out: boolean) => [...left].reduce((s, m) => s + (m === n ? 0 : out ? w(n, m) : w(m, n)), 0);
  const head: string[] = [], tail: string[] = [];
  while (left.size) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const n of [...left]) {
        if (deg(n, true) === 0) { tail.unshift(n); left.delete(n); moved = true; }
        else if (deg(n, false) === 0) { head.push(n); left.delete(n); moved = true; }
      }
    }
    if (!left.size) break;
    let best = "", bd = -Infinity;
    for (const n of left) { const d = deg(n, true) - deg(n, false); if (d > bd) { bd = d; best = n; } }
    head.push(best); left.delete(best);
  }
  return new Map([...head, ...tail].map((n, i) => [n, i]));
}

/**
 * Edges to hand to ELK reversed so it sees a DAG. Cycles are broken here, group-aware, instead of by ELK: with
 * groups as compound nodes ELK keeps a back edge's ports on the flow sides and routes it around whole groups (often
 * around the whole map). Order first the groups (each group one super node, ungrouped nodes their own), then the
 * nodes inside each group; an edge against that order is laid out forwards and drawn with its arrow flipped.
 */
function backEdges(map: DocMap, edges: { from: string; to: string }[]): Set<number> {
  const groupIds = new Set(map.groups.map((g) => g.id));
  const sup = new Map(map.nodes.map((n) => [n.id, n.group && groupIds.has(n.group) ? `g:${n.group}` : n.id]));
  const supIds = [...new Set(map.nodes.map((n) => sup.get(n.id)!))];
  const outer = fasOrder(supIds, edges.map((e) => ({ from: sup.get(e.from)!, to: sup.get(e.to)! })).filter((e) => e.from !== e.to));
  const inner = new Map<string, number>();
  for (const s of supIds) {
    const members = map.nodes.filter((n) => sup.get(n.id) === s).map((n) => n.id);
    const ms = new Set(members);
    fasOrder(members, edges.filter((e) => ms.has(e.from) && ms.has(e.to))).forEach((v, k) => inner.set(k, v));
  }
  const rank = (id: string) => [outer.get(sup.get(id)!)!, inner.get(id)!];
  const back = new Set<number>();
  edges.forEach((e, i) => {
    const [a1, a2] = rank(e.from), [b1, b2] = rank(e.to);
    if (a1 > b1 || (a1 === b1 && a2 > b2)) back.add(i);
  });
  return back;
}

/**
 * Lays the map out with ELK layered + orthogonal routing. Groups are compound nodes laid out together with the
 * rest (INCLUDE_CHILDREN) so cross-group edges are routed in one pass. Edge labels are ELK labels (inline, centred
 * on their edge): ELK reserves room for them, so they never touch nodes or other edges.
 */
export async function layoutMap(map: DocMap, dir: Dir, measure: Measure, extra: LayoutOptions = {}): Promise<Layout> {
  const ids = new Set(map.nodes.map((n) => n.id));
  const lines = new Map(map.nodes.map((n) => [n.id, wrapText(n.label, FONT, NODE_TEXT_MAX, measure)]));
  const right = dir === "RIGHT";
  const mkNode = (n: MapNode): ElkNode => {
    const ls = lines.get(n.id)!;
    return {
      id: n.id, height: ls.length > 1 ? 18 + LINE_H * ls.length : 34,
      width: Math.max(96, Math.ceil(Math.max(...ls.map((l) => measure(l, FONT)))) + NODE_PAD_X * 2 + ICON_W),
      layoutOptions: { "elk.portConstraints": "FREE" },
    };
  };
  const groupIds = new Set(map.groups.map((g) => g.id));
  const children: ElkNode[] = [
    ...map.groups.map((g) => ({
      id: `g:${g.id}`,
      layoutOptions: {
        "elk.padding": "[top=32,left=14,bottom=14,right=14]",
        // wide enough for its title (uppercase, letter-spaced; drawn at x+14)
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${Math.ceil(measure(g.label.toUpperCase(), GROUP_FONT) * 1.12) + 30}, 0)`,
      },
      children: map.nodes.filter((n) => n.group === g.id).map(mkNode),
    })).filter((g) => g.children.length > 0),
    ...map.nodes.filter((n) => !n.group || !groupIds.has(n.group)).map(mkNode),
  ];
  const valid = bundleEdges(map.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to));
  const back = backEdges(map, valid);
  const labelLines = valid.map((e) => (e.label ? wrapText(e.label, LABEL_FONT, EDGE_LABEL_MAX, measure, 3) : undefined));
  const edges: ElkExtendedEdge[] = valid.map((e, i) => {
    const ls = labelLines[i];
    return {
      id: `e${i}`, sources: [back.has(i) ? e.to : e.from], targets: [back.has(i) ? e.from : e.to],
      labels: ls ? [{
        id: `l${i}`, text: e.label!,
        width: Math.ceil(Math.max(...ls.map((l) => measure(l, LABEL_FONT)))) + 10,
        height: ls.length * EDGE_LINE_H + 4,
      }] : [],
    };
  });
  const res: ElkNode = await (await getElk()).layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": dir,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.feedbackEdges": "false",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
      "elk.layered.crossingMinimization.greedySwitchHierarchical.type": "TWO_SIDED",
      "elk.layered.thoroughness": "40",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.nodePlacement.favorStraightEdges": "true",
      "elk.layered.mergeEdges": "false",
      "elk.edgeLabels.inline": "true",
      "elk.edgeLabels.placement": "CENTER",
      "elk.layered.edgeLabels.sideSelection": "SMART_DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": right ? "28" : "30",
      "elk.layered.spacing.edgeNodeBetweenLayers": "10",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "10",
      "elk.spacing.nodeNode": right ? "20" : "26",
      "elk.spacing.edgeNode": "16",
      "elk.spacing.edgeEdge": "12",
      "elk.spacing.edgeLabel": "2",
      "elk.spacing.labelNode": "6",
      "elk.json.edgeCoords": "ROOT",
      "elk.json.shapeCoords": "ROOT",
      "elk.padding": "[top=10,left=10,bottom=10,right=10]",
      ...extra,
    },
    children,
    edges,
  });

  const nodes: Layout["nodes"] = new Map();
  const groups: Layout["groups"] = [];
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      const box = { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 };
      if (c.id.startsWith("g:")) {
        const g = map.groups.find((g) => `g:${g.id}` === c.id)!;
        groups.push({ id: g.id, label: g.label, box });
        walk(c);
      } else nodes.set(c.id, { ...box, lines: lines.get(c.id)! });
    }
  };
  walk(res);

  const out: LayoutEdge[] = [];
  const collect = (n: ElkNode) => {
    for (const e of (n.edges ?? []) as ElkExtendedEdge[]) {
      const i = Number(e.id.slice(1));
      const src = valid[i];
      const s = e.sections?.[0];
      if (!s) continue;
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      if (back.has(i)) pts.reverse();
      const l = e.labels?.[0];
      out.push({
        key: e.id, from: src.from, to: src.to, d: roundedPath(pts), pts, label: src.label, state: src.state, both: src.both,
        lines: labelLines[i], lbox: l ? { x: l.x ?? 0, y: l.y ?? 0, w: l.width ?? 0, h: l.height ?? 0 } : undefined,
      });
    }
    (n.children ?? []).forEach(collect);
  };
  collect(res);
  out.sort((a, b) => Number(a.key.slice(1)) - Number(b.key.slice(1)));
  return { dir, w: res.width ?? 0, h: res.height ?? 0, nodes, groups, edges: out };
}

// ---- metrics (used by tests and to tune the options above)

type Seg = [Pt, Pt];
const segs = (pts: Pt[]): Seg[] => pts.slice(1).map((b, i) => [pts[i], b]);
const hv = (s: Seg) => (Math.abs(s[0].y - s[1].y) < 0.5 ? "h" : Math.abs(s[0].x - s[1].x) < 0.5 ? "v" : "d");
const between = (v: number, a: number, b: number, m = 0) => v > Math.min(a, b) + m && v < Math.max(a, b) - m;

function cross(a: Seg, b: Seg): boolean {
  const ta = hv(a), tb = hv(b);
  if (ta === tb || ta === "d" || tb === "d") return false; // parallel overlaps are merges, not crossings
  const [h, v] = ta === "h" ? [a, b] : [b, a];
  return between(v[0].x, h[0].x, h[1].x, 0.5) && between(h[0].y, v[0].y, v[1].y, 0.5);
}

function segHitsBox(s: Seg, b: Box, m = 0): boolean {
  const x1 = Math.min(s[0].x, s[1].x), x2 = Math.max(s[0].x, s[1].x);
  const y1 = Math.min(s[0].y, s[1].y), y2 = Math.max(s[0].y, s[1].y);
  return x1 < b.x + b.w - m && x2 > b.x + m && y1 < b.y + b.h - m && y2 > b.y + m;
}

export interface MapMetrics {
  crossings: number;
  outside: string[];      // edges that run around the outside of everything (no node/group spans that line)
  labelHitsEdge: number;  // label boxes crossed by another edge
  labelHitsNode: number;
  bends: number;
  w: number; h: number;
}

export function mapMetrics(l: Layout): MapMetrics {
  const es = l.edges.map((e) => ({ e, s: segs(e.pts) }));
  let crossings = 0;
  for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
    for (const a of es[i].s) for (const b of es[j].s) if (cross(a, b)) crossings++;
  }
  const boxes = [...l.nodes.values(), ...l.groups.map((g) => g.box)];
  const minX = Math.min(...boxes.map((b) => b.x)), maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.y)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const outside = l.edges.filter((e) => e.pts.some((p) => p.x < minX - 1 || p.x > maxX + 1 || p.y < minY - 1 || p.y > maxY + 1)).map((e) => `${e.from}->${e.to}`);
  let labelHitsEdge = 0, labelHitsNode = 0;
  for (const { e } of es) {
    if (!e.lbox) continue;
    for (const o of es) if (o.e !== e && o.s.some((s) => segHitsBox(s, e.lbox!, 1))) labelHitsEdge++;
    for (const n of l.nodes.values()) if (segHitsBox([{ x: n.x, y: n.y }, { x: n.x + n.w, y: n.y + n.h }], e.lbox, 1)) labelHitsNode++;
  }
  const bends = l.edges.reduce((s, e) => s + Math.max(0, e.pts.length - 2), 0);
  return { crossings, outside, labelHitsEdge, labelHitsNode, bends, w: Math.round(l.w), h: Math.round(l.h) };
}
