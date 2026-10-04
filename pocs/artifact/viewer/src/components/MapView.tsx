import { useEffect, useMemo, useRef, useState } from "react";
import { layoutMap, EDGE_LINE_H, ICON_W, LINE_H, NODE_PAD_X, type Layout, type Measure } from "../map-layout.ts";
import type { DocMap, MapNode } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { iconPaths } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { CHANGE_LABEL, cx, fileSections, plural } from "../util.ts";

let ctx2d: CanvasRenderingContext2D | null = null;
const measure: Measure = (s, font) => {
  ctx2d ??= document.createElement("canvas").getContext("2d");
  if (!ctx2d) return s.length * 7;
  ctx2d.font = font;
  return ctx2d.measureText(s).width;
};

/** Lays the map out both ways; the viewer shows whichever fits its box at the larger scale (ties go left-to-right). */
async function layoutBoth(map: DocMap) {
  const [right, down] = await Promise.all([layoutMap(map, "RIGHT", measure), layoutMap(map, "DOWN", measure)]);
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
                <path className="medge-line" d={e.d} markerEnd={`url(#arrow-${ch})`} markerStart={e.both ? `url(#arrow-${ch})` : undefined} />
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
            const isDim = focusNode && e.from !== focusNode.id && e.to !== focusNode.id;
            return (
              <g key={e.key} className={cx("medge-label", `ech-${e.change ?? "unchanged"}`, isDim && "dim", on && "active")}>
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
      {!compact && <Legend map={map} overlay={!!overlay && !!doc.planLink} deferredCount={doc.planLink?.deferred?.length ?? 0} />}
      {missingPlanned.length > 0 && (
        <div className="map-missing">
          <span className="pm-text pm-notDone">Planned, not in this change:</span> {missingPlanned.map((id) => <code key={id}>{id}</code>)}
        </div>
      )}
    </div>
  );
}

export const PLAN_LABEL: Record<PlanMark, string> = { done: "planned · done", notDone: "planned · not done", deferred: "deferred", unplanned: "unplanned" };

function Legend({ map, overlay, deferredCount }: { map: DocMap; overlay: boolean; deferredCount: number }) {
  const present = (["added", "changed", "removed", "planned", "deferred", "unchanged"] as const).filter((c) => map.nodes.some((n) => n.change === c));
  const mech = map.nodes.some((n) => n.mechanical);
  return (
    <div className="map-legend">
      {present.map((c) => <span key={c} className="lg"><i className={cx("sw", `ch-${c}`)} />{CHANGE_LABEL[c]}</span>)}
      {mech && <span className="lg"><i className="sw mech" />mechanical</span>}
      {overlay && (["done", "notDone", "deferred", "unplanned"] as const).filter((m) => m !== "deferred" || deferredCount > 0).map((m) => (
        <span key={m} className="lg"><i className={cx("pm-sw", `pm-${m}`)} />{PLAN_LABEL[m]}</span>
      ))}
    </div>
  );
}
