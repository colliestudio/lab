import type { Block, Doc } from "../../../src/model.ts";
import { useViewer } from "../ctx.tsx";
import { QuestionList } from "../blocks/simple.tsx";
import { AddDel, ChurnBar } from "./bits.tsx";
import { Icon } from "./icons.tsx";
import { cx, fmtDate, plural } from "../util.ts";

function planStats(doc: Doc) {
  const steps = doc.sections.flatMap((s) => s.blocks).filter((b): b is Extract<Block, { type: "steps" }> => b.type === "steps")
    .flatMap((b) => b.steps);
  return { steps: steps.length, done: steps.filter((s) => s.status === "done").length };
}

export function Headline({ overlay, setOverlay }: { overlay: boolean; setOverlay: (v: boolean) => void }) {
  const { doc, level, setLevel } = useViewer();
  const isPlan = doc.kind === "plan";
  const m = doc.meta;
  const mechFiles = doc.files.filter((f) => f.mechanical).length;
  const areas = doc.sections.filter((s) => !s.mechanical).length;
  const ps = planStats(doc);
  const pl = doc.planLink;

  return (
    <header className={cx("headline", level === 0 && "solo")} id="headline">
      <div className="hl-kicker">
        <span className="kind">{isPlan ? "Visual plan" : "Visual review"}</span>
        {doc.status && <span className={cx("pill", `st-${doc.status}`)}>{doc.status}</span>}
        {m.repo && (
          <span className="hl-ref">
            <Icon name="module" size={12} /> {m.repo}
            {m.base && m.head && <> · <code>{m.base}</code> ← <code>{m.head}</code></>}
            {m.base && !m.head && <> · on <code>{m.base}</code></>}
          </span>
        )}
        {m.pr && <a className="hl-ref link" href={m.pr} target="_blank" rel="noreferrer"><Icon name="link" size={12} /> {m.pr.replace(/^https?:\/\/(www\.)?github\.com\//, "")}</a>}
      </div>
      <h1 className="hl-title">{doc.title}</h1>
      <p className="hl-tldr">
        {isPlan && <span className="hl-label">Goal</span>}
        {doc.tldr}
      </p>

      <div className="hl-grid">
        {doc.risk && (
          <div className={cx("hl-tile risk", `risk-${doc.risk.level}`)}>
            <div className="tile-label">Risk</div>
            <div className="risk-level"><span className="risk-dot" />{doc.risk.level}</div>
            {doc.risk.why && <div className="tile-text">{doc.risk.why}</div>}
          </div>
        )}
        {doc.ask && (
          <div className="hl-tile ask">
            <div className="tile-label">The ask</div>
            <div className="tile-text strong">{doc.ask}</div>
          </div>
        )}
        <div className="hl-tile stats">
          <div className="tile-label">{isPlan ? "Scope" : "Change"}</div>
          {doc.stats ? (
            <>
              <div className="stat-big">
                <span>{plural(doc.stats.files, "file")}</span>
                <AddDel add={doc.stats.additions} del={doc.stats.deletions} />
              </div>
              <ChurnBar add={doc.stats.additions} del={doc.stats.deletions} />
            </>
          ) : isPlan ? (
            <div className="stat-big"><span>{plural(ps.steps, "step")}</span>{ps.done > 0 && <span className="muted">{ps.done} done</span>}</div>
          ) : null}
          <div className="tile-text muted">
            {plural(areas, "area")}{mechFiles > 0 && ` · ${mechFiles} mechanical file${mechFiles === 1 ? "" : "s"}`}
          </div>
        </div>
      </div>

      {pl && (
        <div className="plan-strip">
          <Icon name="target" size={14} />
          <span>Implements plan <b>{pl.title}</b></span>
          <span className="pm-text pm-done">{pl.done.length} done</span>
          <span className="pm-text pm-notDone">{pl.notDone.length} not done</span>
          <span className="pm-text pm-unplanned">{pl.unplanned.length} unplanned</span>
          <button className={cx("btn small", overlay && "on")} onClick={() => { setOverlay(!overlay); if (level < 1) setLevel(1); }}>
            {overlay ? "Hide on map" : "Show on map"}
          </button>
        </div>
      )}

      {doc.questions.length > 0 && (
        <div className="hl-decisions">
          <div className="tile-label">{plural(doc.questions.length, "decision")} needed</div>
          <QuestionList questions={doc.questions} compact />
        </div>
      )}

      {(m.author || m.date) && (
        <div className="hl-foot muted">{[m.author, fmtDate(m.date)].filter(Boolean).join(" · ")}</div>
      )}
      {doc.warnings.length > 0 && (
        <details className="hl-warnings"><summary>{plural(doc.warnings.length, "parse warning")}</summary>
          <ul>{doc.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>
      )}
    </header>
  );
}
