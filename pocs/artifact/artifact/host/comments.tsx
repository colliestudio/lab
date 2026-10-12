import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface Anchor { id: string; label: string; excerpt: string; el: HTMLElement }
export interface Comment { id: string; anchor: { id: string; label: string; excerpt: string }; body: string; created: string }

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

/** The element a click means (closest candidate) and a stable id for it: its own `id`/data-aid, else section + tag + position. */
export function anchorFor(target: HTMLElement, root: HTMLElement): Anchor | null {
  const el = target.closest<HTMLElement>(SEL);
  if (!el || !root.contains(el)) return null;
  const node = anchorNode(el);
  const id = idFor(node, root);
  return { id, label: id, excerpt: short(node.textContent ?? ""), el: node };
}

/** The element an anchor id points at (also after a reload, when auto ids have to be recomputed). */
export function findAnchor(root: HTMLElement, id: string): HTMLElement | null {
  for (const e of root.querySelectorAll<HTMLElement>("[data-aid],[data-section]")) if ((e.dataset.aid ?? e.dataset.section) === id) return e;
  for (const e of root.querySelectorAll<HTMLElement>(SEL)) {
    const n = anchorNode(e);
    if (!n.dataset.aid && !n.dataset.section && idFor(n, root) === id) return n;
  }
  return null;
}

/**
 * Where comments live. localStorage is the only implementation today; a hosted backend can supply its own object
 * (set `window.artifactComments` before the page script runs) with the same four methods.
 */
export interface CommentStore { list(): Comment[]; add(c: Comment): void; remove(id: string): void; clear(): void }

export function localCommentStore(key: string): CommentStore {
  const k = "artifact-comments:" + key;
  const load = (): Comment[] => { try { return JSON.parse(localStorage.getItem(k) ?? "[]"); } catch { return []; } };
  const save = (l: Comment[]) => localStorage.setItem(k, JSON.stringify(l));
  return { list: load, add: (c) => save([...load(), c]), remove: (id) => save(load().filter((c) => c.id !== id)), clear: () => localStorage.removeItem(k) };
}

export function useComments(key: string, store: CommentStore = (window as unknown as { artifactComments?: CommentStore }).artifactComments ?? localCommentStore(key)) {
  const [list, setList] = useState<Comment[]>(() => store.list());
  return {
    list,
    add: (a: Anchor, body: string) => { store.add({ id: "c" + Date.now().toString(36), anchor: { id: a.id, label: a.label, excerpt: a.excerpt }, body, created: new Date().toISOString() }); setList(store.list()); },
    remove: (id: string) => { store.remove(id); setList(store.list()); },
    clear: () => { store.clear(); setList(store.list()); },
  };
}

export function feedbackMarkdown(title: string, list: Comment[]): string {
  const lines = [`# Feedback on "${title}"`, ""];
  for (const c of list) {
    lines.push(`- **${c.anchor.id}** — "${c.anchor.excerpt}"`);
    for (const l of c.body.trim().split("\n")) lines.push(`  ${l}`);
  }
  return lines.join("\n") + "\n";
}

export function Composer({ anchor, onSave, onCancel, existing }: { anchor: Anchor; onSave: (b: string) => void; onCancel: () => void; existing: Comment[] }) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const r = anchor.el.getBoundingClientRect();
  const top = Math.min(innerHeight - 220, Math.max(56, r.bottom + 8)), left = Math.min(innerWidth - 360, Math.max(8, r.left));
  return createPortal(
    <div className="h-composer" style={{ top, left }} role="dialog" aria-label="Add comment">
      <div className="h-composer-on"><b>{anchor.id}</b> {anchor.excerpt}</div>
      {existing.map((c) => <div key={c.id} className="h-composer-prev">{c.body}</div>)}
      <textarea ref={ref} value={body} rows={3} placeholder="Comment for the agent…" onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) onSave(body.trim()); if (e.key === "Escape") onCancel(); }} />
      <div className="h-composer-actions"><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!body.trim()} onClick={() => onSave(body.trim())}>Add (⌘↵)</button></div>
    </div>, document.body);
}

export function CommentsPanel({ cm, mode, onMode, onCopy, copied, onClose }: {
  cm: ReturnType<typeof useComments>; mode: boolean; onMode: () => void; onCopy: () => void; copied: string; onClose: () => void;
}) {
  const [sure, setSure] = useState(false);
  useEffect(() => { if (!sure) return; const t = setTimeout(() => setSure(false), 3000); return () => clearTimeout(t); }, [sure]);
  return (
    <aside className="h-panel" aria-label="Comments">
      <div className="h-panel-head"><b>Comments ({cm.list.length})</b><button onClick={onClose} aria-label="Close comments">×</button></div>
      <div className="h-panel-actions">
        <button className="h-btn" aria-pressed={mode} onClick={onMode} title="Comment mode (c): click any element on the page to leave a comment">{mode ? "Click an element…" : "Add comment"}</button>
        <button className="h-btn" onClick={onCopy} disabled={!cm.list.length} title="Copy all comments as Markdown to paste back to the author or agent">{copied || "Copy feedback"}</button>
        <button className="h-btn" disabled={!cm.list.length} onClick={() => { if (sure) { cm.clear(); setSure(false); } else setSure(true); }} title="Delete every comment on this page (stored in this browser)">{sure ? "Click again to clear" : "Clear all"}</button>
      </div>
      {cm.list.length === 0 && <p className="a-muted">Nothing yet. Press <kbd>c</kbd> or "Add comment", then click any element.</p>}
      {cm.list.map((c) => (
        <div key={c.id} className="h-note">
          <button className="h-note-on" onClick={() => { const root = document.querySelector<HTMLElement>(".a-content"); (root && findAnchor(root, c.anchor.id))?.scrollIntoView({ block: "center", behavior: "smooth" }); }} title="Jump to the element">{c.anchor.id}</button>
          <div>{c.body}</div>
          <button className="h-note-del" onClick={() => cm.remove(c.id)}>Delete</button>
        </div>
      ))}
    </aside>
  );
}
