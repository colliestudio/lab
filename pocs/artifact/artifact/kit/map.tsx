import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { approxMeasure, FONT, layoutMap, LINE_H, NODE_PAD_X, ICON_W, EDGE_LINE_H, type DocMap, type Layout, type Measure } from "./map-layout.ts";
import { cx } from "./util.ts";
import { Status } from "./layout.tsx";
import { usePresent } from "./present.ts";

let ctx2d: CanvasRenderingContext2D | null = null;
const measure: Measure = (s, font) => {
  if (typeof document === "undefined") return approxMeasure(s, font);
  ctx2d ??= document.createElement("canvas").getContext("2d");
  if (!ctx2d) return approxMeasure(s, font);
  ctx2d.font = font;
  return ctx2d.measureText(s).width;
};

export interface MapNodeIn { id: string; label: string; group?: string; state?: string; note?: ReactNode; detail?: ReactNode; href?: string; section?: string }
export interface MapEdgeIn { from: string; to: string; label?: string; state?: string }

const stateClass = (s?: string) => (s ? `st-${s.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : "");

/**
 * Boxes and arrows laid out automatically (ELK). Click a node to focus it and its neighbours; its `note`/`detail`/`href`
 * show below. `state` colours a node or edge (ok, done, warn, blocked, todo, new, changed… any word works, unknown = neutral).
 */
export function Map({ nodes, edges = [], groups = [], direction = "auto", focus, id, height = 560 }: {
  nodes: MapNodeIn[]; edges?: MapEdgeIn[]; groups?: { id: string; label: string }[]; direction?: "auto" | "right" | "down";
  focus?: string; id?: string; height?: number;
}) {
  const map = useMemo<DocMap>(() => ({ groups, nodes, edges }), [nodes, edges, groups]);
  const [both, setBoth] = useState<{ right: Layout; down: Layout } | null>(null);
  const [w, setW] = useState(0);
  const [sel, setSel] = useState<string | null>(focus ?? null);
  const [err, setErr] = useState<string>();
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const present = usePresent();
  const [vh, setVh] = useState(typeof innerHeight === "number" ? innerHeight : 800);
  useEffect(() => { const f = () => setVh(innerHeight); addEventListener("resize", f); return () => removeEventListener("resize", f); }, []);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    Promise.all([layoutMap(map, "RIGHT", measure), layoutMap(map, "DOWN", measure)])
      .then(([right, down]) => live && setBoth({ right, down }), (e) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  }, [map]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth - 8));
    ro.observe(el);
    return () => ro.disconnect();
  }, [both]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);

  const panStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if ((e.target as Element).closest(".mnode") || el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    const sx = e.clientX, sy = e.clientY, sl = el.scrollLeft, st = el.scrollTop;
    const move = (m: PointerEvent) => { el.scrollLeft = sl - (m.clientX - sx); el.scrollTop = st - (m.clientY - sy); };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  if (err) return <div className="a-map-err">Map layout failed: {err}</div>;
  if (!both) return <div className="a-map" ref={wrap} style={{ height: 160 }} data-c="map" data-aid={id} />;
  const maxH = Math.min(present.active ? vh * 0.62 : height, vh * 0.8);
  const scale = (l: Layout) => Math.min((w || 900) / l.w, maxH / l.h, 1);
  const lay = direction === "right" ? both.right : direction === "down" ? both.down
    : scale(both.right) < 0.85 && scale(both.down) > scale(both.right) + 0.1 ? both.down : both.right;

  const fit = scale(lay);
  const z = zoom === "fit" ? fit : zoom;
  const nbr = new Set<string>();
  if (sel) for (const e of edges) { if (e.from === sel) nbr.add(e.to); if (e.to === sel) nbr.add(e.from); }
  const dim = (nid: string) => !!sel && nid !== sel && !nbr.has(nid);
  const cur = sel ? nodes.find((n) => n.id === sel) : undefined;
  const states = [...new Set(nodes.map((n) => n.state).filter((x): x is string => !!x))];

  return (
    <div className={cx("a-map", sel && "has-focus")} ref={wrap} data-c="map" data-aid={id}>
      <div className="a-map-tools" onClick={(e) => e.stopPropagation()}>
        <span className="a-muted">{Math.round(z * 100)}%</span>
        <button onClick={() => setZoom("fit")} aria-pressed={zoom === "fit"} title="Fit to the column">Fit</button>
        <button onClick={() => setZoom(1)} aria-pressed={zoom === 1} title="Actual size (scroll or drag to pan)">100%</button>
        <button onClick={() => setZoom(Math.min(3, z * 1.25))} aria-label="Zoom in">+</button>
        <button onClick={() => setZoom(Math.max(0.2, z / 1.25))} aria-label="Zoom out">−</button>
      </div>
      <div className={cx("a-map-scroll", z > fit + 0.01 && "pan")} onClick={() => setSel(null)} onPointerDown={panStart}>
        <svg width={Math.ceil(lay.w * z)} height={Math.ceil(lay.h * z)} viewBox={`0 0 ${lay.w} ${lay.h}`} role="img" aria-label="Map">
          <defs><marker id="a-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 z" className="arrowhead" /></marker></defs>
          {lay.groups.map((g) => (
            <g key={g.id} className={cx("mgroup", sel && "dim-soft")}>
              <rect x={g.box.x} y={g.box.y} width={g.box.w} height={g.box.h} rx={12} />
              <text x={g.box.x + 14} y={g.box.y + 21}>{g.label.toUpperCase()}</text>
            </g>
          ))}
          {lay.edges.map((e) => (
            <path key={e.key} className={cx("medge", stateClass(e.state), sel && e.from !== sel && e.to !== sel && "dim")} d={e.d}
              markerEnd="url(#a-arrow)" markerStart={e.both ? "url(#a-arrow)" : undefined} />
          ))}
          {nodes.map((n) => {
            const b = lay.nodes.get(n.id);
            if (!b) return null;
            const top = b.h / 2 - ((b.lines.length - 1) * LINE_H) / 2 + 4.5;
            const tx = NODE_PAD_X + ICON_W;
            return (
              <g key={n.id} className={cx("mnode", stateClass(n.state), n.id === sel && "focus", dim(n.id) && "dim")} transform={`translate(${b.x},${b.y})`}
                tabIndex={0} role="button" aria-label={n.label} aria-pressed={n.id === sel}
                onClick={(ev) => { ev.stopPropagation(); setSel(n.id === sel ? null : n.id); }}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSel(n.id === sel ? null : n.id); } }}>
                <rect className="mnode-box" width={b.w} height={b.h} rx={8} />
                <circle className="mnode-dot" cx={NODE_PAD_X + 2} cy={b.h / 2} r={4} />
                <text className="mnode-label" x={tx} y={top} style={{ font: FONT }}>
                  {b.lines.map((l, i) => <tspan key={i} x={tx} dy={i === 0 ? 0 : LINE_H}>{l}</tspan>)}
                </text>
              </g>
            );
          })}
          {lay.edges.map((e) => e.label && e.lbox ? (
            <g key={e.key} className={cx("medge-label", sel && e.from !== sel && e.to !== sel && "dim")}>
              <rect x={e.lbox.x} y={e.lbox.y} width={e.lbox.w} height={e.lbox.h} rx={Math.min(8.5, e.lbox.h / 2)} />
              <text x={e.lbox.x + e.lbox.w / 2} y={e.lbox.y + 2 + EDGE_LINE_H / 2 + 3.6} textAnchor="middle">
                {(e.lines ?? [e.label]).map((l, i) => <tspan key={i} x={e.lbox!.x + e.lbox!.w / 2} dy={i === 0 ? 0 : EDGE_LINE_H}>{l}</tspan>)}
              </text>
            </g>
          ) : null)}
        </svg>
      </div>
      {cur && (
        <div className="a-map-detail">
          <div><b>{cur.label}</b> {cur.state && <Status s={cur.state} />} {cur.section && <a href={`#${cur.section}`}>go to section ↓</a>} {cur.href && <a href={cur.href} target="_blank" rel="noreferrer">open ↗</a>}</div>
          {(cur.note || cur.detail) && <div className="a-muted">{cur.detail ?? cur.note}</div>}
          {nbr.size > 0 && <div className="a-muted">Connected: {[...nbr].map((x) => nodes.find((n) => n.id === x)?.label ?? x).join(", ")}</div>}
        </div>
      )}
      {zoom === "fit" && fit < 0.6 && <div className="a-muted a-map-hint">Scaled to {Math.round(fit * 100)}% to fit; use + or 100% and drag to read details.</div>}
      {states.length > 0 && <div className="a-legend">{states.map((s) => <Status key={s} s={s} />)}</div>}
    </div>
  );
}
