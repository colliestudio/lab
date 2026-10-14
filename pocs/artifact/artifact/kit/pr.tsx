// The PR itself on the page: header with links, a description, commits, existing comments, and the link helpers
// (`ghUrl`, `Linked`, `Md`) every other review part uses. All read data/pr.json (from `artifact gather gh-pr`).
import { Fragment, type ReactNode } from "react";
import { allData } from "./registry.ts";
import { Badge, More } from "./layout.tsx";
import { makeGhUrl, linkify, type GhUrls, type PrLinkInfo } from "./gh.ts";
import { countBySeverity, type ReviewComment } from "./review-model.ts";
import { cx } from "./util.ts";
export { makeGhUrl, linkify, type GhUrls, type PrLinkInfo } from "./gh.ts";

/** The shape of data/pr.json the kit reads (everything beyond repo and n is optional). */
export interface PrData extends PrLinkInfo {
  title?: string; body?: string; author?: string; state?: string; draft?: boolean; additions?: number; deletions?: number; changedFiles?: number; commitCount?: number;
  href?: string; checks?: { state: "pass" | "fail" | "pending" | "none"; passed: number; failed: number; pending: number; total: number; failing: string[] };
  commits?: { sha: string; oid?: string; subject: string }[];
  comments?: { id: string; author?: string; path: string; line?: number; body: string; at?: string; url?: string; replyTo?: string }[];
}

/** The PR in data/pr.json, if the artifact has one. */
export const currentPr = (): PrData | undefined => { const p = allData().pr as PrData | undefined; return p && p.repo && p.n != null ? p : undefined; };
/** GitHub URLs for the PR in data/pr.json: `ghUrl.file("src/a.ts", 12)`, `.commit(sha)`, `.pr(7)`, `.issue(3)`, `.diff(path, line)`. Empty strings when there is no pr.json. */
export const ghUrl: GhUrls = new Proxy({} as GhUrls, {
  get: (_t, k: string) => { const p = currentPr(); const g = p ? makeGhUrl(p) : undefined; const v = g?.[k as keyof GhUrls]; return v ?? (k === "repo" ? "" : () => ""); },
});

const ext = { target: "_blank", rel: "noreferrer" } as const;
/** A quiet external link (opens in a new tab). */
export function Ext({ href, children, className, title }: { href: string; children?: ReactNode; className?: string; title?: string }) {
  return href ? <a className={cx("rv-ext", className)} href={href} title={title} {...ext}>{children}</a> : <>{children}</>;
}

/** Text with `#123`, `owner/repo#123`, URLs and backticked `file:line` / commit ids turned into links. */
export function Linked({ children, pr }: { children?: string; pr?: PrLinkInfo }) {
  const parts = linkify(children ?? "", pr ?? currentPr());
  return <>{parts.map((p, i) => p.t === "text" ? <Fragment key={i}>{p.s}</Fragment>
    : p.t === "link" ? <Ext key={i} href={p.href}>{p.s}</Ext>
    : p.href ? <Ext key={i} href={p.href}><code>{p.s}</code></Ext> : <code key={i}>{p.s}</code>)}</>;
}

const bold = (s: string, k: string): ReactNode[] => s.split(/(\*\*[^*]+\*\*)/).map((t, i) => /^\*\*[^*]+\*\*$/.test(t) ? <b key={k + i}><Linked>{t.slice(2, -2)}</Linked></b> : <Linked key={k + i}>{t}</Linked>);
/** A small Markdown subset (paragraphs, lists, headings as bold lines, fenced code, **bold**, `code`) with autolinks, for a PR body. */
export function Md({ children }: { children?: string }) {
  const blocks: ReactNode[] = [];
  const lines = (children ?? "").replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf: string[] = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; blocks.push(<pre key={blocks.length}><code>{buf.join("\n")}</code></pre>); }
    else if (/^\s*[-*] /.test(l)) { const it: string[] = []; while (i < lines.length && /^\s*[-*] /.test(lines[i])) it.push(lines[i++].replace(/^\s*[-*] (\[[ x]\] )?/, "")); blocks.push(<ul key={blocks.length}>{it.map((t, j) => <li key={j}>{bold(t, "l")}</li>)}</ul>); }
    else if (/^#{1,6} /.test(l)) { blocks.push(<p key={blocks.length}><b>{bold(l.replace(/^#+ /, ""), "h")}</b></p>); i++; }
    else if (!l.trim()) i++;
    else { const buf: string[] = []; while (i < lines.length && lines[i].trim() && !/^(```|\s*[-*] |#{1,6} )/.test(lines[i])) buf.push(lines[i++]); blocks.push(<p key={blocks.length}>{bold(buf.join(" "), "p")}</p>); }
  }
  return <div className="rv-md">{blocks}</div>;
}

const REC = { approve: "approve", comments: "approve with comments", changes: "request changes" } as const;
const CHECK = { pass: ["success", "checks passing"], fail: ["critical", "checks failing"], pending: ["warn", "checks running"] } as const;
const STATE: Record<string, "success" | "critical" | "accent" | "neutral"> = { open: "success", merged: "accent", closed: "critical" };

/**
 * The PR at the top of a review: title (linked), owner/repo#n, author, state, base ← head, size, checks, links to GitHub, an
 * optional one-line recommendation, and the description and commits behind "more". Reads data/pr.json unless `pr` is given.
 * `recommend` + `comments` print "Recommend: request changes · 2 blocking" and link to the full Verdict (`verdictId`).
 */
export function PrHeader({ pr: given, recommend, comments = [], verdictId = "verdict-section", description = true, commits = true }: {
  pr?: PrData; recommend?: keyof typeof REC; comments?: ReviewComment[]; verdictId?: string; description?: boolean; commits?: boolean;
}) {
  const pr = given ?? currentPr();
  if (!pr) throw new Error("PrHeader: no data/pr.json (run `artifact gather gh-pr`) and no pr prop");
  const g = makeGhUrl(pr);
  const url = pr.url ?? pr.href ?? g.pr();
  const counts = countBySeverity(comments);
  const ck = pr.checks && pr.checks.state !== "none" ? pr.checks : undefined;
  const n = pr.changedFiles ?? pr.files?.length, nc = pr.commitCount ?? pr.commits?.length;
  const state = pr.draft ? "draft" : (pr.state ?? "open");
  return (
    <header className="rv-pr" data-c="pr-header">
      <h2 className="rv-pr-title"><Ext href={url}>{pr.title}</Ext> <span className="rv-pr-ref">{pr.repo}#{pr.n}</span></h2>
      <div className="rv-pr-meta">
        <Badge tone={pr.draft ? "neutral" : STATE[state] ?? "neutral"}>{state}</Badge>
        {pr.author && <span><Ext href={g.user(pr.author)}>@{pr.author}</Ext></span>}
        {pr.base && pr.head && <span><Ext href={g.branch(pr.base)}><code>{pr.base}</code></Ext> ← <Ext href={g.branch(pr.head)}><code>{pr.head}</code></Ext></span>}
        {pr.additions != null && <span><span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span>{n != null && <> in {n} file{n === 1 ? "" : "s"}</>}</span>}
        {nc != null && <span>{nc} commit{nc === 1 ? "" : "s"}</span>}
        {ck && <Ext href={g.checks()} title={ck.failing.join(", ") || undefined}><Badge tone={CHECK[ck.state as keyof typeof CHECK][0]}>{CHECK[ck.state as keyof typeof CHECK][1]}{ck.state === "fail" ? ` (${ck.failed}/${ck.total})` : ""}</Badge></Ext>}
      </div>
      <div className="rv-pr-links"><Ext href={url}>Open on GitHub ↗</Ext><Ext href={g.files()}>Files changed ↗</Ext></div>
      {recommend && (
        <div className="rv-pr-rec">Recommend: <b>{REC[recommend]}</b>
          {[counts.blocking && `${counts.blocking} blocking`, counts["should-fix"] && `${counts["should-fix"]} should-fix`].filter(Boolean).map((t) => <Fragment key={String(t)}> · {t}</Fragment>)}
          {" "}<a className="rv-link" href={`#${verdictId}`} onClick={(e) => { e.preventDefault(); document.getElementById(verdictId)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>why</a>
        </div>
      )}
      {description && pr.body?.trim() && <More label="PR description"><Md>{pr.body}</Md></More>}
      {commits && pr.commits && pr.commits.length > 0 && <More label={`${pr.commits.length} commit${pr.commits.length === 1 ? "" : "s"}`}><PrCommits pr={pr} /></More>}
    </header>
  );
}

/** The PR's commits, each linked to GitHub. */
export function PrCommits({ pr: given }: { pr?: PrData }) {
  const pr = given ?? currentPr();
  if (!pr?.commits) return null;
  const g = makeGhUrl(pr);
  return <ul className="rv-commits">{pr.commits.map((c) => <li key={c.sha}><Ext href={g.commit(c.oid ?? c.sha)}><code>{c.sha}</code></Ext> <Linked>{c.subject}</Linked></li>)}</ul>;
}

/** Review comments that were already on the PR, each linked to its GitHub thread and file line. */
export function ExistingComments({ pr: given }: { pr?: PrData }) {
  const pr = given ?? currentPr();
  if (!pr?.comments?.length) return null;
  const g = makeGhUrl(pr);
  return <ul className="rv-existing">{pr.comments.map((c) => (
    <li key={c.id} id={`ex-${c.id}`}>
      <div className="a-muted">{c.author && <Ext href={g.user(c.author)}>@{c.author}</Ext>} on <Ext href={g.file(c.path, c.line)}><code>{c.path}{c.line ? `:${c.line}` : ""}</code></Ext> · <Ext href={c.url ?? g.comment(c.id)}>open thread ↗</Ext></div>
      <div><Linked>{c.body}</Linked></div>
    </li>
  ))}</ul>;
}
