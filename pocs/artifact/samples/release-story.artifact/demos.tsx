import { useEffect, useRef, useState, type ReactNode } from "react";
import { Callout, Code, Decision, Img, Map, More, Scorecard, Section, Stages, Stats, TimeAxis, Walkthrough } from "artifact";
import { md, reduced, type Feature } from "./parts";

/** The live demo for a feature: the kit component(s) with the props from release.json, plus a little body text where a component needs children. */
function Live({ f }: { f: Feature }) {
  const p = f.demo.props ?? {};
  switch (f.id) {
    case "artifact-dir":
      return (
        <Section {...p.Section}>
          <p>Kit components inside a page the agent wrote. Click the heading to fold it.</p>
          <Callout {...p.Callout}>No shape is required: <code>kind</code> is whatever the agent calls it.</Callout>
        </Section>
      );
    case "folding-more":
      return (
        <Section {...p.Section}>
          <p>The headline facts stay in view. Skippable detail waits behind a quiet disclosure:</p>
          <More {...p.More}><p>Long lists live here, folded until the reader asks for them. Click the section heading above to fold the whole section.</p></More>
        </Section>
      );
    case "status-blocks": return <Stats {...p.Stats} />;
    case "decision-walk": return <Decision {...p.Decision} why="This page is one of four prototypes on the same content. Your answer lands in the Feedback drawer (corner menu) with the others." />;
    case "scorecard": return <Scorecard {...p.Scorecard} />;
    case "map-fit": return <Map {...p.Map} />;
    case "timeaxis": return <TimeAxis {...p.TimeAxis} />;
    case "walkthrough": return <Walkthrough {...p.Walkthrough} />;
    case "stages": return <Stages {...p.Stages} />;
    default: return null;
  }
}

/** Screenshot(s) in a quiet browser frame; more than one gets a two-up switcher. */
function Shot({ f }: { f: Feature }) {
  const shots = [f.demo.shot!, ...(f.demo.moreShots ?? [])];
  const [i, setI] = useState(0);
  return (
    <div className="st-shot">
      <div className="st-browser">
        <span className="st-dots" aria-hidden><i /><i /><i /></span>
        <span className="st-url">{f.demo.shotFrom}</span>
        {shots.length > 1 && (
          <span className="st-seg" role="group" aria-label="Screenshots">
            {shots.map((_, k) => <button key={k} aria-pressed={k === i} onClick={() => setI(k)}>{k + 1}</button>)}
          </span>
        )}
      </div>
      <Img src={shots[i]} alt={`${f.title}: screenshot from ${f.demo.shotFrom}`} />
    </div>
  );
}

/** The `how` snippet: a terminal for the CLI chapter (typed out when it comes into view), an editor tab elsewhere. */
function How({ f, on, big }: { f: Feature; on: boolean; big?: boolean }) {
  const term = f.theme === "cli";
  if (!term) return <div className={big ? "st-how big" : "st-how"}><Code code={f.how} lang="tsx" /></div>;
  return <Terminal text={f.how} on={on} />;
}

function Terminal({ text, on }: { text: string; on: boolean }) {
  const lines = text.split("\n");
  const total = text.length;
  const [n, setN] = useState(total);
  const played = useRef(false);
  useEffect(() => {
    if (!on || played.current || reduced()) return;
    played.current = true;
    setN(0);
    let k = 0, t = 0;
    const tick = () => { k = Math.min(total, k + 2); setN(k); if (k < total) t = window.setTimeout(tick, 14); };
    t = window.setTimeout(tick, 250);
    return () => { clearTimeout(t); setN(total); };
  }, [on, total]);
  let left = n;
  return (
    <div className="st-term" role="img" aria-label={text}>
      <div className="st-term-bar" aria-hidden><span className="st-dots"><i /><i /><i /></span><span>zsh — artifact</span></div>
      <pre aria-hidden>
        {lines.map((l, i) => {
          const show = l.slice(0, Math.max(0, left)); left -= l.length + 1;
          const comment = show.indexOf("#");
          const isLast = left < 0 || i === lines.length - 1;
          return (
            <div key={i} className="st-term-line">
              <span className="st-prompt">{/^\s*(<|\/\/)/.test(l) ? " " : "$"}</span>
              {comment >= 0 ? <>{show.slice(0, comment)}<span className="st-term-c">{show.slice(comment)}</span></> : show}
              {isLast && left < 0 && <span className="st-caret" />}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

const KIND: Record<string, string> = { live: "Live", shot: "Screenshot", none: "How" };

/** One card on the stage: the demo, and the code that makes it one click away. */
export function StageCard({ f, on, chapterHue }: { f: Feature; on: boolean; chapterHue?: number }) {
  const [view, setView] = useState<"demo" | "code">("demo");
  const kind = f.demo.kind;
  const hasDemo = kind !== "none";
  let body: ReactNode;
  if (!hasDemo || view === "code") body = <How f={f} on={on} big={!hasDemo} />;
  else if (kind === "live") body = <div className="st-live"><Live f={f} /></div>;
  else body = <Shot f={f} />;
  return (
    <div className="st-card" id={`stage-${f.id}`} data-on={on ? "" : undefined} data-kind={kind} inert={!on || undefined} data-chapter-hue={chapterHue}>
      <div className="st-card-head">
        <span className={`st-kind k-${kind}`}>{kind === "live" && <i className="st-pulse" aria-hidden />}{KIND[kind]}</span>
        <span className="st-card-title">{f.title}</span>
        {hasDemo && (
          <span className="st-seg" role="group" aria-label="Show">
            <button aria-pressed={view === "demo"} onClick={() => setView("demo")}>{kind === "live" ? "Demo" : "Shot"}</button>
            <button aria-pressed={view === "code"} onClick={() => setView("code")}>Code</button>
          </span>
        )}
      </div>
      <div className="st-card-body">{body}</div>
      {kind === "live" && view === "demo" && <div className="st-card-foot">Real kit component, live: try it. <span className="a-muted">{md(f.demo.components!.map((c) => `\`<${c}>\``).join(" + "))}</span></div>}
    </div>
  );
}
