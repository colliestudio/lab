import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Source, Status, type SourceProps, type Tone } from "./layout.tsx";
import { imageSrc } from "./registry.ts";
import { usePresent } from "./present.ts";
import { cx } from "./util.ts";

export type Grade = "best" | "ok" | "weak" | "bad" | "na";
const GRADE_LABEL: Record<Grade, string> = { best: "best", ok: "ok", weak: "weak", bad: "bad", na: "n/a" };
type Cell = string | { grade?: Grade; text?: ReactNode };

/**
 * Options × criteria with a tone per cell and a recommended column.
 * `options={["A","B"]}`, `rows={[{name:"Cost", weight:"high", cells:[{grade:"best", text:"$0"}, {grade:"weak", text:"$$"}]}]}`,
 * `recommend={0}` (index or option name), `verdict={["Pick", "Skip"]}` adds a last row.
 */
export function Scorecard({ options, rows, recommend, verdict, id }: {
  options: (string | { name: string; sub?: ReactNode })[];
  rows: { name: ReactNode; weight?: ReactNode; cells: Cell[] }[];
  recommend?: number | string; verdict?: ReactNode[]; id?: string;
}) {
  const opts = options.map((o) => (typeof o === "string" ? { name: o } : o) as { name: string; sub?: ReactNode });
  const rec = typeof recommend === "string" ? opts.findIndex((o) => o.name === recommend) : recommend ?? -1;
  const cellOf = (c: Cell) => (typeof c === "string" ? { text: c } : c);
  return (
    <div className="a-table-wrap" data-c="scorecard" data-aid={id}>
      <table className="a-table a-score">
        <thead><tr>
          <th />
          {opts.map((o, i) => (
            <th key={i} className={cx(i === rec && "rec")}>
              {o.name}{o.sub && <div className="a-muted">{o.sub}</div>}{i === rec && <div><Badge tone="success">recommended</Badge></div>}
            </th>
          ))}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <th scope="row">{r.name}{r.weight != null && <div className="a-muted">weight: {r.weight}</div>}</th>
              {opts.map((_, j) => {
                const c = cellOf(r.cells[j] ?? "");
                return <td key={j} className={cx(`g-${c.grade ?? "plain"}`, j === rec && "rec")}>{c.grade && <span className="g-dot" title={GRADE_LABEL[c.grade]} />}{c.text}</td>;
              })}
            </tr>
          ))}
          {verdict && (
            <tr className="verdict"><th scope="row">Verdict</th>{opts.map((_, j) => <td key={j} className={cx(j === rec && "rec")}>{verdict[j]}</td>)}</tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
export const Matrix = Scorecard;

/** Key/value rows for a card or section: `items={[["main", "ok"], ["board", <Status s="doing" />]]}`. */
export function Facts({ items }: { items: ([ReactNode, ReactNode] | { k: ReactNode; v: ReactNode })[] }) {
  return (
    <dl className="a-facts" data-c="facts">
      {items.map((it, i) => {
        const [k, v] = Array.isArray(it) ? it : [it.k, it.v];
        return <div key={i}><dt>{k}</dt><dd>{v}</dd></div>;
      })}
    </dl>
  );
}

export interface ActionItem {
  title: ReactNode; why?: ReactNode; effort?: ReactNode; rec?: ReactNode; owner?: string; tone?: Tone; status?: string;
  sources?: SourceProps[]; id?: string;
}
/** A ranked "do these first" list: rank, what, why now, effort, recommendation, sources. */
export function Actions({ items }: { items: ActionItem[] }) {
  return (
    <ol className="a-actions" data-c="actions">
      {items.map((a, i) => (
        <li key={a.id ?? i} id={a.id} data-aid={a.id} className={cx(a.tone && `tone-${a.tone}`)}>
          <span className="a-rank">{i + 1}</span>
          <div className="a-action-body">
            <div className="a-action-head"><b>{a.title}</b>{a.status && <Status s={a.status} />}{a.owner && <Badge tone="warn">{a.owner}</Badge>}{a.effort != null && <Badge title="effort">{a.effort}</Badge>}</div>
            {a.why && <div className="a-muted"><b>Why now:</b> {a.why}</div>}
            {a.rec && <div className="a-action-rec"><b>Recommend:</b> {a.rec}</div>}
            {a.sources && a.sources.length > 0 && <div className="a-action-src">{a.sources.map((s, j) => <Source key={j} inline {...s} />)}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

const LV = { low: 1, med: 2, medium: 2, high: 3 } as const;
const lv = (v: number | string) => (typeof v === "number" ? v : LV[v.toLowerCase() as keyof typeof LV] ?? 2);
export interface Risk { id: string; title: ReactNode; like: number | "low" | "med" | "high"; impact: number | "low" | "med" | "high"; mitigation?: ReactNode; owner?: string }
/** Likelihood × impact grid with chips linking to the rows of the table below. */
export function RiskMatrix({ risks }: { risks: Risk[] }) {
  const cell = (l: number, i: number) => risks.filter((r) => lv(r.like) === l && lv(r.impact) === i);
  const sev = (l: number, i: number) => (l * i >= 6 ? "critical" : l * i >= 3 ? "warn" : "ok");
  const names = ["", "low", "medium", "high"];
  return (
    <div className="a-risk" data-c="riskmatrix">
      <div className="a-risk-grid" role="img" aria-label="Risk matrix">
        <div className="a-risk-y">likelihood</div>
        {[3, 2, 1].map((l) => (
          <div className="a-risk-row" key={l}>
            <span className="a-risk-lab">{names[l]}</span>
            {[1, 2, 3].map((i) => (
              <div key={i} className={cx("a-risk-cell", `sev-${sev(l, i)}`)}>
                {cell(l, i).map((r) => <a key={r.id} href={`#risk-${r.id}`} className="a-risk-chip" title={typeof r.title === "string" ? r.title : r.id}>{r.id}</a>)}
              </div>
            ))}
          </div>
        ))}
        <div className="a-risk-row a-risk-x"><span className="a-risk-lab" />{[1, 2, 3].map((i) => <span key={i} className="a-risk-lab">{names[i]}</span>)}</div>
        <div className="a-risk-xt">impact</div>
      </div>
      <div className="a-table-wrap"><table className="a-table dense"><thead><tr><th>Risk</th><th>Likelihood</th><th>Impact</th><th>Mitigation</th></tr></thead>
        <tbody>{risks.map((r) => (
          <tr key={r.id} id={`risk-${r.id}`}><td><b>{r.id}</b> {r.title}{r.owner && <> <Badge tone="warn">{r.owner}</Badge></>}</td><td>{names[lv(r.like)]}</td><td>{names[lv(r.impact)]}</td><td>{r.mitigation}</td></tr>
        ))}</tbody></table></div>
    </div>
  );
}

/** One variant at a time with a detail pane; follows present steps (each item is a step). `items={[{label, src | node, aside, caption}]}` */
export function Gallery({ items, id }: { items: { label: ReactNode; src?: string; node?: ReactNode; aside?: ReactNode; caption?: ReactNode }[]; id?: string }) {
  const [i, setI] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const present = usePresent();
  useEffect(() => {
    if (!present.active || !root.current) return;
    setI(Math.min(items.length - 1, root.current.querySelectorAll("[data-step]:not([data-present-hidden])").length));
  }, [present.active, present.step, present.slide, items.length]);
  const cur = items[Math.min(i, items.length - 1)];
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setI((i + 1) % items.length); else if (e.key === "ArrowLeft") setI((i - 1 + items.length) % items.length);
  };
  return (
    <div className="a-gallery" ref={root} data-c="gallery" data-aid={id}>
      <div className="a-pills" role="tablist" onKeyDown={present.active ? undefined : key}>
        {items.map((it, n) => <button key={n} role="tab" aria-selected={n === i} tabIndex={n === i ? 0 : -1} onClick={() => setI(n)}>{it.label}</button>)}
      </div>
      <div className="a-gallery-body">
        <div className="a-gallery-main">{cur.src ? <img src={imageSrc(cur.src)} alt="" /> : cur.node}{cur.caption && <div className="a-muted">{cur.caption}</div>}</div>
        {cur.aside && <div className="a-gallery-aside">{cur.aside}</div>}
      </div>
      {items.slice(1).map((_, n) => <span key={n} data-step hidden />)}
    </div>
  );
}

/** The decisions on this page, with their recommendation, linking to each `<Decision>`. */
export function DecisionIndex({ title = "Decisions on this page" }: { title?: ReactNode }) {
  const [list, setList] = useState<{ id: string; q: string; rec?: string; owner?: string }[]>([]);
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>('[data-c="decision"]')];
    els.forEach((e, n) => { if (!e.id) e.id = `decision-${n + 1}`; });
    setList(els.map((e) => ({ id: e.id, q: e.dataset.q ?? "", rec: e.dataset.rec || undefined, owner: e.dataset.owner })));
  }, []);
  if (!list.length) return null;
  return (
    <div className="a-questions" data-c="decisions-index">
      <div className="a-questions-title">{title}</div>
      <ol>{list.map((d) => (
        <li key={d.id}><a href={`#${d.id}`}><b>{d.q}</b></a>{d.rec && <span className="a-muted"> → {d.rec}</span>}{d.owner && <> <Badge tone="warn">{d.owner}</Badge></>}</li>
      ))}</ol>
    </div>
  );
}
