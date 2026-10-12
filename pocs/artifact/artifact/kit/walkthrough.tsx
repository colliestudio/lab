import { useState, type ReactNode } from "react";
import { usePresentSteps } from "./present.ts";
import { cx } from "./util.ts";

export interface WalkStep {
  title: ReactNode; when?: ReactNode; who?: ReactNode; body?: ReactNode;
  /** colours the step number: "bad" | "good" | "warn" (or critical / success) */
  tone?: "bad" | "good" | "warn" | "critical" | "success";
  /** the state this step is in (one of `states`), for the rail */
  state?: string;
  /** what the right pane shows for this step: any node (a mock row, a diagram, an image) */
  visual?: ReactNode;
  /** a code/error line under the text */
  note?: ReactNode;
}
export interface WalkScenario { id?: string; label: ReactNode; steps: WalkStep[] }

const tone = (t?: string) => (t === "critical" ? "bad" : t === "success" ? "good" : t);

/**
 * A step-by-step walk through one or more scenarios (bug / fix A / fix B): scenarios as tabs, their steps listed on the
 * left (title + when), and on the right the step's visual and text. An optional state rail (`states`, each step's `state`)
 * shows where the thing is now and where it has been. ↑/↓ move between steps, ←/→ between scenarios. Present-aware: each step
 * is a present step, and a click in the walk keeps the slide's step counter in sync.
 *
 * `visual` is a function used for steps without their own `visual`: `(step, index, scenario) => node`.
 */
export function Walkthrough({ scenarios, states, visual, id }: {
  scenarios: WalkScenario[]; states?: string[]; id?: string;
  visual?: (step: WalkStep, index: number, scenario: WalkScenario) => ReactNode;
}) {
  const [sc, setSc] = useState(0);
  const maxSteps = Math.max(...scenarios.map((s) => s.steps.length));
  const { step, setStep, active, markers } = usePresentSteps(maxSteps - 1, 0);
  const scenario = scenarios[Math.min(sc, scenarios.length - 1)];
  const steps = scenario.steps;
  const idx = Math.max(0, Math.min(step, steps.length - 1));
  const cur = steps[idx];
  const pos = states && cur.state ? states.indexOf(cur.state) : -1;
  const visited = new Set(steps.slice(0, idx + 1).map((s) => s.state).filter(Boolean) as string[]);
  const key = (e: React.KeyboardEvent) => {
    if (active) return; // present mode owns the arrows
    if (e.key === "ArrowDown") { e.preventDefault(); setStep(idx + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setStep(idx - 1); }
    else if (e.key === "ArrowRight" && scenarios.length > 1) { e.preventDefault(); setSc((sc + 1) % scenarios.length); }
    else if (e.key === "ArrowLeft" && scenarios.length > 1) { e.preventDefault(); setSc((sc - 1 + scenarios.length) % scenarios.length); }
  };
  return (
    <div className="a-walk" data-c="walkthrough" data-aid={id} tabIndex={0} onKeyDown={key} aria-label="Step by step">
      {markers}
      {scenarios.length > 1 && (
        <div className="a-walk-tabs" role="tablist">
          {scenarios.map((s, n) => <button key={n} role="tab" aria-selected={n === sc} onClick={() => setSc(n)}>{s.label}</button>)}
        </div>
      )}
      <div className="a-walk-grid">
        <ol className="a-walk-steps">
          {steps.map((s, n) => (
            <li key={n} className={tone(s.tone)}>
              <button className={cx(n === idx && "on")} aria-current={n === idx ? "step" : undefined} onClick={() => setStep(n)}>
                <span className="n">{n + 1}</span>
                <span>{s.title}{s.when && <span className="when">{s.when}</span>}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="a-walk-body">
          {states && (
            <div className="a-walk-rail" aria-label="state">
              {states.map((s, n) => (
                <span key={s} className="a-walk-railitem">
                  {n > 0 && <span className="a-walk-arrow">›</span>}
                  <span className={cx("a-walk-pill", n === pos ? "now" : visited.has(s) ? "past" : "", n === pos && tone(cur.tone) === "bad" && "bad")}>{s}</span>
                </span>
              ))}
            </div>
          )}
          {(cur.visual ?? visual?.(cur, idx, scenario)) != null && <div className="a-walk-visual">{cur.visual ?? visual?.(cur, idx, scenario)}</div>}
          <h4>{idx + 1}. {cur.title}</h4>
          {(cur.when || cur.who) && <div className="a-walk-meta">{[cur.when, cur.who].filter(Boolean).map((x, i) => <span key={i}>{i ? " · " : ""}{x}</span>)}</div>}
          {cur.body && <p>{cur.body}</p>}
          {cur.note && <div className="a-walk-note">{cur.note}</div>}
          {!active && (
            <div className="a-walk-nav">
              <button disabled={idx === 0} onClick={() => setStep(idx - 1)}>‹ Back</button>
              <button disabled={idx === steps.length - 1} onClick={() => setStep(idx + 1)}>Next ›</button>
              <span className="a-muted">↑ ↓ steps{scenarios.length > 1 ? " · ← → scenarios" : ""}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
