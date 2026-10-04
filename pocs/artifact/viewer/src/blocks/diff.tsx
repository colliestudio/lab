import { Fragment, useEffect, useMemo, useState } from "react";
import type { Change, DiffNote, FileChange, Hunk } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { highlightLines } from "../highlight.ts";
import { AddDel, ChurnBar } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { cx, diffId, langOf } from "../util.ts";
import type { B } from "./simple.tsx";

const CONTEXT_FOLD = 10;   // fold unchanged runs longer than this
const CONTEXT_KEEP = 3;    // lines kept at each end of a folded run
const HUNK_MAX = 60;       // hunks longer than this start truncated

type Row =
  | { k: "line"; t: " " | "+" | "-"; old?: number; new?: number; html: string; noteIdx?: number }
  | { k: "note"; n: number; note: string }
  | { k: "fold"; id: string; count: number }
  | { k: "more"; id: string; count: number };

function hunkRows(h: Hunk, hi: number, lang: string | undefined, notes: Map<number, { n: number; note: string }[]>,
  open: Set<string>): Row[] {
  // Highlight each side as continuous text so multi-line constructs colour right.
  const newSide = h.lines.filter((l) => l.t !== "-").map((l) => l.s);
  const oldSide = h.lines.filter((l) => l.t !== "+").map((l) => l.s);
  const nh = highlightLines(newSide, lang), oh = highlightLines(oldSide, lang);
  let ni = 0, oi = 0;
  let oldNo = h.oldStart, newNo = h.newStart;
  const lines = h.lines.map((l) => {
    const old = l.old ?? (l.t !== "+" ? oldNo : undefined);
    const nw = l.new ?? (l.t !== "-" ? newNo : undefined);
    if (l.t !== "+") oldNo = (old ?? oldNo) + 1;
    if (l.t !== "-") newNo = (nw ?? newNo) + 1;
    let html: string;
    if (l.t === "-") html = oh[oi++];
    else if (l.t === "+") html = nh[ni++];
    else { html = nh[ni++]; oi++; }
    return { t: l.t, old, new: nw, html };
  });

  const noted = (i: number) => {
    const l = lines[i];
    return l.t !== "-" && l.new != null && notes.has(l.new);
  };

  const rows: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    // unchanged run
    if (lines[i].t === " ") {
      let j = i;
      while (j < lines.length && lines[j].t === " ") j++;
      const len = j - i;
      const fid = `${hi}:${i}`;
      const hasNote = lines.slice(i, j).some((_, k) => noted(i + k));
      if (len > CONTEXT_FOLD && !hasNote && !open.has(fid)) {
        const keepHead = i === 0 ? 0 : CONTEXT_KEEP;
        const keepTail = j === lines.length ? 0 : CONTEXT_KEEP;
        for (let k = i; k < i + keepHead; k++) pushLine(k);
        rows.push({ k: "fold", id: fid, count: len - keepHead - keepTail });
        for (let k = j - keepTail; k < j; k++) pushLine(k);
      } else for (let k = i; k < j; k++) pushLine(k);
      i = j;
    } else pushLine(i++);
  }
  function pushLine(k: number) {
    const l = lines[k];
    const ns = l.t !== "-" && l.new != null ? notes.get(l.new) : undefined;
    rows.push({ k: "line", ...l, noteIdx: ns?.[0].n });
    ns?.forEach((x) => rows.push({ k: "note", n: x.n, note: x.note }));
  }

  const mid = `more:${hi}`;
  const lineRows = rows.filter((r) => r.k === "line").length;
  if (lineRows > HUNK_MAX && !open.has(mid)) {
    let seen = 0, cut = rows.length;
    for (let r = 0; r < rows.length; r++) if (rows[r].k === "line" && ++seen === HUNK_MAX * 0.6) { cut = r + 1; break; }
    const rest = rows.slice(cut).filter((r) => r.k === "line").length;
    return [...rows.slice(0, cut), { k: "more", id: mid, count: rest }];
  }
  return rows;
}

export function DiffView(props: {
  path: string; oldPath?: string; hunks: Hunk[]; notes?: DiffNote[]; change: Change;
  additions?: number; deletions?: number; mechanical?: boolean; binary?: boolean;
  defaultOpen?: boolean; anchorId?: string;
}) {
  const { path, oldPath, hunks, notes = [], change } = props;
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const lang = langOf(path);
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent).detail === path) setOpen(true); };
    window.addEventListener("recap:reveal", on);
    return () => window.removeEventListener("recap:reveal", on);
  }, [path]);

  const add = props.additions ?? hunks.reduce((a, h) => a + h.lines.filter((l) => l.t === "+").length, 0);
  const del = props.deletions ?? hunks.reduce((a, h) => a + h.lines.filter((l) => l.t === "-").length, 0);

  const noteMap = useMemo(() => {
    const m = new Map<number, { n: number; note: string }[]>();
    [...notes].sort((a, b) => a.line - b.line).forEach((x, i) => {
      m.set(x.line, [...(m.get(x.line) ?? []), { n: i + 1, note: x.note }]);
    });
    return m;
  }, [notes]);

  const hunkData = useMemo(
    () => (open ? hunks.map((h, hi) => hunkRows(h, hi, lang, noteMap, expanded)) : []),
    [hunks, lang, noteMap, expanded, open],
  );
  const expand = (id: string) => setExpanded((s) => new Set(s).add(id));
  const letter = oldPath && oldPath !== path ? "R" : change === "added" ? "A" : change === "removed" ? "D" : "M";

  return (
    <div className={cx("diff", open && "open", props.mechanical && "mech")} id={props.anchorId ?? diffId(path)} data-diff-path={path}>
      <button className="diff-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevron"} size={14} className="diff-chev" />
        <span className={cx("fletter", `fl-${letter}`)}>{letter}</span>
        <span className="diff-path">
          {oldPath && oldPath !== path && <span className="diff-old">{oldPath} → </span>}
          {path}
        </span>
        {props.mechanical && <span className="tag">mechanical</span>}
        {notes.length > 0 && <span className="tag note-count"><Icon name="comment" size={11} /> {notes.length}</span>}
        <span className="diff-stats"><AddDel add={add} del={del} /><ChurnBar add={add} del={del} /></span>
      </button>
      {open && (
        <div className="diff-body">
          {props.binary ? <div className="diff-empty">Binary file</div> : hunks.length === 0 ? (
            <div className="diff-empty">No hunks</div>
          ) : (
            <table className="diff-table">
              <tbody>
                {hunks.map((h, hi) => (
                  <Fragment key={hi}>
                    <tr className="hunk-head">
                      <td className="ln" colSpan={2}><Icon name="layers" size={11} /></td>
                      <td className="hunk-text">{h.header}</td>
                    </tr>
                    {hunkData[hi].map((r, ri) => {
                      if (r.k === "line")
                        return (
                          <tr key={ri} className={cx("dl", r.t === "+" ? "add" : r.t === "-" ? "del" : "ctx", r.noteIdx != null && "has-note")}>
                            <td className="ln">{r.t !== "+" ? r.old : ""}</td>
                            <td className="ln">{r.t !== "-" ? r.new : ""}</td>
                            <td className="code-line hljs">
                              <span className="sign">{r.t === " " ? " " : r.t === "-" ? "−" : "+"}</span>
                              <span dangerouslySetInnerHTML={{ __html: r.html || " " }} />
                              {r.noteIdx != null && <span className="note-marker">{r.noteIdx}</span>}
                            </td>
                          </tr>
                        );
                      if (r.k === "note")
                        return (
                          <tr key={ri} className="dnote">
                            <td className="ln" colSpan={2} />
                            <td>
                              <div className="dnote-box"><span className="note-marker">{r.n}</span><Markdown md={r.note} inline /></div>
                            </td>
                          </tr>
                        );
                      return (
                        <tr key={ri} className="dfold">
                          <td className="ln" colSpan={2}><Icon name="chevronDown" size={12} /></td>
                          <td><button onClick={() => expand(r.id)}>
                            {r.k === "fold" ? `Expand ${r.count} unchanged lines` : `Show ${r.count} more lines`}
                          </button></td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export function DiffBlock({ block }: { block: B<"diff"> }) {
  const { doc } = useViewer();
  const f = doc.files.find((x) => x.path === block.file);
  const hunks = block.hunks.length ? block.hunks : f?.hunks ?? [];
  const whole = !block.hunks.length || block.hunks.length === f?.hunks.length;
  return (
    <DiffView path={block.file} oldPath={f?.oldPath} hunks={hunks} notes={block.notes} change={block.change ?? f?.change}
      additions={whole ? f?.additions : undefined} deletions={whole ? f?.deletions : undefined}
      binary={f?.binary} mechanical={f?.mechanical} />
  );
}

export function FileDiff({ file, defaultOpen }: { file: FileChange; defaultOpen?: boolean }) {
  return (
    <DiffView path={file.path} oldPath={file.oldPath} hunks={file.hunks} change={file.change}
      additions={file.additions} deletions={file.deletions} mechanical={file.mechanical} binary={file.binary}
      defaultOpen={defaultOpen} />
  );
}
