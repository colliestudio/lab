import { useState, type ReactNode } from "react";
import type { Comment } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { Icon } from "./icons.tsx";
import { cx, fmtDate } from "../util.ts";

type Anchor = Comment["anchor"];
const same = (a: Anchor, b: Anchor) =>
  (a.section ?? null) === (b.section ?? null) && (a.block ?? null) === (b.block ?? null) &&
  (a.file ?? null) === (b.file ?? null) && (a.line ?? null) === (b.line ?? null);

/** Wraps a section header or block: hover shows a comment button (when an API exists); existing comments render below. */
export function Commentable({ anchor, children, className }: { anchor: Anchor; children: ReactNode; className?: string }) {
  const { api, comments } = useViewer();
  const [composing, setComposing] = useState(false);
  const mine = comments.filter((c) => same(c.anchor, anchor));
  return (
    <div className={cx("commentable", className)}>
      {api && (
        <button className={cx("c-btn", mine.length > 0 && "has")} title="Comment" onClick={() => setComposing(true)}>
          <Icon name="comment" size={13} />{mine.length > 0 && <span>{mine.length}</span>}
        </button>
      )}
      {children}
      {(mine.length > 0 || composing) && (
        <div className="c-thread">
          {mine.map((c) => (
            <div key={c.id} className={cx("c-item", c.resolved && "resolved")}>
              <div className="c-meta"><b>{c.author}</b> <span>{fmtDate(c.created)}</span>{c.resolved && <span className="tag">resolved</span>}</div>
              <div className="c-body">{c.body}</div>
            </div>
          ))}
          {composing && <Composer anchor={anchor} onDone={() => setComposing(false)} />}
        </div>
      )}
    </div>
  );
}

function Composer({ anchor, onDone }: { anchor: Anchor; onDone: () => void }) {
  const { addComment } = useViewer();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try { await addComment({ anchor, body: body.trim() }); onDone(); }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  };
  return (
    <div className="c-compose">
      <textarea autoFocus value={body} placeholder="Leave a comment for the author…" rows={3}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === "Escape") onDone();
        }} />
      <div className="c-actions">
        {err && <span className="c-err">{err}</span>}
        <span className="muted">⌘↵ to send</span>
        <button className="btn ghost" onClick={onDone}>Cancel</button>
        <button className="btn primary" disabled={busy || !body.trim()} onClick={submit}>Comment</button>
      </div>
    </div>
  );
}
