import { Fragment, useMemo, useState, type ReactNode } from "react";
import { highlightLines } from "./highlight.ts";
import { getEvidence, type PatchFile } from "./registry.ts";
import { cx, parseNums } from "./util.ts";
import { Heavy } from "./layout.tsx";
import { ReviewDiff, type ReviewComment, type AuthorNote } from "./review.tsx";

const LANG: Record<string, string> = {
  go: "go", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", json: "json",
  yaml: "yaml", yml: "yaml", md: "markdown", sql: "sql", py: "python", rs: "rust", sh: "bash", css: "css", html: "xml", toml: "ini",
};
export const langOf = (path?: string) => (path ? LANG[path.split(".").pop()?.toLowerCase() ?? ""] : undefined);

const Html = ({ html }: { html: string }) => <span dangerouslySetInnerHTML={{ __html: html || " " }} />;

/**
 * Source lines. Give `code` (or a string child) or `file="evidence/x.ts"`; `ranges="1-10,30-40"` shows only those lines
 * (gaps are marked), `highlight="5,7-8"` marks lines, `start` is the first line's number for inline `code`.
 */
export function Code({ code, file, lang, ranges, highlight, title, path, href, notes, start = 1, children, id, collapsed }: {
  code?: string; file?: string; lang?: string; ranges?: string | [number, number][]; highlight?: string | number[];
  title?: ReactNode; path?: string; href?: string; notes?: Record<number | string, ReactNode>; start?: number; children?: string; id?: string; collapsed?: boolean;
}) {
  const text = (code ?? children ?? (file ? getEvidence(file, "text").text : "")).replace(/\n$/, "");
  const language = lang ?? langOf(path ?? file ?? (typeof title === "string" ? title : undefined));
  const html = useMemo(() => highlightLines(text.split("\n"), language), [text, language]);
  const want = useMemo(() => parseNums(ranges as string), [ranges]);
  const hl = useMemo(() => new Set(parseNums(highlight as string) ?? []), [highlight]);
  // notes are keyed by line number, or by text: the first line containing the key gets the note
  const noteAt = useMemo(() => {
    const out: Record<number, ReactNode> = {};
    const ls = text.split("\n");
    for (const [k, v] of Object.entries(notes ?? {})) {
      if (/^\d+$/.test(k)) out[Number(k)] = v;
      else { const i = ls.findIndex((l) => l.includes(k)); if (i >= 0) out[start + i] = v; }
    }
    return out;
  }, [notes, text, start]);
  const [wrap, setWrap] = useState(false);
  const long = text.split("\n").some((l) => l.length > 100);
  const shown = html.map((h, i) => ({ h, n: start + i })).filter((l) => !want || want.includes(l.n));
  const label = `Code: ${typeof (title ?? path ?? file) === "string" ? (title ?? path ?? file) : "snippet"} (${shown.length} lines)`;
  return (
    <Heavy label={label} collapsed={collapsed}>
    <figure className={cx("a-code", wrap && "wrap")} data-c="code" data-aid={id}>
      {(title || path || file || long) && (
        <figcaption className="a-code-title"><span>{href ? <a href={href} target="_blank" rel="noreferrer">{title ?? path ?? file}</a> : title ?? path ?? file}</span>
          {long && <button className="a-code-wrap" aria-pressed={wrap} onClick={() => setWrap(!wrap)} title="Wrap long lines">wrap</button>}</figcaption>
      )}
      <pre><code>{shown.map((l, i) => (
        <Fragment key={l.n}>
          {i > 0 && l.n - shown[i - 1].n > 1 && <span className="a-gap">⋯ {l.n - shown[i - 1].n - 1} lines hidden</span>}
          <span className={cx("a-ln", hl.has(l.n) && "hl")}><span className="n">{l.n}</span><Html html={l.h} /></span>
          {noteAt[l.n] != null && <span className="a-note">{noteAt[l.n]}</span>}
        </Fragment>
      ))}</code></pre>
    </figure>
    </Heavy>
  );
}

const FOLD = 10, KEEP = 3, MAX = 60;

/** Diff notes keyed by new-side line number, or by text (the first added/context line containing it). */
function resolveDiffNotes(f: PatchFile, raw?: Record<number | string, ReactNode>): Record<number, ReactNode> | undefined {
  if (!raw) return undefined;
  const out: Record<number, ReactNode> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (/^\d+$/.test(k)) { out[Number(k)] = v; continue; }
    search: for (const h of f.hunks) { let n = h.newStart; for (const l of h.lines) { if (l.t === "-") continue; if (l.s.includes(k)) { out[n] = v; break search; } n++; } }
  }
  return out;
}

function FileDiff({ f, hunks, notes: rawNotes }: { f: PatchFile; hunks?: number[]; notes?: Record<number | string, ReactNode> }) {
  const notes = useMemo(() => resolveDiffNotes(f, rawNotes), [f, rawNotes]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const lang = langOf(f.path);
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const hs = f.hunks.map((h, i) => ({ h, i })).filter(({ i }) => !hunks || hunks.includes(i + 1));
  return (
    <details open className="a-diff-file" data-c="diff" data-aid={`diff:${f.path}`}>
      <summary>
        <span className="a-diff-path">{f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ` : ""}{f.path}</span>
        {f.change !== "changed" && <span className="a-diff-tag">{f.change}</span>}
        <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
      </summary>
      {f.binary && <div className="a-muted a-pad">binary file</div>}
      <table className="a-diff"><tbody>
        {hs.map(({ h, i }) => {
          const newSide = h.lines.filter((l) => l.t !== "-").map((l) => l.s), oldSide = h.lines.filter((l) => l.t !== "+").map((l) => l.s);
          const nh = highlightLines(newSide, lang), oh = highlightLines(oldSide, lang);
          let ni = 0, oi = 0, o = h.oldStart, n = h.newStart;
          const rows = h.lines.map((l) => {
            const html = l.t === "-" ? oh[oi++] : l.t === "+" ? nh[ni++] : (oi++, nh[ni++]);
            const r = { t: l.t, old: l.t !== "+" ? o : undefined, nw: l.t !== "-" ? n : undefined, html };
            if (l.t !== "+") o++;
            if (l.t !== "-") n++;
            return r;
          });
          // fold long unchanged runs
          const out: ReactNode[] = [];
          let k = 0;
          while (k < rows.length) {
            if (rows[k].t === " ") {
              let e = k; while (e < rows.length && rows[e].t === " ") e++;
              const len = e - k, key = `${i}:${k}`;
              if (len > FOLD && !open.has(key)) {
                const lead = k === 0 ? 0 : KEEP, tail = e === rows.length ? 0 : KEEP;
                for (let j = k; j < k + lead; j++) out.push(<DRow key={`${i}-${j}`} r={rows[j]} notes={notes} />);
                out.push(<tr key={`f${key}`} className="fold"><td colSpan={3}><button onClick={() => toggle(key)}>⋯ {len - lead - tail} unchanged lines</button></td></tr>);
                for (let j = e - tail; j < e; j++) out.push(<DRow key={`${i}-${j}`} r={rows[j]} notes={notes} />);
                k = e; continue;
              }
            }
            out.push(<DRow key={`${i}-${k}`} r={rows[k]} notes={notes} />); k++;
          }
          const long = out.length > MAX && !open.has(`m${i}`);
          return (
            <Fragment key={i}>
              <tr className="hunk"><td colSpan={3}>@@ {h.oldStart} → {h.newStart} @@ {h.ctx ?? ""}</td></tr>
              {long ? out.slice(0, MAX) : out}
              {long && <tr className="fold"><td colSpan={3}><button onClick={() => toggle(`m${i}`)}>⋯ {out.length - MAX} more rows</button></td></tr>}
            </Fragment>
          );
        })}
      </tbody></table>
    </details>
  );
}

function DRow({ r, notes }: { r: { t: string; old?: number; nw?: number; html: string }; notes?: Record<number, ReactNode> }) {
  const note = r.nw != null ? notes?.[r.nw] : undefined;
  return (
    <>
      <tr className={r.t === "+" ? "add" : r.t === "-" ? "del" : "ctx"}>
        <td className="n">{r.old ?? ""}</td><td className="n">{r.nw ?? ""}</td>
        <td className="c"><span className="m">{r.t === " " ? "" : r.t}</span><Html html={r.html} /></td>
      </tr>
      {note && <tr className="note"><td colSpan={3}>{note}</td></tr>}
    </>
  );
}

/**
 * A diff from evidence: `patch="evidence/x.patch"`; `file` (path or suffix, or an array) picks files, `hunks="1,3"` picks hunks
 * (1-based), `notes={{12: "why"}}` annotates new-side lines. Parsed at build time; the raw patch is not in the output.
 */
export function Diff({ patch, file, hunks, notes, wrap = true, collapsed, comments, authorNotes }: {
  patch: string | PatchFile[]; file?: string | string[]; hunks?: string | number[]; notes?: Record<number | string, ReactNode>; wrap?: boolean; collapsed?: boolean;
  /** margin mode: ReviewComments (and `authorNotes`) shown in a right-hand margin next to their lines, as in `<ReviewDiff>` */
  comments?: ReviewComment[]; authorNotes?: AuthorNote[];
}) {
  if (comments || authorNotes) return <ReviewDiff patch={patch} file={file} comments={comments} notes={authorNotes} />;
  const all = typeof patch === "string" ? getEvidence(patch, "patch").files : patch;
  const want = file == null ? null : Array.isArray(file) ? file : [file];
  const files = want ? all.filter((f) => want.some((w) => f.path === w || f.path.endsWith("/" + w))) : all;
  if (want && !files.length) throw new Error(`Diff: no file matching ${want.join(", ")} in ${typeof patch === "string" ? patch : "patch"}`);
  const hs = parseNums(hunks as string);
  const nLines = files.reduce((a, f) => a + f.hunks.reduce((b, h) => b + h.lines.length, 0), 0);
  return <Heavy collapsed={collapsed} label={`Diff: ${files.map((f) => f.path.split("/").pop()).join(", ")} (${nLines} lines)`}><div className={cx("a-diffs", !wrap && "nowrap")}>{files.map((f) => <FileDiff key={f.path} f={f} hunks={hs} notes={notes} />)}</div></Heavy>;
}
