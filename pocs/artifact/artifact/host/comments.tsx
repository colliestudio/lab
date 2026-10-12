import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Answer, DecisionRow } from "../kit/feedback.ts";
import { contextOf, labelFor, norm, textOf, textRange, whereFor } from "./anchor.ts";

/**
 * What a comment is about. `id` (a data-aid, id or CSS path, plus `~"quote"` for selections) is hidden re-anchoring data; readers see
 * `label` (a human description of the element), `where` (the Section/Slide it sits in) and, for a text selection, `quote`
 * with the text just `before`/`after` it (so the same words elsewhere are not confused with it).
 */
export interface StoredAnchor { id: string; label: string; excerpt: string; page?: string; where?: string; quote?: string; before?: string; after?: string }
export interface Anchor extends Omit<StoredAnchor, "page"> { el: HTMLElement; range?: Range }
export interface Comment { id: string; anchor: StoredAnchor; body: string; created: string; /** set when the text was changed after it was written */ edited?: string }

const SEL = "[data-aid], [data-c], [data-section] > .a-h, p, li, pre, blockquote, h1, h2, h3, h4, figure, tr, td, th";
const short = (s: string, n = 70) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

function idFor(node: HTMLElement, root: HTMLElement): string {
  const explicit = node.dataset.aid ?? node.dataset.section;
  if (explicit) return explicit;
  const sec = node.closest<HTMLElement>("[data-section]");
  const kind = node.dataset.c ?? node.tagName.toLowerCase();
  const same = [...(sec ?? root).querySelectorAll<HTMLElement>(node.dataset.c ? `[data-c="${node.dataset.c}"]` : node.tagName)];
  return `${sec?.dataset.section ?? "page"}/${kind}-${same.indexOf(node) + 1}`;
}

const anchorNode = (el: HTMLElement) => (el.matches("[data-section] > .a-h") ? el.parentElement! : el); // a section's heading anchors the section

/** A CSS path from the root to a node: stops at the nearest id/data-aid, else tag:nth-of-type steps. Stable while the markup is. */
function pathTo(node: HTMLElement, root: HTMLElement): string {
  const parts: string[] = [];
  let anchored = false;
  for (let e: HTMLElement | null = node; e && e !== root; e = e.parentElement) {
    if (e.id && !e.id.startsWith(":")) { parts.unshift(`#${CSS.escape(e.id)}`); anchored = true; break; }
    if (e.dataset.aid) { parts.unshift(`[data-aid="${CSS.escape(e.dataset.aid)}"]`); anchored = true; break; }
    const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e!.tagName) : [e];
    parts.unshift(`${e.tagName.toLowerCase()}:nth-of-type(${same.indexOf(e) + 1})`);
  }
  return (anchored ? "" : ":scope > ") + parts.join(" > ");
}
const QUOTE = '~"';

/** The nearest block-level element at or above the target inside the root (a blank page has no Sections to lean on). */
function blockOf(target: HTMLElement, root: HTMLElement): HTMLElement | null {
  let e: HTMLElement | null = target;
  const svg = e.closest("svg");
  if (svg && root.contains(svg)) e = svg as unknown as HTMLElement;
  while (e && e !== root && getComputedStyle(e).display.startsWith("inline")) e = e.parentElement;
  return e && e !== root && root.contains(e) ? e : null;
}

/**
 * The element a click means and a stable id for it: its own `id`/data-aid, else section + tag + position.
 * With `any` (blank-page artifacts) any element qualifies, identified by a CSS path from the content root.
 */
export function anchorFor(target: HTMLElement, root: HTMLElement, any = false): Anchor | null {
  const el = target.closest<HTMLElement>(SEL);
  if (el && root.contains(el)) {
    const node = anchorNode(el);
    const id = idFor(node, root);
    return { id, label: labelFor(node), where: whereFor(node, root), excerpt: short(textOf(node)), el: node };
  }
  if (!any) return null;
  const b = blockOf(target, root);
  if (!b) return null;
  const id = b.dataset.aid ?? (b.id && !b.id.startsWith(":") ? b.id : "~" + pathTo(b, root));
  return { id, label: labelFor(b), where: whereFor(b, root), excerpt: short(b.getAttribute("aria-label") || textOf(b) || b.getAttribute("alt") || b.tagName.toLowerCase()), el: b };
}

/** An anchor for selected text: the element holding it, the quote and the words around it (`<element id>~"the quote"`). */
export function quoteAnchor(sel: Selection, root: HTMLElement, any = true): Anchor | null {
  const text = norm(sel.toString());
  if (text.length < 2 || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const n = range.commonAncestorContainer;
  const host = (n.nodeType === 1 ? n : n.parentElement) as HTMLElement | null;
  if (!host || !root.contains(host) || host.closest(".h-panel, .h-composer, .h-corner, .h-selbtn, .h-pop")) return null;
  const base = anchorFor(host, root, any);
  if (!base) return null;
  const id = `${base.id}${QUOTE}${text.slice(0, 80)}"`;
  const ctx = contextOf(range, base.el);
  return { id, label: base.label, where: base.where, excerpt: short(text, 120), quote: text, before: ctx.before, after: ctx.after, el: base.el, range: range.cloneRange() };
}

/** Where an anchor is on the page now: its element, and the exact text range for a quote (found by quote + context, else the element only). */
export function locate(root: HTMLElement, a: Pick<StoredAnchor, "id" | "quote" | "before" | "after">): { el: HTMLElement | null; range: Range | null } {
  const el = findAnchor(root, a.id);
  if (!a.quote) return { el, range: null };
  const range = (el && textRange(el, a.quote, a.before, a.after)) || textRange(root, a.quote, a.before, a.after);
  return { el: el ?? (range ? (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement) as HTMLElement : null), range };
}

/** What readers see for a comment: "Page › Section" and the quote or element label. */
export function describe(a: StoredAnchor, pageTitle?: string): { crumb: string; main: string; quote?: string } {
  const label = a.label && a.label !== a.id ? a.label : a.excerpt ? `"${short(a.excerpt, 60)}"` : "element";
  return { crumb: [pageTitle, a.where].filter(Boolean).join(" › "), main: a.quote ? `"${short(a.quote, 120)}"` : label, quote: a.quote };
}

/** The element an anchor id points at (also after a reload, when auto ids have to be recomputed). */
export function findAnchor(root: HTMLElement, id: string): HTMLElement | null {
  const q = id.indexOf(QUOTE);
  if (q > 0) id = id.slice(0, q);
  if (id.startsWith("~")) { try { return root.querySelector<HTMLElement>(id.slice(1)); } catch { return null; } }
  for (const e of root.querySelectorAll<HTMLElement>("[data-aid],[data-section]")) if ((e.dataset.aid ?? e.dataset.section) === id) return e;
  for (const e of root.querySelectorAll<HTMLElement>(SEL)) {
    const n = anchorNode(e);
    if (!n.dataset.aid && !n.dataset.section && idFor(n, root) === id) return n;
  }
  try { if (/^[A-Za-z][\w-]*$/.test(id)) { const e = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`); if (e) return e; } } catch { /* not a selector */ }
  return null;
}

/**
 * Where feedback lives: comments and decision answers. localStorage is the only implementation today; a hosted backend can
 * supply its own object (set `window.artifactComments` before the page script runs). Answer methods are optional there
 * (missing ones fall back to local storage).
 */
export interface CommentStore {
  list(): Comment[]; add(c: Comment): void; remove(id: string): void; clear(): void;
  /** change a comment in place (its anchor, id and position stay); a backend implements it as a PATCH */
  update(id: string, patch: Partial<Pick<Comment, "body" | "edited">>): void;
}
export interface AnswerStore {
  answers(): Record<string, Answer>; setAnswer(id: string, a: Answer | null): void; clearAnswers(): void;
  /** change part of an existing answer (the note, the choice); no-op when there is none */
  updateAnswer(id: string, patch: Partial<Answer>): void;
}
export type FeedbackStore = CommentStore & AnswerStore;

export function localCommentStore(key: string): FeedbackStore {
  const k = "artifact-comments:" + key, ak = "artifact-answers:" + key;
  const load = (): Comment[] => { try { return JSON.parse(localStorage.getItem(k) ?? "[]"); } catch { return []; } };
  const save = (l: Comment[]) => localStorage.setItem(k, JSON.stringify(l));
  const loadA = (): Record<string, Answer> => { try { return JSON.parse(localStorage.getItem(ak) ?? "{}"); } catch { return {}; } };
  return {
    list: load, add: (c) => save([...load(), c]), update: (id, patch) => save(load().map((c) => (c.id === id ? { ...c, ...patch } : c))), remove: (id) => save(load().filter((c) => c.id !== id)), clear: () => localStorage.removeItem(k),
    answers: loadA,
    setAnswer: (id, a) => { const m = loadA(); if (a) m[id] = a; else delete m[id]; localStorage.setItem(ak, JSON.stringify(m)); },
    clearAnswers: () => localStorage.removeItem(ak),
    updateAnswer: (id, patch) => { const m = loadA(); if (m[id]) { m[id] = { ...m[id], ...patch }; localStorage.setItem(ak, JSON.stringify(m)); } },
  };
}

export function makeStore(key: string): FeedbackStore {
  const local = localCommentStore(key);
  const custom = (window as unknown as { artifactComments?: Partial<FeedbackStore> }).artifactComments;
  const store = { ...local, ...(custom ?? {}) } as FeedbackStore;
  // a backend written before edits existed: rewrite through the methods it has (the comment moves to the end of its list)
  if (custom && !custom.update) store.update = (id, patch) => { const c = store.list().find((x) => x.id === id); if (c) { store.remove(id); store.add({ ...c, ...patch }); } };
  if (custom && !custom.updateAnswer) store.updateAnswer = (id, patch) => { const a = store.answers()[id]; if (a) store.setAnswer(id, { ...a, ...patch }); };
  return store;
}

export function useComments(store: FeedbackStore) {
  const [list, setList] = useState<Comment[]>(() => store.list());
  return {
    list,
    add: (a: Anchor, body: string, page?: string) => {
      const { el: _e, range: _r, ...rest } = a;
      store.add({ id: "c" + Date.now().toString(36), anchor: { ...rest, ...(page ? { page } : {}) }, body, created: new Date().toISOString() });
      setList(store.list());
    },
    edit: (id: string, body: string) => { store.update(id, { body, edited: new Date().toISOString() }); setList(store.list()); },
    remove: (id: string) => { store.remove(id); setList(store.list()); },
    clear: () => { store.clear(); setList(store.list()); },
  };
}

const changed = (a: Answer, b: Answer) => a.choice !== b.choice || a.label !== b.label || (a.custom ?? "") !== (b.custom ?? "") || (a.note ?? "") !== (b.note ?? "");

export function useAnswerState(store: FeedbackStore) {
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => store.answers());
  return {
    answers,
    // answering again with something different is an edit: the reader sees "edited" and the earlier mark is kept
    answer: (id: string, a: Answer | null) => {
      const prev = store.answers()[id];
      const next = a && prev ? { ...a, ...(prev.edited ? { edited: prev.edited } : {}), ...(changed(prev, a) ? { edited: new Date().toISOString() } : {}) } : a;
      store.setAnswer(id, next); setAnswers(store.answers());
    },
    editNote: (id: string, note: string) => { store.updateAnswer(id, { note: note.trim() || undefined, edited: new Date().toISOString() }); setAnswers(store.answers()); },
    clear: () => { store.clearAnswers(); setAnswers(store.answers()); },
  };
}

/** `- [Page › Section] on "quoted text": the comment` per comment, in the order given. */
export function feedbackMarkdown(title: string, list: Comment[], pageTitle?: (id?: string) => string | undefined): string {
  const lines = [`# Feedback on "${title}"`, ""];
  for (const c of list) {
    const d = describe(c.anchor, pageTitle?.(c.anchor.page));
    const [first, ...rest] = c.body.trim().split("\n");
    lines.push(`- ${d.crumb ? `[${d.crumb}] ` : ""}on ${d.main}: ${first}`);
    for (const l of rest) lines.push(`  ${l}`);
  }
  return lines.join("\n") + "\n";
}

export function Composer({ anchor, onSave, onCancel, existing, pageTitle }: { anchor: Anchor; onSave: (b: string) => void; onCancel: () => void; existing: Comment[]; pageTitle?: string }) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const r = (anchor.range?.getBoundingClientRect().height ? anchor.range.getBoundingClientRect() : anchor.el.getBoundingClientRect());
  const d = describe(anchor, pageTitle);
  const top = Math.min(innerHeight - 220, Math.max(56, r.bottom + 8)), left = Math.min(innerWidth - 360, Math.max(8, r.left));
  return createPortal(
    <div className="h-composer" style={{ top, left }} role="dialog" aria-label="Add comment">
      <div className="h-composer-on">
        <div className="h-crumb">Commenting on{d.crumb ? ` · ${d.crumb}` : ""}</div>
        {anchor.quote ? <q className="h-quote">{short(anchor.quote, 160)}</q> : <div className="h-what">{d.main}</div>}
      </div>
      {existing.map((c) => <div key={c.id} className="h-composer-prev">{c.body}</div>)}
      <textarea ref={ref} value={body} rows={3} placeholder="Comment for the agent…" onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) onSave(body.trim()); if (e.key === "Escape") onCancel(); }} />
      <div className="h-composer-actions"><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!body.trim()} onClick={() => onSave(body.trim())}>Add (⌘↵)</button></div>
    </div>, document.body);
}

/** A small inline editor: Save (⌘↵) / Cancel (Esc). An empty note is allowed (it removes it); `required` blocks empty text. */
function Editor({ initial, label, rows = 3, required, onSave, onCancel }: { initial: string; label: string; rows?: number; required?: boolean; onSave: (t: string) => void; onCancel: () => void }) {
  const [t, setT] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const e = ref.current; if (e) { e.focus(); e.setSelectionRange(e.value.length, e.value.length); } }, []);
  const ok = !required || !!t.trim();
  return (
    <div className="h-editor">
      <textarea ref={ref} value={t} rows={rows} aria-label={label}
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ok) onSave(t.trim()); if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
      <div className="h-composer-actions"><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!ok} onClick={() => onSave(t.trim())}>Save (⌘↵)</button></div>
    </div>
  );
}

/** Every decision with its answer: question, the choice, recommended or not, the note. Used in the drawer and on the Summary slide. */
export function DecisionList({ rows, onJump, onEditNote }: { rows: DecisionRow[]; onJump?: (r: DecisionRow) => void; onEditNote?: (r: DecisionRow, note: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const multi = new Set(rows.map((r) => r.page).filter(Boolean)).size > 1;
  return (
    <ol className="h-decisions">
      {rows.map((r, i) => {
        const a = r.answer;
        return (
          <li key={r.id} className={a ? "done" : "todo"}>
            {multi && r.page !== rows[i - 1]?.page && <div className="h-pagehead">{r.pageTitle ?? r.page}</div>}
            <button className="h-note-on" onClick={() => onJump?.(r)} title="Jump to the decision">{r.id}</button>
            <div className="h-d-q">{r.question}</div>
            {a ? (
              <div className="h-d-a">
                <b>{a.choice === "unsure" ? "Not sure / discuss" : a.choice === "other" ? `Own answer: ${a.custom ?? a.label}` : a.label}</b>
                {a.choice !== "unsure" && a.choice !== "other" && <span className={a.rec ? "h-tag ok" : "h-tag diff"}>{a.rec ? "recommended" : r.recommended ? "differs from the recommendation" : "chosen"}</span>}
                {editing === r.id ? (
                  <Editor initial={a.note ?? ""} label="Note" rows={2} onSave={(t) => { onEditNote?.(r, t); setEditing(null); }} onCancel={() => setEditing(null)} />
                ) : a.note && <div className="a-muted">Note: {a.note}</div>}
                {a.edited && <span className="h-edited" title={`Edited ${new Date(a.edited).toLocaleString()}`}>edited</span>}
                {onEditNote && editing !== r.id && (
                  <div className="h-row-actions">
                    <button className="h-link" onClick={() => setEditing(r.id)}>{a.note ? "Edit note" : "Add note"}</button>
                    <button className="h-link" onClick={() => onJump?.(r)} title="Go to the decision to change the choice">Change answer</button>
                  </div>
                )}
              </div>
            ) : <div className="h-d-a a-muted">not decided{r.recommended ? ` · recommended: ${r.recommended}` : ""}</div>}
          </li>
        );
      })}
    </ol>
  );
}

export function FeedbackPanel({ cm, rows, tab, setTab, mode, onMode, copied, onCopyComments, onCopyDecisions, onCopyAll, onClearAnswers, onEditNote, onJumpDecision, onJumpComment, onHover, pageTitle, onClose }: {
  cm: ReturnType<typeof useComments>; rows: DecisionRow[]; tab: "decisions" | "comments"; setTab: (t: "decisions" | "comments") => void;
  mode: boolean; onMode: () => void; copied: string; onCopyComments: () => void; onCopyDecisions: () => void; onCopyAll: () => void;
  onClearAnswers: () => void; onEditNote: (r: DecisionRow, note: string) => void; onJumpDecision: (r: DecisionRow) => void; onJumpComment: (c: Comment) => void; onHover: (c: Comment | null) => void; pageTitle: (id?: string) => string | undefined; onClose: () => void;
}) {
  const [sure, setSure] = useState<"" | "comments" | "answers">("");
  useEffect(() => { if (!sure) return; const t = setTimeout(() => setSure(""), 3000); return () => clearTimeout(t); }, [sure]);
  const [editing, setEditing] = useState<string | null>(null);
  const decided = rows.filter((r) => r.answer).length;
  return (
    <aside className="h-panel" aria-label="Feedback">
      <div className="h-panel-head"><b>Feedback</b><button onClick={onClose} aria-label="Close feedback">×</button></div>
      <div className="h-tabs" role="tablist">
        {rows.length > 0 && <button role="tab" aria-selected={tab === "decisions"} onClick={() => setTab("decisions")}>Decisions {decided}/{rows.length}</button>}
        <button role="tab" aria-selected={tab === "comments" || rows.length === 0} onClick={() => setTab("comments")}>Comments ({cm.list.length})</button>
      </div>
      {tab === "decisions" && rows.length > 0 ? (
        <>
          <div className="h-panel-actions h-panel-fixed">
            <button className="h-btn" disabled={!decided} onClick={onCopyDecisions} title="Copy every decision and its answer as Markdown to paste back to the author or agent">{copied === "decisions" ? "Copied" : "Copy decisions"}</button>
            <button className="h-btn" disabled={!decided && !cm.list.length} onClick={onCopyAll} title="Copy decisions and comments together">{copied === "all" ? "Copied" : "Copy all feedback"}</button>
            <button className="h-btn" disabled={!decided} onClick={() => { if (sure === "answers") { onClearAnswers(); setSure(""); } else setSure("answers"); }}>{sure === "answers" ? "Click again to clear" : "Clear answers"}</button>
          </div>
          <div className="h-panel-body" tabIndex={0} role="region" aria-label="Decisions">
            <DecisionList rows={rows} onJump={onJumpDecision} onEditNote={onEditNote} />
          </div>
        </>
      ) : (
        <>
          <div className="h-panel-actions h-panel-fixed">
            <button className="h-btn" aria-pressed={mode} onClick={onMode} title="Comment mode (c): click any element on the page to leave a comment">{mode ? "Click an element…" : "Add comment"}</button>
            <button className="h-btn" onClick={onCopyComments} disabled={!cm.list.length} title="Copy all comments as Markdown to paste back to the author or agent">{copied === "comments" ? "Copied" : "Copy comments"}</button>
            {rows.length > 0 && <button className="h-btn" onClick={onCopyAll} disabled={!decided && !cm.list.length} title="Copy decisions and comments together">{copied === "all" ? "Copied" : "Copy all feedback"}</button>}
            <button className="h-btn" disabled={!cm.list.length} onClick={() => { if (sure === "comments") { cm.clear(); setSure(""); } else setSure("comments"); }} title="Delete every comment on this page (stored in this browser)">{sure === "comments" ? "Click again to clear" : "Clear all"}</button>
          </div>
          <div className="h-panel-body" tabIndex={0} role="region" aria-label="Comments">
          {cm.list.length === 0 && <p className="a-muted">Nothing yet. Select text or alt-click anything on the page to comment.</p>}
          {cm.list.map((c, i) => {
            const d = describe(c.anchor, undefined);
            return (
              <div key={c.id} className="h-note" onMouseEnter={() => onHover(c)} onMouseLeave={() => onHover(null)}>
                {c.anchor.page && c.anchor.page !== cm.list[i - 1]?.anchor.page && <div className="h-pagehead">{pageTitle(c.anchor.page) ?? c.anchor.page}</div>}
                {d.crumb && <div className="h-note-crumb">{d.crumb}</div>}
                <button className="h-note-on" onClick={() => onJumpComment(c)} title="Show it on the page">{d.quote ? <q>{short(d.quote, 120)}</q> : d.main}</button>
                {editing === c.id
                  ? <Editor initial={c.body} label="Comment" required onSave={(t) => { if (t !== c.body.trim()) cm.edit(c.id, t); setEditing(null); }} onCancel={() => setEditing(null)} />
                  : <div className="h-note-body">{c.body}</div>}
                {editing !== c.id && (
                  <div className="h-row-actions">
                    {c.edited && <span className="h-edited" title={`Edited ${new Date(c.edited).toLocaleString()}`}>edited</span>}
                    <button className="h-link" onClick={() => setEditing(c.id)}>Edit</button>
                    <button className="h-link" onClick={() => cm.remove(c.id)}>Delete</button>
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </>
      )}
    </aside>
  );
}
