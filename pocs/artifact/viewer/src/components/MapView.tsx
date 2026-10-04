import { useEffect, useMemo, useRef, useState } from "react";
import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import type { DocMap, MapNode } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { iconPaths } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { CHANGE_LABEL, cx, fileSections, plural } from "../util.ts";

const elk = new ELK();
const NODE_H = 38;
const FONT = "500 13px ui-sans-serif, system-ui, sans-serif";
const LABEL_FONT = "400 11.5px ui-sans-serif, system-ui, sans-serif";

let ctx2d: CanvasRenderingContext2D | null = null;
function textW(s: string, font: string) {
  ctx2d ??= document.createElement("canvas").getContext("2d");
  if (!ctx2d) return s.length * 7;
  ctx2d.font = font;
  return ctx2d.measureText(s).width;
}

interface Box { x: number; y: number; w: number; h: number }
interface Layout {
  w: number; h: number;
  nodes: Map<string, Box>;
  groups: { id: string; label: string; box: Box }[];
  edges: { key: string; from: string; to: string; d: string; label?: string; lbox?: Box; change?: string }[];
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

async function layout(map: DocMap): Promise<Layout> {
  const ids = new Set(map.nodes.map((n) => n.id));
  const mkNode = (n: MapNode): ElkNode => ({
    id: n.id, height: NODE_H,
    width: Math.max(120, Math.ceil(textW(n.label, FONT)) + 12 + 16 + 8 + 16),
  });
  const groupIds = new Set(map.groups.map((g) => g.id));
  const children: ElkNode[] = [
    ...map.groups.map((g) => ({
      id: `g:${g.id}`,
      layoutOptions: { "elk.padding": "[top=34,left=16,bottom=16,right=16]" },
      children: map.nodes.filter((n) => n.group === g.id).map(mkNode),
    })).filter((g) => g.children.length > 0),
    ...map.nodes.filter((n) => !n.group || !groupIds.has(n.group)).map(mkNode),
  ];
  const edges: ElkExtendedEdge[] = map.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e, i) => ({
      id: `e${i}`, sources: [e.from], targets: [e.to],
      labels: e.label ? [{ text: e.label, width: Math.ceil(textW(e.label, LABEL_FONT)) + 12, height: 18 }] : [],
    }));
  const res: ElkNode = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "30",
      "elk.layered.spacing.edgeNodeBetweenLayers": "14",
      "elk.spacing.nodeNode": "28",
      "elk.spacing.edgeNode": "16",
      "elk.spacing.edgeEdge": "12",
      "elk.spacing.edgeLabel": "4",
      "elk.edgeLabels.placement": "CENTER",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.json.edgeCoords": "ROOT",
      "elk.json.shapeCoords": "ROOT",
      "elk.padding": "[top=12,left=12,bottom=12,right=12]",
    },
    children,
    edges,
  });

  const nodes = new Map<string, Box>();
  const groups: Layout["groups"] = [];
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      const box = { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 };
      if (c.id.startsWith("g:")) {
        const g = map.groups.find((g) => `g:${g.id}` === c.id)!;
        groups.push({ id: g.id, label: g.label, box });
        walk(c);
      } else nodes.set(c.id, box);
    }
  };
  walk(res);

  const outEdges: Layout["edges"] = [];
  const collect = (n: ElkNode) => {
    for (const e of (n.edges ?? []) as ElkExtendedEdge[]) {
      const i = Number(e.id.slice(1));
      const src = map.edges.filter((x) => ids.has(x.from) && ids.has(x.to))[i];
      const s = e.sections?.[0];
      if (!s) continue;
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      const l = e.labels?.[0];
      outEdges.push({
        key: e.id, from: src.from, to: src.to, d: roundedPath(pts), label: src.label, change: src.change,
        lbox: l ? { x: l.x ?? 0, y: l.y ?? 0, w: l.width ?? 0, h: l.height ?? 0 } : undefined,
      });
    }
    (n.children ?? []).forEach(collect);
  };
  collect(res);
  return { w: res.width ?? 0, h: res.height ?? 0, nodes, groups, edges: outEdges };
}

type PlanMark = "done" | "notDone" | "unplanned";

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
  const [lay, setLay] = useState<Layout | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number; below: boolean } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    layout(map).then((l) => live && setLay(l), (e) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  }, [map]);

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
  if (!lay) return <div className="map-loading" style={{ height: compact ? 120 : 220 }} />;

  const hovered = hover && map.nodes.find((n) => n.id === hover.id);
  const hoveredSection = hovered?.section ? doc.sections.find((s) => s.id === hovered.section) : undefined;
  const missingPlanned = overlay && doc.planLink && !compact ? doc.planLink.notDone.filter((id) => !map.nodes.some((n) => n.id === id)) : [];

  const showTip = (n: MapNode, el: Element) => {
    const w = wrap.current!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const below = r.top - w.top < 140;
    setHover({ id: n.id, x: r.left - w.left + r.width / 2, y: below ? r.bottom - w.top + 8 : r.top - w.top - 8, below });
  };

  return (
    <div className={cx("map", compact && "compact", focusNode && "has-focus")} ref={wrap}>
      <div className="map-scroll">
        <svg className="map-svg" width={lay.w} height={lay.h} viewBox={`0 0 ${lay.w} ${lay.h}`} role="img"
          aria-label="Change map">
          <defs>
            {["added", "changed", "removed", "unchanged", "planned"].map((c) => (
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
              <g key={e.key} className={cx("medge", `ech-${ch}`, isDim && "dim")}>
                <path d={e.d} markerEnd={`url(#arrow-${ch})`} />
                {e.label && e.lbox && (
                  <g className="medge-label">
                    <rect x={e.lbox.x} y={e.lbox.y} width={e.lbox.w} height={e.lbox.h} rx={5} />
                    <text x={e.lbox.x + e.lbox.w / 2} y={e.lbox.y + e.lbox.h / 2 + 4} textAnchor="middle">{e.label}</text>
                  </g>
                )}
              </g>
            );
          })}
          {map.nodes.map((n) => {
            const b = lay.nodes.get(n.id);
            if (!b) return null;
            const mark = planMark(n.id);
            const clickable = !!n.section && doc.sections.some((s) => s.id === n.section);
            const isFocus = focusNode?.id === n.id;
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
                <rect className="mnode-box" width={b.w} height={b.h} rx={9} />
                <g transform={`translate(12,${(b.h - 16) / 2}) scale(${16 / 24})`} className="mnode-icon">
                  {iconPaths(n.kind ?? "module").map((d, i) => <path key={i} d={d} />)}
                </g>
                <text className="mnode-label" x={36} y={b.h / 2 + 4.5}>{n.label}</text>
                {mark && (
                  <g className={cx("pmark", `pm-${mark}`)} transform={`translate(${b.w - 2},-2)`}>
                    <circle r={8} />
                    <path d={mark === "done" ? "M-3.5,0 L-1,2.5 L3.5,-2.5" : mark === "unplanned" ? "M-3.5,0 H3.5 M0,-3.5 V3.5" : "M-3,0 H3"} />
                  </g>
                )}
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
      {!compact && <Legend map={map} overlay={!!overlay && !!doc.planLink} />}
      {missingPlanned.length > 0 && (
        <div className="map-missing">
          <span className="pm-text pm-notDone">Planned, not in this change:</span> {missingPlanned.map((id) => <code key={id}>{id}</code>)}
        </div>
      )}
    </div>
  );
}

export const PLAN_LABEL: Record<PlanMark, string> = { done: "planned · done", notDone: "planned · not done", unplanned: "unplanned" };

function Legend({ map, overlay }: { map: DocMap; overlay: boolean }) {
  const present = (["added", "changed", "removed", "planned", "unchanged"] as const).filter((c) => map.nodes.some((n) => n.change === c));
  const mech = map.nodes.some((n) => n.mechanical);
  return (
    <div className="map-legend">
      {present.map((c) => <span key={c} className="lg"><i className={cx("sw", `ch-${c}`)} />{CHANGE_LABEL[c]}</span>)}
      {mech && <span className="lg"><i className="sw mech" />mechanical</span>}
      {overlay && (["done", "notDone", "unplanned"] as const).map((m) => (
        <span key={m} className="lg"><i className={cx("pm-sw", `pm-${m}`)} />{PLAN_LABEL[m]}</span>
      ))}
    </div>
  );
}
