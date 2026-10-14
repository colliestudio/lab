// Sharing without a server: comments kept in this browser (localStorage, per doc + version), the Feedback panel
// that copies them as Markdown for the author, and the copy helper (clipboard API, else a select-and-copy box).
import { useCallback, useEffect, useRef, useState } from "react";
import type { Comment, Doc } from "../../../src/model.ts";
import { anchorContext, feedbackMarkdown } from "../../../src/feedback.ts";
import { useViewer } from "../ctx.tsx";
import { Icon } from "./icons.tsx";
import { cx, fmtDate } from "../util.ts";

/** Doc id + version: kind, repo and title name the doc; head (else date) is the version. */
export const feedbackKey = (doc: Doc) =>
  `recap.feedback:${[doc.kind, doc.meta.repo ?? "", doc.title, doc.meta.head ?? doc.meta.date ?? ""].join("|")}`;

function load(key: string): Comment[] {
  try { const v = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function useLocalComments(doc: Doc, enabled: boolean) {
  const key = feedbackKey(doc);
  const [list, setList] = useState<Comment[]>(() => (enabled ? load(key) : []));
  useEffect(() => {
    if (!enabled) return;
    const on = (e: StorageEvent) => { if (e.key === key) setList(load(key)); };   // other tabs of the same file
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, [key, enabled]);
  const save = useCallback((next: Comment[]) => {
    setList(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage off: keep in memory */ }
  }, [key]);
  const add = useCallback((c: Omit<Comment, "id" | "created">) => {
    // re-read storage first: another tab of the same file may have added comments
    save([...load(key), { ...c, id: Math.random().toString(36).slice(2, 10), created: new Date().toISOString() }]);
  }, [key, save]);
  const remove = useCallback((id: string) => save(load(key).filter((c) => c.id !== id)), [key, save]);
  const clear = useCallback(() => save([]), [save]);
  return { list, add, remove, clear };
}

// ---- copy ----

export function useCopy() {
  const [fallback, setFallback] = useState<{ text: string; what: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const say = (m: string) => { setToast(m); clearTimeout(timer.current); timer.current = window.setTimeout(() => setToast(null), 1800); };
  const copy = useCallback((text: string, what: string) => {
    const clip = navigator.clipboard;
    if (!clip?.writeText) { setFallback({ text, what }); return; }
    clip.writeText(text).then(() => say(`${what} copied`), () => setFallback({ text, what }));
  }, []);
  const ui = (
    <>
      {toast && <div className="toast" role="status"><Icon name="check" size={14} /> {toast}</div>}
      {fallback && <CopyBox {...fallback} onClose={() => setFallback(null)} onCopied={() => { setFallback(null); say(`${fallback.what} copied`); }} />}
    </>
  );
  return { copy, ui };
}

function CopyBox({ text, what, onClose, onCopied }: { text: string; what: string; onClose: () => void; onCopied: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const copyNow = () => {
    ref.current?.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* unsupported */ }
    if (ok) onCopied();
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={`Copy ${what}`} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onClose(); }}>
        <div className="modal-head"><b>{what}</b><span className="muted">selected: press ⌘C / Ctrl+C</span>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button></div>
        <textarea ref={ref} className="copy-text" readOnly value={text} rows={16} />
        <div className="c-actions"><button className="btn" onClick={onClose}>Close</button><button className="btn primary" onClick={copyNow}>Copy</button></div>
      </div>
    </div>
  );
}

// ---- feedback panel ----

export function FeedbackPanel({ onClose, onClear }: { onClose: () => void; onClear: () => void }) {
  const { doc, comments, removeComment, copy, setFocus, setLevel } = useViewer();
  const go = (c: Comment) => {
    const a = c.anchor;
    if (a.section) setFocus(a.section);
    else setLevel(a.file ? 4 : 2);
  };
  return (
    <aside className="fb-panel" aria-label="Feedback">
      <div className="fb-head">
        <b>Feedback</b><span className="muted">{comments.length}</span>
        <span className="sec-spacer" />
        <button className="btn icon ghost" onClick={onClose} aria-label="Close feedback"><Icon name="x" size={14} /></button>
      </div>
      <p className="fb-hint muted">
        Comments stay in this browser. Hover a section, block or diff line number to add one; then <b>Copy feedback</b> and
        paste it to the author (or their agent: <code>recap comments &lt;bundle&gt; --import -</code>).
      </p>
      <div className="fb-list">
        {comments.length === 0 && <div className="fb-empty muted">No comments yet.</div>}
        {comments.map((c) => {
          const { label, quote } = anchorContext(doc, c.anchor);
          return (
            <div key={c.id} className="fb-item">
              <div className="fb-anchor">
                <button className="linklike" onClick={() => go(c)} title="Go there">{label}</button>
                <span className="muted small">{fmtDate(c.created)}</span>
                <button className="btn icon ghost fb-del" onClick={() => removeComment(c.id)} aria-label="Delete comment" title="Delete">
                  <Icon name="x" size={12} />
                </button>
              </div>
              {quote && <div className="fb-quote">{quote}</div>}
              <div className="c-body">{c.body}</div>
            </div>
          );
        })}
      </div>
      <div className="fb-foot">
        <button className="btn ghost small" disabled={!comments.length} onClick={() => { if (confirm("Delete all comments on this doc?")) onClear(); }}>Clear</button>
        <span className="sec-spacer" />
        <button className="btn primary" disabled={!comments.length} onClick={() => copy(feedbackMarkdown(doc, comments), "Feedback")}>
          <Icon name="copy" size={13} /> Copy feedback
        </button>
      </div>
    </aside>
  );
}

// ---- download (serve / server): the same single file `recap build` makes ----

const LEVEL_CHOICES = [
  { code: "key", label: "Key changes", note: "only the code the diff blocks show (default)" },
  { code: "none", label: "No code", note: "map, text and file list; smallest" },
  { code: "full", label: "All code", note: "every hunk of the patch" },
] as const;

export function DownloadMenu({ api }: { api: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, [open]);
  const get = async (code: string) => {
    setOpen(false); setBusy(true);
    try {
      const r = await fetch(`${api}/export?code=${code}`);
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `export failed: ${r.status}`);
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "doc.html";
      const url = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const warn = r.headers.get("x-recap-size-warning");
      if (warn) alert(warn);
    } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="dl-menu" ref={ref}>
      <button className={cx("btn small", open && "on")} onClick={() => setOpen(!open)} disabled={busy}
        title="Download one offline HTML file of this doc" aria-haspopup="menu" aria-expanded={open}>
        <Icon name="download" size={13} /> {busy ? "Building…" : "Download"}
      </button>
      {open && (
        <div className="dl-pop" role="menu">
          {LEVEL_CHOICES.map((c) => (
            <button key={c.code} role="menuitem" className="dl-item" onClick={() => get(c.code)}>
              <b>{c.label}</b><span className="muted">{c.note}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
