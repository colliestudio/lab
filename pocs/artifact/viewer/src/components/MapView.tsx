import { useEffect, useMemo, useRef, useState } from "react";
import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import type { DocMap, MapNode } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { iconPaths } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { CHANGE_LABEL, cx, fileSections, plural } from "../util.ts";

const elk = new ELK();
const FONT = "500 13px ui-sans-serif, system-ui, sans-serif";
const LABEL_FONT = "400 11px ui-sans-serif, system-ui, sans-serif";
const LINE_H = 16;              // node label line height
const NODE_PAD_X = 12, ICON_W = 24;
const NODE_TEXT_MAX = 150;      // node labels wrap to two lines past this width
const EDGE_LABEL_MAX = 64;      // edge labels wrap past this width (they sit in the gaps between layers)
const EDGE_LINE_H = 13;

let ctx2d: CanvasRenderingContext2D | null = null;
function textW(s: string, font: string) {
  ctx2d ??= document.createElement("canvas").getContext("2d");
  if (!ctx2d) return s.length * 7;
  ctx2d.font = font;
  return ctx2d.measureText(s).width;
}

/** Greedy word wrap into at most `maxLines` lines (the last one takes the rest). */
function wrapText(s: string, font: string, max: number, maxLines = 2): string[] {
  if (textW(s, font) <= max) return [s];
  const words = s.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const t = cur ? `${cur} ${words[i]}` : words[i];
    if (cur && textW(t, font) > max && lines.length < maxLines - 1) { lines.push(cur); cur = words[i]; } else cur = t;
  }
  lines.push(cur);
  return lines;
}

interface Box { x: number; y: number; w: number; h: number }
type Dir = "RIGHT" | "DOWN";
interface Layout {
  dir: Dir;
  w: number; h: number;
  nodes: Map<string, Box & { lines: string[] }>;
  groups: { id: string; label: string; box: Box }[];
  edges: { key: string; from: string; to: string; d: string; label?: string; lines?: string[]; lbox?: Box; hidden?: boolean; change?: string }[];
}

function roundedPath(pts: { x: number; y: number }[], r = 8) {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1], c = pts[i], n = pts[i + 1];
    const d1 = Math.hypot(c.x - p.x, c.y - p.y), d2 = Math.hypot(n.x - c.x, n.y - c.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const a = { x: c.x - ((c.x - p.x) / d1) * rr, y: c.y - ((c.y - p.y) / d1) * rr };
    const b = { x: c.x + ((n.x - c.x) / d2) * rr, y: c.y + ((n.y - c.y) / d2) * rr };
    d += ` L${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${last.x},${last.y}`;
}

const overlaps = (a: Box, b: Box, m = 2) =>
  a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

/**
 * Edge labels are not given to ELK (label dummies double the number of layers and push the map wide/tall).
 * Instead each label sits on its own edge: candidates along the route's segments, longest segments first;
 * the first spot that clears every node, group title and already-placed label wins. Labels with no free spot
 * are `hidden`: drawn only while one of the edge's nodes (or the edge) is hovered.
 */
function placeLabels(edges: Layout["edges"], pts: { x: number; y: number }[][], obstacles: Box[], W: number, H: number) {
  const placed: Box[] = [];
  const order = edges.map((_, i) => i).sort((a, b) => Number(edges[b].change !== undefined && edges[b].change !== "unchanged")
    - Number(edges[a].change !== undefined && edges[a].change !== "unchanged"));
  for (const i of order) {
    const e = edges[i];
    if (!e.label) continue;
    const ls = wrapText(e.label, LABEL_FONT, EDGE_LABEL_MAX, 3);
    e.lines = ls;
    const w = Math.ceil(Math.max(...ls.map((l) => textW(l, LABEL_FONT)))) + 10, h = ls.length * EDGE_LINE_H + 4;
    const segs = pts[i].slice(1).map((b, k) => ({ a: pts[i][k], b, len: Math.hypot(b.x - pts[i][k].x, b.y - pts[i][k].y) }))
      .sort((x, y) => y.len - x.len);
    const cands: { x: number; y: number }[] = [];
    const beside: { x: number; y: number }[] = []; // second choice: touching the line instead of centred on it
    for (const { a, b, len } of segs) {
      const n = Math.max(0, Math.floor(len / 24));
      // middle first, then outwards along the segment
      const ts = [0.5, ...Array.from({ length: n }, (_, k) => (k + 0.5) / n).sort((p, q) => Math.abs(p - 0.5) - Math.abs(q - 0.5))];
      const horiz = Math.abs(b.y - a.y) < Math.abs(b.x - a.x);
      for (const t of ts) {
        const c = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        cands.push(c);
        if (horiz) beside.push({ x: c.x, y: c.y - h / 2 - 1 }, { x: c.x, y: c.y + h / 2 + 1 });
        else beside.push({ x: c.x - w / 2 - 1, y: c.y }, { x: c.x + w / 2 + 1, y: c.y });
      }
    }
    cands.push(...beside);
    let best: Box | undefined;
    for (const c of cands) {
      const box = { x: c.x - w / 2, y: c.y - h / 2, w, h };
      if (box.x < 1 || box.y < 1 || box.x + w > W - 1 || box.y + h > H - 1) continue;
      if (obstacles.some((o) => overlaps(box, o)) || placed.some((o) => overlaps(box, o, 3))) continue;
      best = box;
      break;
    }
    if (best) { placed.push(best); e.lbox = best; }
    else {
      const c = cands[0];
      e.lbox = c && { x: c.x - w / 2, y: c.y - h / 2, w, h };
      e.hidden = true;
    }
  }
}

async function layout(map: DocMap, dir: Dir): Promise<Layout> {
  const ids = new Set(map.nodes.map((n) => n.id));
  const lines = new Map(map.nodes.map((n) => [n.id, wrapText(n.label, FONT, NODE_TEXT_MAX)]));
  const mkNode = (n: MapNode): ElkNode => {
    const ls = lines.get(n.id)!;
    return {
      id: n.id, height: ls.length > 1 ? 18 + LINE_H * ls.length : 34,
      width: Math.max(96, Math.ceil(Math.max(...ls.map((l) => textW(l, FONT)))) + NODE_PAD_X * 2 + ICON_W),
    };
  };
  const groupIds = new Set(map.groups.map((g) => g.id));
  const children: ElkNode[] = [
    ...map.groups.map((g) => ({
      id: `g:${g.id}`,
      layoutOptions: { "elk.padding": "[top=30,left=12,bottom=12,right=12]" },
      children: map.nodes.filter((n) => n.group === g.id).map(mkNode),
    })).filter((g) => g.children.length > 0),
    ...map.nodes.filter((n) => !n.group || !groupIds.has(n.group)).map(mkNode),
  ];
  const valid = map.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const edges: ElkExtendedEdge[] = valid.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] }));
  const res: ElkNode = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": dir,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": dir === "RIGHT" ? "64" : "40",
      "elk.layered.spacing.edgeNodeBetweenLayers": "14",
      "elk.spacing.nodeNode": dir === "RIGHT" ? "18" : "24",
      "elk.spacing.edgeNode": "14",
      "elk.spacing.edgeEdge": "10",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.json.edgeCoords": "ROOT",
      "elk.json.shapeCoords": "ROOT",
      "elk.padding": "[top=10,left=10,bottom=10,right=10]",
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

  const outEdges: Layout["edges"] = [];
  const routes: { x: number; y: number }[][] = [];
  const collect = (n: ElkNode) => {
    for (const e of (n.edges ?? []) as ElkExtendedEdge[]) {
      const src = valid[Number(e.id.slice(1))];
      const s = e.sections?.[0];
      if (!s) continue;
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      routes.push(pts);
      outEdges.push({ key: e.id, from: src.from, to: src.to, d: roundedPath(pts), label: src.label, change: src.change });
    }
    (n.children ?? []).forEach(collect);
  };
  collect(res);
  const groupTitles = groups.map((g) => ({ x: g.box.x, y: g.box.y, w: Math.min(g.box.w, textW(g.label.toUpperCase(), "600 10.5px sans-serif") * 1.12 + 28), h: 28 }));
  placeLabels(outEdges, routes, [...nodes.values(), ...groupTitles], res.width ?? 0, res.height ?? 0);
  return { dir, w: res.width ?? 0, h: res.height ?? 0, nodes, groups, edges: outEdges };
}

/** Lays the map out both ways; the viewer shows whichever fits its box at the larger scale (ties go left-to-right). */
async function layoutBoth(map: DocMap) {
  const [right, down] = await Promise.all([layout(map, "RIGHT"), layout(map, "DOWN")]);
  return { right, down };
}
function pick(l: { right: Layout; down: Layout }, availW: number, availH: number): Layout {
  const force = new URLSearchParams(location.search).get("mapdir");
  if (force === "down") return l.down;
  if (force === "right") return l.right;
  // Left-to-right reads best and stays short; top-down only when left-to-right would have to shrink a lot more.
  const scale = (x: Layout) => Math.min(availW / x.w, availH / x.h, 1);
  return scale(l.right) < 0.85 && scale(l.down) > scale(l.right) + 0.1 ? l.down : l.right;
}

type PlanMark = "done" | "notDone" | "deferred" | "unplanned";

export function MapView({ focusSection, compact, overlay, onOpen }: {
  focusSection?: string | null; compact?: boolean; overlay?: boolean; onOpen: (sectionId: string) => void;
}) {
  const { doc } = useViewer();
  // Focus: lay out only the focused node and its direct neighbours (Ilograph-style context), not the whole map.
  const map = useMemo<DocMap>(() => {
    const full = doc.map;
    const f = focusSection ? full.nodes.find((n) => n.section === focusSection) : undefined;
    if (!f) return full;
    const keep = new Set([f.id]);
    for (const e of full.edges) {
      if (e.from === f.id) keep.add(e.to);
      if (e.to === f.id) keep.add(e.from);
    }
    const nodes = full.nodes.filter((n) => keep.has(n.id));
    return {
      groups: full.groups.filter((g) => nodes.some((n) => n.group === g.id)),
      nodes,
      edges: full.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    };
  }, [doc.map, focusSection]);
  const [both, setBoth] = useState<{ right: Layout; down: Layout } | null>(null);
  const [availW, setAvailW] = useState(0);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number; below: boolean } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    layoutBoth(map).then((l) => live && setBoth(l), (e) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  }, [map]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvailW(el.clientWidth - 16));
    ro.observe(el);
    return () => ro.disconnect();
  }, [both]);
  const lay = both && pick(both, availW || 1000, compact ? 300 : 600);

  const fileCount = useMemo(() => {
    const fs = fileSections(doc);
    const m = new Map<string, number>();
    for (const sec of fs.values()) m.set(sec, (m.get(sec) ?? 0) + 1);
    return m;
  }, [doc]);

  const planMark = (id: string): PlanMark | undefined => {
    const p = doc.planLink;
    if (!overlay || !p) return;
    if (p.done.includes(id)) return "done";
    if (p.notDone.includes(id)) return "notDone";
    if (p.deferred?.includes(id)) return "deferred";
    if (p.unplanned.includes(id)) return "unplanned";
  };

  const focusNode = focusSection ? map.nodes.find((n) => n.section === focusSection) : undefined;
  const neighbours = new Set<string>();
  if (focusNode) for (const e of map.edges) {
    if (e.from === focusNode.id) neighbours.add(e.to);
    if (e.to === focusNode.id) neighbours.add(e.from);
  }
  const dim = (id: string) => !!focusNode && id !== focusNode.id && !neighbours.has(id);

  if (err) return <div className="map-err">Map layout failed: {err}</div>;
  if (!lay) return <div className="map-loading" ref={wrap} style={{ height: compact ? 120 : 220 }} />;

  const hovered = hover && map.nodes.find((n) => n.id === hover.id);
  const hoveredSection = hovered?.section ? doc.sections.find((s) => s.id === hovered.section) : undefined;
  const missingPlanned = overlay && doc.planLink && !compact ? doc.planLink.notDone.filter((id) => !map.nodes.some((n) => n.id === id)) : [];

  const activeEdge = (e: Layout["edges"][number]) => hoverEdge === e.key || (!!hover && (e.from === hover.id || e.to === hover.id));
  const hiddenLabels = lay.edges.filter((e) => e.hidden).length;

  const showTip = (n: MapNode, el: Element) => {
    const w = wrap.current!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const below = r.top - w.top < 140;
    setHover({ id: n.id, x: r.left - w.left + r.width / 2, y: below ? r.bottom - w.top + 8 : r.top - w.top - 8, below });
  };

  return (
    <div className={cx("map", compact && "compact", focusNode && "has-focus", hover && "hovering")} ref={wrap}>
      <div className="map-scroll">
        <svg className="map-svg" width={lay.w} height={lay.h} viewBox={`0 0 ${lay.w} ${lay.h}`} role="img"
          aria-label="Change map">
          <defs>
            {["added", "changed", "removed", "unchanged", "planned", "deferred"].map((c) => (
              <marker key={c} id={`arrow-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
                orient="auto-start-reverse">
                <path d="M1,1 L9,5 L1,9 z" className={`arrowhead ech-${c}`} />
              </marker>
            ))}
          </defs>
          {lay.groups.map((g) => (
            <g key={g.id} className={cx("mgroup", focusNode && "dim-soft")}>
              <rect x={g.box.x} y={g.box.y} width={g.box.w} height={g.box.h} rx={12} />
              <text x={g.box.x + 14} y={g.box.y + 21}>{g.label.toUpperCase()}</text>
            </g>
          ))}
          {lay.edges.map((e) => {
            const ch = e.change ?? "unchanged";
            const isDim = focusNode && e.from !== focusNode.id && e.to !== focusNode.id;
            return (
              <g key={e.key} className={cx("medge", `ech-${ch}`, isDim && "dim", activeEdge(e) && "active")}
                onMouseEnter={() => setHoverEdge(e.key)} onMouseLeave={() => setHoverEdge(null)}>
                <path className="medge-hit" d={e.d} />
                <path className="medge-line" d={e.d} markerEnd={`url(#arrow-${ch})`} />
              </g>
            );
          })}
          {map.nodes.map((n) => {
            const b = lay.nodes.get(n.id);
            if (!b) return null;
            const mark = planMark(n.id);
            const clickable = !!n.section && doc.sections.some((s) => s.id === n.section);
            const isFocus = focusNode?.id === n.id;
            const textX = NODE_PAD_X + ICON_W;
            const top = b.h / 2 - ((b.lines.length - 1) * LINE_H) / 2 + 4.5;
            return (
              <g key={n.id} className={cx("mnode", `ch-${n.change}`, n.mechanical && "mech", clickable && "clickable",
                isFocus && "focus", dim(n.id) && "dim")}
                transform={`translate(${b.x},${b.y})`} tabIndex={clickable ? 0 : -1} role={clickable ? "button" : undefined}
                aria-label={`${n.label} (${CHANGE_LABEL[n.change]})`}
                onMouseEnter={(ev) => showTip(n, ev.currentTarget)} onMouseLeave={() => setHover(null)}
                onFocus={(ev) => showTip(n, ev.currentTarget)} onBlur={() => setHover(null)}
                onClick={() => clickable && onOpen(n.section!)}
                onKeyDown={(ev) => { if (clickable && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onOpen(n.section!); } }}>
                {isFocus && <rect className="focus-ring" x={-4} y={-4} width={b.w + 8} height={b.h + 8} rx={12} />}
                <rect className="mnode-box" width={b.w} height={b.h} rx={8} />
                <g transform={`translate(${NODE_PAD_X - 1},${(b.h - 16) / 2}) scale(${16 / 24})`} className="mnode-icon">
                  {iconPaths(n.kind ?? "module").map((d, i) => <path key={i} d={d} />)}
                </g>
                <text className="mnode-label" x={textX} y={top}>
                  {b.lines.map((l, i) => <tspan key={i} x={textX} dy={i === 0 ? 0 : LINE_H}>{l}</tspan>)}
                </text>
                {mark && (
                  <g className={cx("pmark", `pm-${mark}`)} transform={`translate(${b.w - 2},-2)`}>
                    <circle r={8} />
                    <path d={mark === "done" ? "M-3.5,0 L-1,2.5 L3.5,-2.5" : mark === "unplanned" ? "M-3.5,0 H3.5 M0,-3.5 V3.5" : mark === "deferred" ? "M0,-3.5 V0 L2.5,2" : "M-3,0 H3"} />
                  </g>
                )}
              </g>
            );
          })}
          {lay.edges.map((e) => {
            if (!e.label || !e.lbox) return null;
            const on = activeEdge(e);
            if (e.hidden && !on) return null;
            const isDim = focusNode && e.from !== focusNode.id && e.to !== focusNode.id;
            return (
              <g key={e.key} className={cx("medge-label", `ech-${e.change ?? "unchanged"}`, isDim && "dim", on && "active", e.hidden && "floating")}>
                <rect x={e.lbox.x} y={e.lbox.y} width={e.lbox.w} height={e.lbox.h} rx={Math.min(8.5, e.lbox.h / 2)} />
                <text x={e.lbox.x + e.lbox.w / 2} y={e.lbox.y + 2 + EDGE_LINE_H / 2 + 3.6} textAnchor="middle">
                  {(e.lines ?? [e.label]).map((l, i) => <tspan key={i} x={e.lbox!.x + e.lbox!.w / 2} dy={i === 0 ? 0 : EDGE_LINE_H}>{l}</tspan>)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {hovered && (
        <div className={cx("map-tip", hover!.below && "below")} style={{ left: hover!.x, top: hover!.y }}>
          <div className="tip-head">
            <span className={cx("dot", `ch-${hovered.change}`)} />
            <b>{hoveredSection?.title ?? hovered.label}</b>
            <span className="muted">{CHANGE_LABEL[hovered.change]}{hovered.mechanical ? " · mechanical" : ""}</span>
          </div>
          {hoveredSection?.summary && <Markdown md={hoveredSection.summary} className="tip-body" />}
          {hovered.note && <div className="tip-body muted">{hovered.note}</div>}
          <div className="tip-foot">
            {fileCount.get(hovered.section ?? "") ? <span>{plural(fileCount.get(hovered.section!)!, "file")}</span> : null}
            {planMark(hovered.id) && <span className={`pm-text pm-${planMark(hovered.id)}`}>{PLAN_LABEL[planMark(hovered.id)!]}</span>}
            {hoveredSection && !compact && <span className="muted">Click to focus</span>}
          </div>
        </div>
      )}
      {!compact && <Legend map={map} overlay={!!overlay && !!doc.planLink} hiddenLabels={hiddenLabels} deferredCount={doc.planLink?.deferred?.length ?? 0} />}
      {missingPlanned.length > 0 && (
        <div className="map-missing">
          <span className="pm-text pm-notDone">Planned, not in this change:</span> {missingPlanned.map((id) => <code key={id}>{id}</code>)}
        </div>
      )}
    </div>
  );
}

export const PLAN_LABEL: Record<PlanMark, string> = { done: "planned · done", notDone: "planned · not done", deferred: "deferred", unplanned: "unplanned" };

function Legend({ map, overlay, hiddenLabels, deferredCount }: { map: DocMap; overlay: boolean; hiddenLabels: number; deferredCount: number }) {
  const present = (["added", "changed", "removed", "planned", "deferred", "unchanged"] as const).filter((c) => map.nodes.some((n) => n.change === c));
  const mech = map.nodes.some((n) => n.mechanical);
  return (
    <div className="map-legend">
      {present.map((c) => <span key={c} className="lg"><i className={cx("sw", `ch-${c}`)} />{CHANGE_LABEL[c]}</span>)}
      {mech && <span className="lg"><i className="sw mech" />mechanical</span>}
      {overlay && (["done", "notDone", "deferred", "unplanned"] as const).filter((m) => m !== "deferred" || deferredCount > 0).map((m) => (
        <span key={m} className="lg"><i className={cx("pm-sw", `pm-${m}`)} />{PLAN_LABEL[m]}</span>
      ))}
      {hiddenLabels > 0 && <span className="lg lg-note">{plural(hiddenLabels, "edge label")} on hover</span>}
    </div>
  );
}
