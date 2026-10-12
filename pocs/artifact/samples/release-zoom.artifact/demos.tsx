// What a feature shows: the kit's own components rendered from the release data (live), a screenshot, or its code.
import { Callout, Code, Decision, Img, Map, More, Scorecard, Section, Stages, Stats, TimeAxis, Walkthrough, imageSrc } from "artifact";
import type { Feature } from "./model.ts";

/** The real component, full size, from `demo.components` + `demo.props`. */
export function LiveDemo({ f }: { f: Feature }) {
  const p = f.demo.props ?? {};
  switch (f.id) {
    case "artifact-dir":
      return <Section {...p.Section}><Callout {...p.Callout}>No shape is required: a status page, a review and a decision walk are all just pages the agent writes.</Callout></Section>;
    case "folding-more":
      return <Section {...p.Section}><p>The point stays on screen; the long list waits behind one quiet line.</p><More {...p.More}><p className="a-muted">Skippable detail lives here, folded until the reader asks for it.</p></More></Section>;
    case "status-blocks": return <Stats {...p.Stats} />;
    case "decision-walk": return <Decision {...p.Decision} />;
    case "scorecard": return <Scorecard {...p.Scorecard} />;
    case "map-fit": return <Map {...p.Map} />;
    case "timeaxis": return <TimeAxis {...p.TimeAxis} />;
    case "walkthrough": return <Walkthrough {...p.Walkthrough} />;
    case "stages": return <Stages {...p.Stages} />;
  }
  return null;
}

/** A miniature for the board: the live component shrunk (inert), a screenshot, a little drawing, or the code itself. */
export function Mini({ f }: { f: Feature }) {
  const p = f.demo.props ?? {};
  const live = (node: React.ReactNode, w = 560) => (
    <div className="zm-live" style={{ "--mw": w } as React.CSSProperties} aria-hidden inert>{node}</div>
  );
  switch (f.id) {
    case "status-blocks": return live(<Stats {...p.Stats} />, 620);
    case "scorecard": return live(<Scorecard {...p.Scorecard} />, 720);
    case "stages": return live(<Stages {...p.Stages} />, 760);
    case "timeaxis": return live(<TimeAxis {...p.TimeAxis} />, 720);
    case "artifact-dir": return live(<Callout tone="info" title="Kind is a free label">The agent picks the structure.</Callout>, 420);
    case "folding-more": return live(<><h3 style={{ margin: "0 0 .4rem" }}>Fixed findings</h3><More label="All 35 fixed findings"><span /></More></>, 380);
    case "walkthrough": return <Rail states={p.Walkthrough.states} />;
  }
  if (f.demo.shot) return <img className="zm-shot" src={imageSrc(f.demo.shot)} alt="" loading="lazy" />;
  return <pre className="zm-code" aria-hidden>{f.how}</pre>;
}

/** The Walkthrough's state rail, drawn small. */
function Rail({ states }: { states: string[] }) {
  return (
    <div className="zm-rail" aria-hidden>
      {states.map((s, i) => <span key={s} style={{ "--i": i } as React.CSSProperties}><i />{s}</span>)}
    </div>
  );
}

/** Screenshots for a feature: the main one with the kit's lightbox, extra ones beside it. */
export function Shots({ f }: { f: Feature }) {
  const more = f.demo.moreShots ?? [];
  return (
    <div className="zf-shots" data-n={1 + more.length}>
      <Img src={f.demo.shot!} alt={`${f.title}: screenshot`} caption={f.demo.shotFrom && <>From {f.demo.shotFrom}</>} />
      {more.map((s) => <Img key={s} src={s} alt="" />)}
    </div>
  );
}

export function HowCode({ f }: { f: Feature }) {
  const lang = f.how.startsWith("artifact ") ? "bash" : f.how.includes("x.artifact/\n") ? undefined : "typescript";
  return <Code code={f.how} lang={lang} />;
}
