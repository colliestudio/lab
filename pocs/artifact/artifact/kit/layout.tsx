import { Children, createContext, isValidElement, useContext, useState, type CSSProperties, type ReactNode } from "react";
import { cx, slug } from "./util.ts";

export type Tone = "neutral" | "info" | "success" | "warn" | "critical" | "accent";

const LevelCtx = createContext(1);

/** Optional width wrapper; the host already wraps every artifact in one. */
export function Page({ children, width = "normal" }: { children: ReactNode; width?: "narrow" | "normal" | "wide" | "full" }) {
  return <div className="a-page" data-width={width}>{children}</div>;
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
        {children}
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
  items: { title: ReactNode; body?: ReactNode; status?: string; href?: string; tone?: Tone; footer?: ReactNode; id?: string }[];
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
export function Status({ s, label, children }: { s: string; label?: ReactNode; children?: ReactNode }) {
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
export function Questions({ items, title = "Questions" }: { items: Q[]; title?: ReactNode }) {
  return (
    <div className="a-questions" data-c="questions">
      <div className="a-questions-title">{title}</div>
      <ol>{items.map((q, i) => {
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

/** A decision someone must make: options, a recommendation, who has to decide. */
export function Decision({ question, options, recommend, owner = "needs a decision", why, id }: {
  question: ReactNode; options?: (ReactNode | { label: ReactNode; note?: ReactNode })[]; recommend?: number | string;
  owner?: string; why?: ReactNode; id?: string;
}) {
  return (
    <div className="a-decision" data-c="decision" data-aid={id}>
      <div className="a-decision-head"><Badge tone="warn">{owner}</Badge></div>
      <div className="a-decision-q">{question}</div>
      {why && <div className="a-muted">{why}</div>}
      {options && <ul className="a-options">{options.map((o, i) => {
        const x = o && typeof o === "object" && !isValidElement(o) && "label" in (o as object) ? (o as { label: ReactNode; note?: ReactNode }) : { label: o as ReactNode };
        const rec = recommend === i || (typeof recommend === "string" && typeof x.label === "string" && x.label === recommend);
        return <li key={i} className={cx(rec && "rec")}><span>{x.label}{x.note && <span className="a-muted"> {x.note}</span>}</span>{rec && <Badge tone="success">recommended</Badge>}</li>;
      })}</ul>}
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

export interface TimelineItem { when?: ReactNode; title: ReactNode; body?: ReactNode; tone?: Tone; status?: string; href?: string; lane?: string }
/** Events in order. With `lane` on items (an actor, an agent) the rows split into one column per lane. */
export function Timeline({ items }: { items: TimelineItem[] }) {
  const lanes = [...new Set(items.map((i) => i.lane).filter((x): x is string => !!x))];
  const row = (it: TimelineItem, i: number) => (
    <div className={cx("a-tl-item", it.tone && `tone-${it.tone}`)}>
      {it.when != null && <div className="a-tl-when">{it.when}</div>}
      <div><b>{it.href ? <a href={it.href} target="_blank" rel="noreferrer">{it.title}</a> : it.title}</b>{it.status && <> <Status s={it.status} /></>}
        {it.body && <div className="a-muted">{it.body}</div>}</div>
    </div>
  );
  if (!lanes.length) return <div className="a-timeline" data-c="timeline">{items.map((it, i) => <div key={i} className="a-tl-row">{row(it, i)}</div>)}</div>;
  return (
    <div className="a-timeline lanes" data-c="timeline" style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(10rem, 1fr))` }}>
      {lanes.map((l) => <div key={l} className="a-tl-lane-head">{l}</div>)}
      {items.map((it, i) => {
        const col = it.lane ? lanes.indexOf(it.lane) + 1 : 1;
        return <div key={i} className="a-tl-row" style={{ gridColumn: it.lane ? col : `1 / -1`, gridRow: i + 2 }}>{row(it, i)}</div>;
      })}
    </div>
  );
}

export interface SourceProps { label: ReactNode; href?: string; kind?: string; from?: string }
/** A citation: a PR, thread, commit, file or doc, with where the claim came from. */
export function Source({ label, href, kind, from }: SourceProps) {
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
  return <T data-depth-level={level}>{children}</T>;
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

const CHECK: Record<string, Tone> = { pass: "success", passing: "success", success: "success", fail: "critical", failing: "critical", failure: "critical", pending: "warn", running: "warn" };
/** A pull request chip: number, title, state, checks, place in a stack. Fits inside Table cells. */
export function PR({ n, title, state = "open", checks, stack, href, author }: {
  n: number | string; title?: ReactNode; state?: "open" | "draft" | "merged" | "closed" | string; checks?: "pass" | "fail" | "pending" | string;
  stack?: [number, number]; href?: string; author?: string;
}) {
  const body = <><span className="a-pr-n">#{n}</span>{title && <span className="a-pr-title">{title}</span>}</>;
  return (
    <span className="a-pr" data-c="pr">
      {href ? <a href={href} target="_blank" rel="noreferrer">{body}</a> : body}
      <Status s={state} />
      {checks && <Badge tone={CHECK[checks] ?? "neutral"} title="checks">checks {checks}</Badge>}
      {stack && <Badge title="place in the stack">{stack[0]}/{stack[1]}</Badge>}
      {author && <span className="a-muted">{author}</span>}
    </span>
  );
}
