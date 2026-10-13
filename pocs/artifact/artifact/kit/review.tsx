// Guided PR review parts: ReviewDiff (a full diff with comments in a margin), the comment model with Keep / Edit / Drop,
// CopyReview (GitHub-ready Markdown), Layers / LayerTag (the change layer by layer) and Verdict.
import { Fragment, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { highlightLines } from "./highlight.ts";
import { getEvidence, type PatchFile } from "./registry.ts";
import { langOf } from "./code.tsx";
import { Badge, type Tone } from "./layout.tsx";
import { Decision } from "./decision.tsx";
import { useAnswer, useAnswers, setAnswer, type Answer } from "./feedback.ts";
import { copyText } from "./copy.ts";
import { cx } from "./util.ts";
import { SEVERITIES, span, where, key, statusOf, countBySeverity, reviewMarkdown, commentMarkdown, type Severity, type ReviewComment, type AuthorNote } from "./review-model.ts";
export { SEVERITIES, statusOf, countBySeverity, reviewMarkdown, commentMarkdown, type Severity, type ReviewComment, type AuthorNote, type CommentStatus } from "./review-model.ts";

const TONE: Record<Severity, Tone> = { blocking: "critical", "should-fix": "warn", question: "info", nit: "neutral", praise: "success" };

// ---- comment card -------------------------------------------------------------------------------------------------

export function CommentCard({ c, actions = true }: { c: ReviewComment; actions?: boolean }) {
  const [a, set] = useAnswer(key(c.id));
  const { status, body } = statusOf(c, a ? { [key(c.id)]: a } : {});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const q = `${where(c)} (${c.severity})`;
  const choose = (choice: "keep" | "drop") => set({ choice, label: choice === "keep" ? "Keep" : "Drop", question: q, custom: a?.custom });
  return (
    <div className={cx("rv-card", `sev-${c.severity}`, status === "drop" && "dropped")} data-c="review-comment" data-status={status}>
      <div className="rv-card-head">
        <Badge tone={TONE[c.severity]}>{c.severity}</Badge>
        {c.dupOf && <Badge tone="neutral" title="Another reviewer already said this">repeat of {c.dupOf}</Badge>}
        <span className="rv-where">{where(c)}</span>
        {status === "edit" && <span className="a-muted">edited</span>}
      </div>
      {editing ? (
        <div className="rv-edit">
          <textarea rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit comment" />
          <div className="rv-actions">
            <button onClick={() => { set({ choice: "edit", label: "Edited", custom: draft.trim() || c.body, question: q }); setEditing(false); }}>Save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : <div className="rv-body">{body}</div>}
      {c.suggestion != null && <pre className="rv-suggest"><code>{c.suggestion}</code></pre>}
      {c.evidence && <div className="rv-evidence a-muted">{c.evidence}</div>}
      {actions && !editing && (
        <div className="rv-actions" role="group" aria-label="Decide">
          <button aria-pressed={status === "keep"} onClick={() => choose("keep")}>Keep</button>
          <button aria-pressed={status === "edit"} onClick={() => { setDraft(body); setEditing(true); }}>Edit</button>
          <button aria-pressed={status === "drop"} onClick={() => choose("drop")}>Drop</button>
          <button onClick={async () => { if (await copyText(commentMarkdown(c, body))) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>{copied ? "Copied" : "Copy"}</button>
        </div>
      )}
    </div>
  );
}

const Counts = ({ counts }: { counts: Record<Severity, number> }) => (
  <span className="rv-counts">{SEVERITIES.filter((s) => counts[s]).map((s) => <Badge key={s} tone={TONE[s]}>{counts[s]} {s}</Badge>)}</span>
);

/** The comment list: counts by severity, each comment with Keep / Edit / Drop and its own copy. */
export function ReviewComments({ comments, id }: { comments: ReviewComment[]; id?: string }) {
  const answers = useAnswers();
  const undecided = comments.filter((c) => statusOf(c, answers).status === "undecided").length;
  return (
    <div className="rv-comments" data-c="review-comments" data-aid={id}>
      <div className="rv-bar"><b>{comments.length} comments</b> <Counts counts={countBySeverity(comments)} />
        {undecided > 0 && <button className="rv-link" onClick={() => { comments.forEach((c) => { if (statusOf(c, answers).status === "undecided") setAnswerFor(c); }); }}>Keep all {undecided} undecided</button>}
      </div>
      {SEVERITIES.flatMap((s) => comments.filter((c) => c.severity === s)).map((c) => (
        <Fragment key={c.id}><CommentCard c={c} /></Fragment>
      ))}
    </div>
  );
}
const setAnswerFor = (c: ReviewComment) => setAnswer(key(c.id), { choice: "keep", label: "Keep", question: `${where(c)} (${c.severity})` });

/** Copy the review as GitHub-ready Markdown: kept and edited comments only. `verdict` overrides the Verdict answer. */
export function CopyReview({ comments, title, summary, verdict, verdictId = "verdict" }: { comments: ReviewComment[]; title?: string; summary?: string; verdict?: string; verdictId?: string }) {
  const answers = useAnswers();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const v = verdict ?? answers[verdictId]?.label;
  const md = reviewMarkdown({ title, summary, verdict: v, comments, answers });
  const kept = comments.filter((c) => ["keep", "edit"].includes(statusOf(c, answers).status)).length;
  return (
    <div className="rv-copy" data-c="copy-review">
      <div className="rv-bar">
        <button className="rv-primary" onClick={async () => { if (await copyText(md)) { setCopied(true); setTimeout(() => setCopied(false), 1600); } }}>{copied ? "Copied" : "Copy review"}</button>
        <span className="a-muted">{kept} of {comments.length} comments{v ? ` · ${v}` : " · no verdict chosen yet"}</span>
        <button className="rv-link" onClick={() => setOpen(!open)}>{open ? "Hide" : "Preview"}</button>
      </div>
      {open && <pre className="rv-preview">{md}</pre>}
    </div>
  );
}

// ---- ReviewDiff ---------------------------------------------------------------------------------------------------

let show = true;
const subs = new Set<() => void>();
const sub = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
/** The one global show/hide for margin comments (every ReviewDiff on the page follows it). */
export const useShowComments = (): [boolean, (v: boolean) => void] => [
  useSyncExternalStore(sub, () => show, () => true),
  (v) => { show = v; subs.forEach((f) => f()); },
];

type Item = { kind: "comment"; c: ReviewComment } | { kind: "note"; n: AuthorNote };
const fileMatch = (path: string, f: string) => path === f || path.endsWith("/" + f);

function Items({ items }: { items: Item[] }) {
  return <>{items.map((it, i) => it.kind === "comment"
    ? <CommentCard key={it.c.id} c={it.c} />
    : <div key={"n" + i} className="rv-card rv-note"><div className="rv-card-head"><Badge tone="accent">author note</Badge></div><div className="rv-body">{it.n.body}</div></div>)}</>;
}

function FileView({ f, index, items, on }: { f: PatchFile; index: number; items: Item[]; on: boolean }) {
  const lang = langOf(f.path);
  const rows: { t: string; old?: number; nw?: number; html: string; hunk: number }[] = [];
  const lastOfHunk: number[] = [];
  f.hunks.forEach((h, hi) => {
    const nh = highlightLines(h.lines.filter((l) => l.t !== "-").map((l) => l.s), lang), oh = highlightLines(h.lines.filter((l) => l.t !== "+").map((l) => l.s), lang);
    let ni = 0, oi = 0, o = h.oldStart, n = h.newStart;
    for (const l of h.lines) {
      const html = l.t === "-" ? oh[oi++] : l.t === "+" ? nh[ni++] : (oi++, nh[ni++]);
      rows.push({ t: l.t, old: l.t !== "+" ? o : undefined, nw: l.t !== "-" ? n : undefined, html, hunk: hi });
      if (l.t !== "+") o++;
      if (l.t !== "-") n++;
    }
    lastOfHunk[hi] = rows.length - 1;
  });
  // each item hangs on the row of its last line (or the next row after it); the rest list below the file
  const anchored = new Map<number, Item[]>(), loose: Item[] = [], tint = new Set<number>();
  for (const it of items) {
    const [a, b] = span(it.kind === "comment" ? it.c : it.n);
    let ri = a ? rows.findIndex((r) => r.nw != null && r.nw >= b) : -1;
    if (ri >= 0 && rows[ri].nw! - b > 3) ri = -1;
    if (ri < 0) { loose.push(it); continue; }
    anchored.set(ri, [...(anchored.get(ri) ?? []), it]);
    rows.forEach((r, i) => { if (r.nw != null && r.nw >= a && r.nw <= b) tint.add(i); });
  }
  const out: ReactNode[] = [];
  let prevNew = 0;
  f.hunks.forEach((h, hi) => {
    const from = rows.findIndex((r) => r.hunk === hi), to = lastOfHunk[hi];
    const gap = h.newStart - prevNew - 1;
    out.push(<tr key={`h${hi}`} className="hunk"><td colSpan={5}>{gap > 0 && prevNew > 0 ? `⋯ ${gap} unchanged lines · ` : ""}@@ {h.oldStart} → {h.newStart} @@ {h.ctx ?? ""}</td></tr>);
    // margin segments: a new one starts at every row with items
    const starts = [from, ...[...anchored.keys()].filter((k) => k > from && k <= to).sort((a, b) => a - b)];
    const segStart = new Set(starts);
    for (let i = from; i <= to; i++) {
      const r = rows[i];
      const segIdx = starts.indexOf(i);
      const len = segIdx >= 0 ? (starts[segIdx + 1] ?? to + 1) - i : 0;
      const its = anchored.get(i);
      out.push(
        <tr key={`r${i}`} className={cx(r.t === "+" ? "add" : r.t === "-" ? "del" : "ctx", tint.has(i) && "rv-tint")} data-line={r.nw}>
          <td className="g">{its && <span className={cx("rv-dot", `sev-${its[0].kind === "comment" ? its[0].c.severity : "note"}`)} title={`${its.length} comment${its.length > 1 ? "s" : ""}`} />}</td>
          <td className="n">{r.old ?? ""}</td><td className="n">{r.nw ?? ""}</td>
          <td className="c"><span className="m">{r.t === " " ? "" : r.t}</span><span dangerouslySetInnerHTML={{ __html: r.html || " " }} /></td>
          {segStart.has(i) && <td className="rv-margin" rowSpan={len}>{its && <Items items={its} />}</td>}
        </tr>,
      );
      if (its) out.push(<tr key={`i${i}`} className="rv-inline"><td colSpan={5}><Items items={its} /></td></tr>);
    }
    prevNew = h.newStart + h.lines.filter((l) => l.t !== "-").length - 1;
  });
  return (
    <details open className="a-diff-file rv-file" id={`rvf-${index}`} data-c="diff" data-aid={`diff:${f.path}`}>
      <summary>
        <span className="a-diff-path">{f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ` : ""}{f.path}</span>
        {f.change !== "changed" && <span className="a-diff-tag">{f.change}</span>}
        <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
        {items.length > 0 && on && <span className="rv-n">{items.length} comment{items.length > 1 ? "s" : ""}</span>}
      </summary>
      {f.binary && <div className="a-muted a-pad">binary file</div>}
      <table className="a-diff rv-diff"><colgroup><col className="cg" /><col className="cn" /><col className="cn" /><col /><col className="cm" /></colgroup><tbody>{out}</tbody></table>
      {loose.length > 0 && on && <div className="rv-loose"><div className="a-muted">On lines outside the shown hunks</div><Items items={loose} /></div>}
    </details>
  );
}

/**
 * The whole PR diff: every file (list at the top), highlighted, continuous line numbers; comments sit in a right-hand margin
 * next to their line (a dot in the gutter, a tint over the range) and below it under ~860 px. One toggle shows or hides them.
 * `comments` are ReviewComments (Keep / Edit / Drop inside); `notes` are the author's own (requester mode).
 */
export function ReviewDiff({ patch, file, comments = [], notes = [], show: showInitial, id }: {
  patch: string | PatchFile[]; file?: string | string[]; comments?: ReviewComment[]; notes?: AuthorNote[]; show?: boolean; id?: string;
}) {
  const all = typeof patch === "string" ? getEvidence(patch, "patch").files : patch;
  const want = file == null ? null : Array.isArray(file) ? file : [file];
  const files = want ? all.filter((f) => want.some((w) => fileMatch(f.path, w))) : all;
  if (want && !files.length) throw new Error(`ReviewDiff: no file matching ${want.join(", ")}`);
  const [on, setOn] = useShowComments();
  useMemo(() => { if (showInitial === false) setOn(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const itemsFor = (f: PatchFile): Item[] => [
    ...comments.filter((c) => fileMatch(f.path, c.file)).map((c) => ({ kind: "comment", c }) as Item),
    ...notes.filter((n) => fileMatch(f.path, n.file)).map((n) => ({ kind: "note", n }) as Item),
  ].sort((a, b) => span(a.kind === "comment" ? a.c : a.n)[0] - span(b.kind === "comment" ? b.c : b.n)[0]);
  const jump = (i: number) => { const el = document.getElementById(`rvf-${i}`); if (el) { (el as HTMLDetailsElement).open = true; el.scrollIntoView({ block: "start" }); } };
  const total = files.reduce((a, f) => a + itemsFor(f).length, 0);
  return (
    <div className="rv a-wide" data-c="review-diff" data-aid={id} data-comments={on ? "on" : "off"}>
      <div className="rv-top">
        <div className="rv-files" role="list" aria-label="Files in the diff">
          {files.map((f, i) => {
            const n = itemsFor(f).length;
            return <button key={f.path} role="listitem" className="rv-fbtn" onClick={() => jump(i)} title={f.path}>
              <span className="rv-fname">{f.path.split("/").pop()}</span><span className="a-muted rv-fdir">{f.path.split("/").slice(0, -1).join("/")}</span>
              <span className="add">+{f.additions}</span><span className="del">−{f.deletions}</span>{n > 0 && <span className="rv-n">{n}</span>}
            </button>;
          })}
        </div>
        {total > 0 && <button className="rv-toggle" aria-pressed={on} onClick={() => setOn(!on)}>{on ? "Hide" : "Show"} comments ({total})</button>}
      </div>
      {files.map((f, i) => <FileView key={f.path} f={f} index={i} items={itemsFor(f)} on={on} />)}
    </div>
  );
}

// ---- Layers -------------------------------------------------------------------------------------------------------

export interface Layer { id: string; title: string; role: string; changed: boolean; what?: ReactNode; files?: string[]; affected?: ReactNode; anchor?: string }
export interface LayerFlow { from: string; to: string; label: string; before?: ReactNode; after?: ReactNode }

let known: Layer[] = [];
const lsubs = new Set<() => void>();
const useKnown = () => useSyncExternalStore((cb) => { lsubs.add(cb); return () => { lsubs.delete(cb); }; }, () => known, () => known);
const goto = (id?: string) => { if (id) document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" }); };

/**
 * The change layer by layer, top to bottom. Changed layers are full strength; unchanged layers are dimmed, and those the
 * change still affects say why. `flows` describe what moves between neighbouring layers (before → after). A layer's
 * click scrolls to its `anchor` id (default `layer-<id>`).
 */
export function Layers({ layers, flows = [], id = "layers" }: { layers: Layer[]; flows?: LayerFlow[]; id?: string }) {
  if (known !== layers && JSON.stringify(known.map((l) => l.id)) !== JSON.stringify(layers.map((l) => l.id))) { known = layers; lsubs.forEach((f) => f()); }
  return (
    <ol className="rv-layers" id={id} data-c="layers">
      {layers.map((l, i) => {
        const flow = flows.filter((f) => f.from === l.id);
        const state = l.changed ? "changed" : l.affected ? "affected" : "unchanged";
        return (
          <Fragment key={l.id}>
            <li className={cx("rv-layer", state)} data-layer={l.id} data-state={state}>
              <button className="rv-layer-btn" onClick={() => goto(l.anchor ?? `layer-${l.id}`)}>
                <span className="rv-layer-n">{i + 1}</span>
                <span className="rv-layer-main">
                  <span className="rv-layer-title"><b>{l.title}</b> <span className="a-muted">{l.role}</span> <Badge tone={l.changed ? "accent" : l.affected ? "warn" : "neutral"}>{state}</Badge></span>
                  {l.what && <span className="rv-layer-what">{l.what}</span>}
                  {!l.changed && l.affected && <span className="rv-layer-aff">Still matters: {l.affected}</span>}
                  {l.files && l.files.length > 0 && <span className="rv-layer-files">{l.files.map((f) => <code key={f}>{f}</code>)}</span>}
                </span>
              </button>
            </li>
            {flow.map((f) => (
              <li key={f.from + f.to + f.label} className="rv-flow" aria-label={`${f.from} to ${f.to}`}>
                <span className="rv-arrow">↓</span><b>{f.label}</b>
                {(f.before != null || f.after != null) && <span className="rv-ba">{f.before != null && <span><i>before</i> {f.before}</span>}{f.after != null && <span><i>after</i> {f.after}</span>}</span>}
              </li>
            ))}
          </Fragment>
        );
      })}
    </ol>
  );
}

/** "Layer 3 of 6: Domain" for a code-walk step; links back to the Layers block. Pass `layers` when it is not on the page. */
export function LayerTag({ layer, layers, to = "layers" }: { layer: string; layers?: Layer[]; to?: string }) {
  const reg = useKnown();
  const list = layers ?? reg;
  const i = list.findIndex((l) => l.id === layer);
  const l = list[i];
  return <button className="rv-layertag" onClick={() => goto(to)} title="Back to the layers">{l ? `Layer ${i + 1} of ${list.length}: ${l.title}` : `Layer: ${layer}`}</button>;
}

// ---- Verdict ------------------------------------------------------------------------------------------------------

export const VERDICTS = ["Approve", "Approve with comments", "Request changes"] as const;
/**
 * The review's headline: a Decision (approve / approve with comments / request changes) with your recommendation, the read
 * time, the 3 things that matter and the comment counts by severity.
 */
export function Verdict({ recommend, matters, readTime, comments = [], id = "verdict", question = "Your verdict on this PR", children }: {
  recommend: 0 | 1 | 2 | (typeof VERDICTS)[number] | "approve" | "comments" | "changes"; matters?: ReactNode[]; readTime?: string; comments?: ReviewComment[]; id?: string; question?: ReactNode; children?: ReactNode;
}) {
  const rec = typeof recommend === "number" ? recommend : ({ approve: 0, comments: 1, changes: 2 } as Record<string, number>)[recommend] ?? VERDICTS.indexOf(recommend as (typeof VERDICTS)[number]);
  return (
    <div className="rv-verdict" data-c="verdict">
      <div className="rv-bar">{readTime && <span className="a-muted">Read time {readTime}</span>}{comments.length > 0 && <Counts counts={countBySeverity(comments)} />}</div>
      {matters && matters.length > 0 && <ol className="rv-matters">{matters.map((m, i) => <li key={i}>{m}</li>)}</ol>}
      {children}
      <Decision id={id} question={question} options={[...VERDICTS]} recommend={rec} owner="reviewer" />
    </div>
  );
}
