import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface Anchor { id: string; label: string; excerpt: string; el: HTMLElement }
export interface Comment { id: string; anchor: { id: string; label: string; excerpt: string }; body: string; created: string }

const SEL = "[data-aid], [data-c], [data-section] > .a-h, p, li, pre, blockquote, h1, h2, h3, h4, figure, tr, td, th";
const short = (s: string, n = 70) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** The element a click means (closest candidate) and a stable id for it: its own `id`/data-aid, else section + tag + position. */
export function anchorFor(target: HTMLElement, root: HTMLElement): Anchor | null {
  const el = target.closest<HTMLElement>(SEL);
  if (!el || !root.contains(el)) return null;
  const node = el.matches("[data-section] > .a-h") ? el.parentElement! : el; // a section's heading anchors the section
  const explicit = node.dataset.aid ?? node.dataset.section;
  const kind = node.dataset.c ?? node.tagName.toLowerCase();
  let id = explicit;
  if (!id) {
    const sec = node.closest<HTMLElement>("[data-section]");
    const same = [...(sec ?? root).querySelectorAll<HTMLElement>(node.dataset.c ? `[data-c="${node.dataset.c}"]` : node.tagName)];
    id = `${sec?.dataset.section ?? "page"}/${kind}-${same.indexOf(node) + 1}`;
    node.dataset.hid = id;
  }
  return { id, label: id, excerpt: short(node.textContent ?? ""), el: node };
}

export function useComments(key: string) {
  const k = "artifact-comments:" + key;
  const [list, setList] = useState<Comment[]>(() => { try { return JSON.parse(localStorage.getItem(k) ?? "[]"); } catch { return []; } });
  const save = (l: Comment[]) => { setList(l); localStorage.setItem(k, JSON.stringify(l)); };
  return {
    list,
    add: (a: Anchor, body: string) => save([...list, { id: "c" + Date.now().toString(36), anchor: { id: a.id, label: a.label, excerpt: a.excerpt }, body, created: new Date().toISOString() }]),
    remove: (id: string) => save(list.filter((c) => c.id !== id)),
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

export function CommentsPanel({ cm, onClose }: { cm: ReturnType<typeof useComments>; onClose: () => void }) {
  return (
    <aside className="h-panel" aria-label="Comments">
      <div className="h-panel-head"><b>Notes</b><button onClick={onClose} aria-label="Close">×</button></div>
      {cm.list.length === 0 && <p className="a-muted">Nothing yet. Turn on Comment, then click any element.</p>}
      {cm.list.map((c) => (
        <div key={c.id} className="h-note">
          <button className="h-note-on" onClick={() => { const e = document.querySelector(`[data-hid="${CSS.escape(c.anchor.id)}"], [data-aid="${CSS.escape(c.anchor.id)}"], [data-section="${CSS.escape(c.anchor.id)}"]`); e?.scrollIntoView({ block: "center", behavior: "smooth" }); }}>{c.anchor.id}</button>
          <div>{c.body}</div>
          <button className="h-note-del" onClick={() => cm.remove(c.id)}>Delete</button>
        </div>
      ))}
    </aside>
  );
}
