import { isValidElement, useState, type ReactNode } from "react";
import { Badge } from "./layout.tsx";
import { FeedbackCtx, keyOfIndex, matchesAnswer, nodeText, useAnswer, type Want } from "./feedback.ts";
import { cx, slug } from "./util.ts";
import { useContext } from "react";

type Opt = ReactNode | { label: ReactNode; note?: ReactNode; key?: string };
const asOpt = (o: Opt) => (o && typeof o === "object" && !isValidElement(o) && "label" in (o as object) ? (o as { label: ReactNode; note?: ReactNode; key?: string }) : { label: o as ReactNode, note: undefined as ReactNode, key: undefined as string | undefined });

/**
 * A decision someone must make: options, a recommendation, who has to decide.
 * In a host the reader can answer it: pick an option, write their own, or mark "not sure / discuss", with a note.
 * Answers show in the Feedback drawer and can be copied back as Markdown; `<When decision="id" is="a">` branches on them.
 * Options may carry a `key` (default a, b, c…).
 */
export function Decision({ question, options, recommend, owner = "needs a decision", why, id, source }: {
  question: ReactNode; options?: Opt[]; recommend?: number | string;
  owner?: string; why?: ReactNode; id?: string; source?: ReactNode;
}) {
  const ctx = useContext(FeedbackCtx);
  const qText = nodeText(question);
  const did = id ?? (slug(qText).slice(0, 48) || "decision");
  const ans = useAnswer(did);
  const opts = (options ?? []).map((o, i) => { const x = asOpt(o); return { ...x, key: x.key ?? keyOfIndex(i), text: nodeText(x.label) }; });
  const isRec = (i: number) => recommend === i || (typeof recommend === "string" && (recommend === opts[i].text || recommend === opts[i].key));
  const recIdx = opts.findIndex((_, i) => isRec(i));
  const recText = recIdx >= 0 ? opts[recIdx].text : undefined;
  const [other, setOther] = useState(false);
  const [draft, setDraft] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const save = (choice: string, label: string, extra: { custom?: string; rec?: boolean } = {}) =>
    ctx.answer(did, { choice, label, ...extra, note: ans?.note, at: new Date().toISOString() });
  return (
    <div className={cx("a-decision", ans && "answered")} data-c="decision" id={id} data-aid={id} data-did={did} data-q={qText} data-owner={owner} data-rec={recText}>
      <div className="a-decision-head"><Badge tone={ans ? "success" : "warn"}>{ans ? "decided" : owner}</Badge>{source && <span className="a-muted"> recommendation: {source}</span>}</div>
      <div className="a-decision-q">{question}</div>
      {why && <div className="a-muted">{why}</div>}
      {opts.length > 0 && (
        <ul className="a-options" role={ctx.interactive ? "radiogroup" : undefined}>{opts.map((o, i) => {
          const rec = isRec(i), picked = ans?.choice === o.key;
          const body = <><span>{o.label}{o.note && <span className="a-muted"> {o.note}</span>}</span>{rec && <Badge tone="success">recommended</Badge>}</>;
          return ctx.interactive
            ? <li key={i} className={cx(rec && "rec", picked && "picked")}><button role="radio" aria-checked={picked} onClick={() => { setOther(false); save(o.key, o.text, { rec }); }}>{body}</button></li>
            : <li key={i} className={cx(rec && "rec")}>{body}</li>;
        })}</ul>
      )}
      {ctx.interactive && (
        <div className="a-decision-more">
          {other ? (
            <span className="a-decision-other">
              <input autoFocus value={draft} placeholder="Your own answer…" onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { save("other", draft.trim(), { custom: draft.trim() }); setOther(false); } if (e.key === "Escape") setOther(false); }} />
              <button disabled={!draft.trim()} onClick={() => { save("other", draft.trim(), { custom: draft.trim() }); setOther(false); }}>Save</button>
            </span>
          ) : <button className={cx(ans?.choice === "other" && "on")} onClick={() => { setDraft(ans?.custom ?? ""); setOther(true); }}>{ans?.choice === "other" ? `Your answer: ${ans.custom}` : "Write your own…"}</button>}
          <button className={cx(ans?.choice === "unsure" && "on")} onClick={() => { setOther(false); save("unsure", "not sure / discuss"); }}>Not sure / discuss</button>
          {ans && <button onClick={() => setNoteOpen(!noteOpen)}>{ans.note ? "Edit note" : "Add note"}</button>}
          {ans && <button onClick={() => { ctx.answer(did, null); setNoteOpen(false); }} title="Remove your answer">Undo</button>}
          {ans && noteOpen && <textarea rows={2} defaultValue={ans.note} placeholder="Optional note for the author…" onBlur={(e) => ctx.answer(did, { ...ans, note: e.target.value.trim() || undefined })} />}
          {ans?.note && !noteOpen && <div className="a-muted">Note: {ans.note}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * Show content depending on a decision's answer, so the page follows the reader's choices (a decision tree: put the
 * follow-up `<Decision>` inside). `is="a"` (option key, label or "other"/"unsure"; a list means any of them),
 * `not="a"` (answered with something else), `answered`, `unanswered`.
 */
export function When({ decision, is, not, answered, unanswered, children }: {
  decision: string; is?: Want; not?: Want; answered?: boolean; unanswered?: boolean; children?: ReactNode;
}) {
  const a = useAnswer(decision);
  const ok = (is == null || matchesAnswer(a, is)) && (not == null || (!!a && !matchesAnswer(a, not))) && (!answered || !!a) && (!unanswered || !a);
  return ok ? <>{children}</> : null;
}
