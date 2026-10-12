import { Children, Fragment, createContext, isValidElement, useContext, useState, type CSSProperties, type ReactNode } from "react";
import { ageOf, cx, slug } from "./util.ts";

export type Tone = "neutral" | "info" | "success" | "warn" | "critical" | "accent";

const LevelCtx = createContext(1);

/** Optional width wrapper; the host already wraps every artifact in one. */
export function Page({ children, width = "normal" }: { children: ReactNode; width?: "narrow" | "normal" | "wide" | "full" }) {
  return <div className="a-page" data-width={width}>{children}</div>;
}

/**
 * Something heavy (diff, code, big table, recording, diagram) that collapses to a one-line stub at detail levels 1-2;
 * click the stub to open it. Used by the kit's own heavy components.
 */
export function Heavy({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <div className="a-heavy">
      <button className="a-heavy-stub" onClick={(e) => e.currentTarget.parentElement?.toggleAttribute("data-open")}>
        <span className="show">▸ {label}</span><span className="hide">▾ {label}</span>
      </button>
      <div className="a-heavy-body">{children}</div>
    </div>
  );
}

/** A titled part of the page. Feeds the outline and present mode; nest Sections for sub-headings. */
export function Section({ id, title, children, lead }: { id?: string; title: ReactNode; children?: ReactNode; lead?: ReactNode }) {
  const level = useContext(LevelCtx);
  const text = typeof title === "string" ? title : "";
  const sid = id ?? (slug(text) || "section");
  const H = (`h${Math.min(level + 1, 5)}`) as "h2";
  return (
    <LevelCtx.Provider value={level + 1}>
      <section id={sid} className="a-section" data-section={sid} data-title={text || sid} data-level={level}>
        <H className="a-h"><a href={`#${sid}`}>{title}</a></H>
        {lead && <p className="a-lead">{lead}</p>}
        <button className="a-sec-more" onClick={(e) => e.currentTarget.closest("section")?.toggleAttribute("data-open")}>
          <span className="show">▸ Show {Children.count(children)} hidden</span><span className="hide">▾ Hide</span>
        </button>
        <div className="a-section-body">{children}</div>
      </section>
    </LevelCtx.Provider>
  );
}

export function Stack({ children, row, gap = 3, align, wrap, id }: {
  children?: ReactNode; row?: boolean; gap?: number; align?: CSSProperties["alignItems"]; wrap?: boolean; id?: string;
}) {
  return <div data-aid={id} className="a-stack" style={{ flexDirection: row ? "row" : "column", gap: `calc(var(--collie-space-50) * ${gap})`, alignItems: align, flexWrap: wrap ? "wrap" : undefined }}>{children}</div>;
}

/** `cols` fixed columns, or as many as fit `min` wide. */
export function Grid({ children, cols, min = "16rem", gap = 3 }: { children?: ReactNode; cols?: number; min?: string; gap?: number }) {
  return <div className="a-grid" style={{
    gridTemplateColumns: cols ? `repeat(${cols}, minmax(0, 1fr))` : `repeat(auto-fit, minmax(min(${min}, 100%), 1fr))`,
    gap: `calc(var(--collie-space-50) * ${gap})`,
  }}>{children}</div>;
}

export function Card({ title, children, tone, href, footer, id, aside }: {
  title?: ReactNode; children?: ReactNode; tone?: Tone; href?: string; footer?: ReactNode; id?: string; aside?: ReactNode;
}) {
  const head = title != null && (
    <div className="a-card-head"><b>{href ? <a href={href} target="_blank" rel="noreferrer">{title}</a> : title}</b>{aside}</div>
  );
  return (
    <div className={cx("a-card", tone && `tone-${tone}`)} data-c="card" data-aid={id}>
      {head}
      {children != null && <div className="a-card-body">{children}</div>}
      {footer && <div className="a-card-foot">{footer}</div>}
    </div>
  );
}

/** Cards from data: `items={[{title, body, status?, href?}]}`. */
export function CardGrid({ items, min, cols }: {
  items: { title: ReactNode; body?: ReactNode; status?: StatusValue; href?: string; tone?: Tone; footer?: ReactNode; id?: string }[];
  min?: string; cols?: number;
}) {
  return <Grid min={min} cols={cols}>{items.map((it, i) => (
    <Card key={it.id ?? i} id={it.id} title={it.title} href={it.href} tone={it.tone} footer={it.footer}
      aside={it.status ? <Status s={it.status} /> : undefined}>{it.body}</Card>
  ))}</Grid>;
}

/** Columns side by side (status lanes, owners, stages): `lanes={[{title, count?, children}]}`. */
export function Lanes({ lanes, min = "15rem" }: { lanes: { title: ReactNode; tone?: Tone; children?: ReactNode; id?: string }[]; min?: string }) {
  return (
    <div className="a-lanes" style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(${min}, 1fr))` }}>
      {lanes.map((l, i) => (
        <div key={l.id ?? i} className={cx("a-lane", l.tone && `tone-${l.tone}`)} data-c="lane" data-aid={l.id}>
          <div className="a-lane-head">{l.title}</div>
          <div className="a-lane-body">{l.children}</div>
        </div>
      ))}
    </div>
  );
}

export function Callout({ children, tone = "info", title, id }: { children?: ReactNode; tone?: Tone; title?: ReactNode; id?: string }) {
  return (
    <aside className={cx("a-callout", `tone-${tone}`)} data-c="callout" data-aid={id} role="note">
      {title && <div className="a-callout-title">{title}</div>}
      <div>{children}</div>
    </aside>
  );
}

export function Badge({ children, tone = "neutral", title }: { children?: ReactNode; tone?: Tone; title?: string }) {
  return <span className={cx("a-badge", `tone-${tone}`)} title={title}>{children}</span>;
}

const STATUS: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: "success", label: "OK" }, done: { tone: "success", label: "Done" }, merged: { tone: "accent", label: "Merged" },
  passing: { tone: "success", label: "Passing" }, green: { tone: "success", label: "Green" },
  warn: { tone: "warn", label: "Warning" }, risk: { tone: "warn", label: "At risk" }, "at-risk": { tone: "warn", label: "At risk" },
  stale: { tone: "warn", label: "Stale" }, waiting: { tone: "warn", label: "Waiting" },
  blocked: { tone: "critical", label: "Blocked" }, failed: { tone: "critical", label: "Failed" }, failing: { tone: "critical", label: "Failing" },
  error: { tone: "critical", label: "Error" }, red: { tone: "critical", label: "Red" },
  todo: { tone: "neutral", label: "To do" }, open: { tone: "neutral", label: "Open" }, planned: { tone: "neutral", label: "Planned" },
  draft: { tone: "neutral", label: "Draft" }, closed: { tone: "neutral", label: "Closed" },
  doing: { tone: "accent", label: "In progress" }, "in-progress": { tone: "accent", label: "In progress" },
  review: { tone: "accent", label: "In review" }, info: { tone: "info", label: "Info" }, new: { tone: "accent", label: "New" },
};
/** A state pill: ok, done, merged, warn, risk, stale, blocked, failed, todo, open, planned, doing, review, info… (unknown words show as is). */
export type StatusValue = string | { label: ReactNode; tone?: Tone };
export function Status({ s, label, children }: { s: StatusValue; label?: ReactNode; children?: ReactNode }) {
  if (s && typeof s === "object") return <span className={cx("a-status custom", `tone-${s.tone ?? "neutral"}`)}><i />{children ?? s.label}</span>;
  const d = STATUS[String(s ?? "").toLowerCase()] ?? { tone: "neutral" as Tone, label: String(s ?? "") };
  return <span className={cx("a-status", `tone-${d.tone}`)} data-status={s}><i />{children ?? label ?? d.label}</span>;
}
export const statusTone = (s?: string): Tone => (s ? STATUS[s.toLowerCase()]?.tone ?? "neutral" : "neutral");

export function Tab({ children }: { label: ReactNode; children?: ReactNode }) { return <>{children}</>; }

/** `<Tabs><Tab label="A">…</Tab><Tab label="B">…</Tab></Tabs>` */
export function Tabs({ children }: { children?: ReactNode }) {
  const tabs = Children.toArray(children).filter(isValidElement) as { props: { label: ReactNode; children?: ReactNode } }[];
  const [i, setI] = useState(0);
  const cur = Math.min(i, tabs.length - 1);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setI((cur + 1) % tabs.length);
    else if (e.key === "ArrowLeft") setI((cur - 1 + tabs.length) % tabs.length);
  };
  return (
    <div className="a-tabs" data-c="tabs">
      <div className="a-tablist" role="tablist" onKeyDown={key}>
        {tabs.map((t, n) => (
          <button key={n} role="tab" aria-selected={n === cur} tabIndex={n === cur ? 0 : -1} onClick={() => setI(n)}>{t.props.label}</button>
        ))}
      </div>
      <div className="a-tabpanel" role="tabpanel">{tabs[cur]?.props.children}</div>
    </div>
  );
}

/** Numbered steps with a connector; items are nodes or `{title, body, status}`. */
export function Steps({ items, children }: { items?: (ReactNode | { title: ReactNode; body?: ReactNode; status?: string })[]; children?: ReactNode }) {
  const list = items ?? Children.toArray(children);
  return (
    <ol className="a-steps" data-c="steps">
      {list.map((it, i) => {
        const o = it && typeof it === "object" && !isValidElement(it) && "title" in (it as object) ? (it as { title: ReactNode; body?: ReactNode; status?: string }) : null;
        return (
          <li key={i}>
            <span className="a-step-n">{i + 1}</span>
            <div>{o ? <><b>{o.title}</b>{o.status && <> <Status s={o.status} /></>}{o.body && <div className="a-muted">{o.body}</div>}</> : (it as ReactNode)}</div>
          </li>
        );
      })}
    </ol>
  );
}

type Q = string | { q: ReactNode; why?: ReactNode; options?: ReactNode[]; owner?: string; status?: string };
/** Things the reader has to answer: `items={["Ship now?", {q, why, options, owner}]}`. */
export function Questions({ items, title = "Questions", start }: { items: Q[]; title?: ReactNode; start?: number }) {
  return (
    <div className="a-questions" data-c="questions">
      <div className="a-questions-title">{title}</div>
      <ol start={start}>{items.map((q, i) => {
        const o = typeof q === "string" ? { q } : q;
        return (
          <li key={i}>
            <div><b>{o.q}</b>{o.owner && <> <Badge tone="warn">{o.owner}</Badge></>}{o.status && <> <Status s={o.status} /></>}</div>
            {o.why && <div className="a-muted">{o.why}</div>}
            {o.options && <ul>{o.options.map((x, j) => <li key={j}>{x}</li>)}</ul>}
          </li>
        );
      })}</ol>
    </div>
  );
}

/** `items={["text", {text, done, note, status}]}` */
export function Checklist({ items }: { items: (string | { text: ReactNode; done?: boolean; note?: ReactNode; status?: string })[] }) {
  return (
    <ul className="a-checklist" data-c="checklist">
      {items.map((it, i) => {
        const o = typeof it === "string" ? { text: it } : it;
        return (
          <li key={i} className={cx((o as { done?: boolean }).done && "done")}>
            <span className="a-box" aria-hidden>{(o as { done?: boolean }).done ? "✓" : ""}</span>
            <span>{o.text}{(o as { status?: string }).status && <> <Status s={(o as { status: string }).status} /></>}
              {(o as { note?: ReactNode }).note && <span className="a-muted"> {(o as { note?: ReactNode }).note}</span>}</span>
          </li>
        );
      })}
    </ul>
  );
}

export interface TimelineItem { when?: ReactNode; title: ReactNode; body?: ReactNode; tone?: Tone; status?: StatusValue; href?: string; lane?: string; group?: string }
const BUCKET_MIN = { minute: 1, "10min": 10, hour: 60, day: 1440 } as const;
/**
 * Events in order. With `lane` on items (an actor, an agent) the page becomes a swimlane grid: one column per lane and
 * one row per distinct time. Fewer rows: `bucket="hour"` (or "10min", "day", or minutes as a number) puts ISO `when`s in the
 * same row per bucket; `group` on an item names its row explicitly; `compact` also pulls a row up into the previous one
 * when no lane is used twice.
 */
export function Timeline({ items, bucket, compact }: { items: TimelineItem[]; bucket?: keyof typeof BUCKET_MIN | number; compact?: boolean }) {
  const lanes = [...new Set(items.map((i) => i.lane).filter((x): x is string => !!x))];
  const body = (it: TimelineItem) => (
    <div className={cx("a-tl-item", it.tone && `tone-${it.tone}`)}>
      {!lanes.length && it.when != null && <div className="a-tl-when">{it.when}</div>}
      <div><b>{it.href ? <a href={it.href} target="_blank" rel="noreferrer">{it.title}</a> : it.title}</b>{it.status && <> <Status s={it.status} /></>}
        {it.body && <div className="a-muted">{it.body}</div>}</div>
    </div>
  );
  if (!lanes.length) return <div className="a-timeline" data-c="timeline">{items.map((it, i) => <div key={i} className="a-tl-row">{body(it)}</div>)}</div>;
  const step = (typeof bucket === "number" ? bucket : bucket ? BUCKET_MIN[bucket] : 0) * 60000;
  const keyOf = (it: TimelineItem, i: number) => {
    if (it.group) return `g:${it.group}`;
    const t = step && typeof it.when === "string" ? Date.parse(it.when) : NaN;
    if (!isNaN(t)) return `b:${Math.floor(t / step)}`;
    return it.when != null ? `w:${typeof it.when === "string" || typeof it.when === "number" ? it.when : i}` : `i:${i}`;
  };
  let rows: { label: ReactNode; idx: number[] }[] = [];
  items.forEach((it, i) => {
    const k = keyOf(it, i);
    let r = rows.find((x) => keyOf(items[x.idx[0]], x.idx[0]) === k);
    if (!r) { r = { label: it.group ?? it.when, idx: [] }; rows.push(r); }
    r.idx.push(i);
  });
  const laneOf = (i: number) => items[i].lane ?? "*";
  if (compact) {
    const merged: typeof rows = [];
    for (const r of rows) {
      const prev = merged[merged.length - 1];
      const used = new Set(prev?.idx.map(laneOf));
      if (prev && !r.idx.some((i) => used.has(laneOf(i)) || laneOf(i) === "*") && !prev.idx.some((i) => laneOf(i) === "*")) { prev.idx.push(...r.idx); prev.label = prev.label === r.label ? prev.label : <>{prev.label}<span className="a-muted"> +</span></>; }
      else merged.push({ ...r, idx: [...r.idx] });
    }
    rows = merged;
  }
  // a bucketed row shows its range: first – last `when`
  const label = (r: (typeof rows)[number]) => {
    if (!step) return r.label;
    const ws = r.idx.map((i) => items[i].when).filter((w): w is string => typeof w === "string");
    return ws.length > 1 && ws[0] !== ws[ws.length - 1] ? `${ws[0]}–${ws[ws.length - 1]}` : r.label;
  };
  return (
    <div className="a-timeline lanes" data-c="timeline" style={{ gridTemplateColumns: `max-content repeat(${lanes.length}, minmax(9rem, 1fr))` }}>
      <div className="a-tl-lane-head" />
      {lanes.map((l) => <div key={l} className="a-tl-lane-head">{l}</div>)}
      {rows.map((r, n) => (
        <Fragment key={n}>
          <div className="a-tl-when a-tl-whencell" style={{ gridRow: n + 2, gridColumn: 1 }}>{label(r)}</div>
          {lanes.map((l, c) => <div key={l} className="a-tl-cell" style={{ gridRow: n + 2, gridColumn: c + 2 }} />)}
          {r.idx.map((i) => (
            <div key={i} className="a-tl-ev" style={{ gridRow: n + 2, gridColumn: items[i].lane ? lanes.indexOf(items[i].lane!) + 2 : `2 / -1`, zIndex: 1 }}>{body(items[i])}</div>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

export interface SourceProps { label: ReactNode; href?: string; kind?: string; from?: string }
/** A citation: a PR, thread, commit, file or doc, with where the claim came from. */
export function Source({ label, href, kind, from, inline }: SourceProps & { inline?: boolean }) {
  if (inline) {
    const t = [kind, from].filter(Boolean).join(" · ");
    return href ? <a className="a-src-inline" href={href} target="_blank" rel="noreferrer" title={t}>{label}</a> : <span className="a-src-inline" title={t}>{label}</span>;
  }
  const inner = <><span className="a-src-kind">{kind ?? (href ? "link" : "src")}</span><span>{label}</span>{from && <span className="a-src-from">{from}</span>}</>;
  return href
    ? <a className="a-source" data-c="source" href={href} target="_blank" rel="noreferrer">{inner}</a>
    : <span className="a-source" data-c="source">{inner}</span>;
}

/** A present-mode mark: hidden until reached when presenting, plain content otherwise. */
export function Step({ children }: { children?: ReactNode }) {
  return <div data-step>{children}</div>;
}

/** Opt-in zoom: content tagged with a depth level (1 = headline … 4 = detail); the reader's 1–4 keys hide deeper levels. */
export function Depth({ level, children, inline }: { level: 1 | 2 | 3 | 4; children?: ReactNode; inline?: boolean }) {
  const T = inline ? "span" : "div";
  // where this content is hidden, a stub says so; clicking it shows that level
  const stub = level > 1 && (
    <T className="a-depth-stub" data-depth-stub={level} role="button" tabIndex={0} title={`Show detail level ${level}`}
      onClick={() => window.dispatchEvent(new CustomEvent("artifact-depth", { detail: level }))}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") window.dispatchEvent(new CustomEvent("artifact-depth", { detail: level })); }}>
      {inline ? "…" : `▸ more at detail ${level}`}
    </T>
  );
  return <><T data-depth-level={level}>{children}</T>{stub}</>;
}

/** A claim that may have drifted: says X, now Y. */
export function Stale({ says, now, asOf, source }: { says: ReactNode; now?: ReactNode; asOf?: string; source?: ReactNode }) {
  return (
    <span className="a-stale" data-c="stale" title={asOf ? `as of ${asOf}` : undefined}>
      <s>{says}</s>{now != null ? <> <span aria-hidden>→</span> <b>{now}</b></> : <> <Badge tone="warn">unverified</Badge></>}
      {(asOf || source) && <span className="a-muted"> ({[asOf && `as of ${asOf}`, source].filter(Boolean).map((x, i) => <span key={i}>{i ? ", " : ""}{x}</span>)})</span>}
    </span>
  );
}

/** Relative time: `<Ago iso="2026-10-12T10:00:00Z" asOf={meta.asOf} />`. */
export function Ago({ iso, asOf }: { iso: string; asOf?: string }) { return <time dateTime={iso} title={iso}>{ageOf(iso, asOf).text}</time>; }

const CHECK: Record<string, Tone> = { pass: "success", passing: "success", success: "success", fail: "critical", failing: "critical", failure: "critical", pending: "warn", running: "warn" };
/** A pull request chip: number, title, state, checks, place in a stack. Fits inside Table cells. */
export function PR({ n, title, state = "open", checks, stack, href, author, conflict, updatedAt, asOf, review }: {
  n: number | string; title?: ReactNode; state?: "open" | "draft" | "merged" | "closed" | string; checks?: "pass" | "fail" | "pending" | string;
  stack?: [number, number]; href?: string; author?: string; conflict?: boolean; updatedAt?: string; asOf?: string; review?: string;
}) {
  const age = updatedAt ? ageOf(updatedAt, asOf) : undefined;
  const body = <><span className="a-pr-n">#{n}</span>{title && <span className="a-pr-title">{title}</span>}</>;
  return (
    <span className="a-pr" data-c="pr">
      {href ? <a href={href} target="_blank" rel="noreferrer">{body}</a> : body}
      <Status s={state} />
      {checks && <Badge tone={CHECK[checks] ?? "neutral"} title="checks">checks {checks}</Badge>}
      {conflict && <Badge tone="critical" title="merge conflict with the base">conflicts</Badge>}
      {review && <Badge tone={review === "approved" ? "success" : review === "changes" ? "critical" : "neutral"} title="review">{review}</Badge>}
      {age && <Badge tone={age.days >= 2 && state !== "merged" ? "warn" : "neutral"} title={`last updated ${updatedAt}`}>{age.text}</Badge>}
      {stack && <Badge title="place in the stack">{stack[0]}/{stack[1]}</Badge>}
      {author && <span className="a-muted">{author}</span>}
    </span>
  );
}
