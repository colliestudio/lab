import { useMemo, useState, type ReactNode } from "react";
import { ZoomImg } from "./zoom.tsx";
import { cx, niceTicks } from "./util.ts";

type Row = Record<string, unknown>;
export interface Column<R = Row> {
  key: string; label?: ReactNode; render?: (v: unknown, row: R, i: number) => ReactNode;
  align?: "left" | "right" | "center"; sort?: boolean | ((a: R, b: R) => number); width?: string;
}

const cmp = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });

/** Sortable table. `columns` are keys or {key,label,render,align,sort}; a row with `href` links its first cell. */
export function Table<R extends Row = Row>({ columns, rows, sortable = true, dense, id, initialSort }: {
  columns: (string | Column<R>)[]; rows: R[]; sortable?: boolean; dense?: boolean; id?: string; initialSort?: { key: string; desc?: boolean };
}) {
  const cols: Column<R>[] = columns.map((c) => (typeof c === "string" ? { key: c, label: c.replace(/[-_]/g, " ") } : { label: c.key.replace(/[-_]/g, " "), ...c }));
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(initialSort ? { key: initialSort.key, desc: !!initialSort.desc } : null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const c = cols.find((c) => c.key === sort.key);
    const f = typeof c?.sort === "function" ? c.sort : (a: R, b: R) => cmp(a[sort.key], b[sort.key]);
    return [...rows].sort((a, b) => (sort.desc ? -f(a, b) : f(a, b)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  return (
    <div className="a-table-wrap" data-c="table" data-aid={id}>
      <table className={cx("a-table", dense && "dense")}>
        <thead><tr>{cols.map((c) => {
          const can = sortable && c.sort !== false;
          const on = sort?.key === c.key;
          return (
            <th key={c.key} style={{ textAlign: c.align, width: c.width }} aria-sort={on ? (sort!.desc ? "descending" : "ascending") : undefined}>
              {can ? <button onClick={() => setSort(on && sort!.desc ? null : { key: c.key, desc: on })}>{c.label}<span aria-hidden>{on ? (sort!.desc ? " ↓" : " ↑") : ""}</span></button> : c.label}
            </th>
          );
        })}</tr></thead>
        <tbody>{sorted.map((r, i) => (
          <tr key={i}>{cols.map((c, j) => {
            const v = r[c.key];
            const cell: ReactNode = c.render ? c.render(v, r, i) : (v as ReactNode);
            const href = typeof r.href === "string" ? r.href : undefined;
            return <td key={c.key} style={{ textAlign: c.align }}>{j === 0 && href ? <a href={href} target="_blank" rel="noreferrer">{cell}</a> : cell}</td>;
          })}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** An image from evidence (inlined at build), a data URL or an http URL. */
export function Img({ src, alt = "", caption, id, fit, height, thumb, zoom = true }: {
  src: string; alt?: string; caption?: ReactNode; id?: string;
  /** "cover" crops to fill `height` (top-aligned), "contain" shows it whole inside `height`. `thumb` = cover at 16:9, no lightbox. */
  fit?: "cover" | "contain"; height?: number | string; thumb?: boolean; zoom?: boolean;
}) {
  const f = thumb ? "cover" : fit;
  const style: React.CSSProperties | undefined = f ? { width: "100%", objectFit: f, objectPosition: "center top", ...(thumb ? { aspectRatio: "16 / 9" } : { height }) } : undefined;
  return (
    <figure className="a-figure" data-c="figure" data-aid={id}>
      <ZoomImg src={src} alt={alt} style={style} zoom={zoom && !thumb} />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

export interface CompareItem { label?: ReactNode; src?: string; node?: ReactNode; caption?: ReactNode }
/** N things side by side with captions: screenshots, before/after, variants. Each item has `src` (image) or `node` (anything). */
export function Compare({ items, id, caption }: { items: CompareItem[]; id?: string; caption?: ReactNode }) {
  return (
    <div data-c="compare" data-aid={id}>
    <div className="a-compare" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((it, i) => (
        <figure key={i} className="a-figure">
          {it.label != null && <div className="a-compare-label">{it.label}</div>}
          <div className="a-compare-body">{it.src ? <ZoomImg src={it.src} alt={typeof it.label === "string" ? it.label : ""} /> : it.node}</div>
          {it.caption && <figcaption>{it.caption}</figcaption>}
        </figure>
      ))}
    </div>
    {caption && <div className="a-muted">{caption}</div>}
    </div>
  );
}

const PAL = ["var(--collie-color-accent-solid)", "var(--collie-color-success-solid)", "var(--collie-color-warning-solid)", "var(--collie-color-critical-solid)", "var(--collie-color-neutral-solid)"];

/**
 * Small SVG chart. `data` = [{label, value}] for one series (bars by default) or `series` = [{name, points:[{label,value}]}]
 * with kind="line". No axes library: a baseline, gridlines and value labels.
 */
export function Chart({ data, series, kind = "bar", height = 180, unit = "", id, caption }: {
  data?: { label: string; value: number }[]; series?: { name: string; points: { label: string; value: number }[] }[];
  kind?: "bar" | "line"; height?: number; unit?: string; id?: string; caption?: ReactNode;
}) {
  const ss = series ?? [{ name: "", points: data ?? [] }];
  const labels = ss[0]?.points.map((p) => p.label) ?? [];
  const { ticks, max } = niceTicks(Math.max(0, ...ss.flatMap((s) => s.points.map((p) => p.value))));
  const fmt = (t: number) => `${t}${unit}`;
  const padL = Math.ceil(Math.max(...ticks.map((t) => fmt(t).length)) * 6.4) + 14, padB = 22, padT = 14, H = height;
  const W = Math.max(480, padL + labels.length * 64 + 8);
  const iw = W - padL - 8, ih = H - padB - padT;
  const x = (i: number) => padL + (iw / labels.length) * (i + 0.5);
  const y = (v: number) => padT + ih - (v / max) * ih;
  const bw = Math.min(36, (iw / labels.length) * 0.6 / ss.length);
  return (
    <figure className="a-chart" data-c="chart" data-aid={id}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W * 1.5 }} role="img" aria-label={ss.map((s) => s.name).join(", ") || "chart"}>
        {ticks.map((t) => <g key={t}><line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} className="grid" /><text x={padL - 6} y={y(t) + 4} textAnchor="end">{fmt(t)}</text></g>)}
        {labels.map((l, i) => <text key={i} x={x(i)} y={H - 6} textAnchor="middle">{l}</text>)}
        {ss.map((s, si) => kind === "line" ? (
          <g key={si} style={{ color: PAL[si % PAL.length] }}>
            <polyline fill="none" stroke="currentColor" strokeWidth="2" points={s.points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} />
            {s.points.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.value)} r="3" fill="currentColor"><title>{`${p.label}: ${p.value}${unit}`}</title></circle>)}
          </g>
        ) : (
          <g key={si} style={{ color: PAL[si % PAL.length] }}>
            {s.points.map((p, i) => (
              <rect key={i} x={x(i) - (bw * ss.length) / 2 + si * bw} y={y(p.value)} width={bw - 2} height={padT + ih - y(p.value)} rx="3" fill="currentColor">
                <title>{`${p.label}: ${p.value}${unit}`}</title>
              </rect>
            ))}
          </g>
        ))}
      </svg>
      {series && series.length > 1 && <div className="a-legend">{series.map((s, i) => <span key={i}><i style={{ background: PAL[i % PAL.length] }} />{s.name}</span>)}</div>}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
