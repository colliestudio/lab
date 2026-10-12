// What each slide shows. Facts come from data/release.json; headlines are rewritten for the deck.
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { download, openFeedback, Callout, Code, Decision, Img, Map, More, Scorecard, Section, Stages, Stats, TimeAxis, Walkthrough, imageSrc, useAnswers, usePages, useRoute, useData } from "artifact";
import { SLIDES, type SlideSpec } from "./plan";
import { HUES, Kicker, byId, go, next, startPresent, toggleOverview, vt } from "./Deck";
import { setDeck } from "./store";

interface Feature {
  id: string; title: string; theme: string; oneLiner: string; why: string; how?: string; round: number; roundLabel: string; commits: string[]; status: string;
  demo: { kind: "live" | "shot" | "none"; components?: string[]; props?: Record<string, Record<string, unknown>>; shot?: string; moreShots?: string[]; shotFrom?: string };
}
interface Release {
  version: string; date: string; headline: string; intro: string;
  themes: { id: string; title: string; oneLiner: string }[];
  features: Feature[];
  rounds: { round: string; date: string; summary: string; tests?: number; commits: string[] }[];
  removed: { id: string; title: string; oneLiner: string; why: string; replacedBy: string; addedRound?: number; removedRound?: number }[];
  numbers: { rounds: number; tests: number; testsByRound: { round: string; tests: number }[]; components: number; componentsNote: string; demos: number; demosNote: string; kitCommits: number };
  nextUp: { title: string; oneLiner: string }[];
  credits: string;
}

let rel: Release | undefined;
const R = (): Release => rel!;
const feat = (id: string) => R().features.find((f) => f.id === id)!;
export function useRelease() { rel = useData<Release>("release"); return rel; }

/** `code` spans in the data's prose become <code>. */
export function md(text: string): ReactNode {
  return text.split(/(`[^`]+`)/g).map((p, i) => (p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>));
}

export function thumbFor(s: SlideSpec): string | undefined {
  const f = s.feature ? R()?.features.find((x) => x.id === s.feature) : undefined;
  return f?.demo.shot;
}
export function demoKind(s: SlideSpec): string | undefined {
  const f = s.feature ? R()?.features.find((x) => x.id === s.feature) : undefined;
  if (s.kind === "cli") return "try it";
  if (!f) return s.kind === "call" ? "decide" : undefined;
  if (["present-mode", "download", "feedback-drawer", "pages", "present-hooks"].includes(f.id)) return "try it";
  return f.demo.kind === "live" ? "live" : undefined;
}

export function notesFor(s: SlideSpec, step: number): { body: ReactNode; meta?: ReactNode } {
  const r = R();
  if (!r) return { body: "" };
  if (s.kind === "cli") {
    const f = feat(s.features![Math.min(step, s.features!.length - 1)]);
    return { body: md(f.why), meta: <>Round {f.roundLabel} · {f.commits.map((c) => <code key={c}>{c}</code>)}</> };
  }
  if (s.feature) {
    const f = feat(s.feature);
    return { body: md(f.why), meta: <>Round {f.roundLabel} · {f.commits.map((c) => <code key={c}>{c}</code>)}</> };
  }
  switch (s.kind) {
    case "title": return { body: md(r.intro) };
    case "numbers": return { body: <>{r.numbers.componentsNote} {r.numbers.demosNote}</> };
    case "cover": {
      const fs = (s.items ?? []).flatMap((id) => byId(id)?.features ?? [id]).map(feat);
      const rounds = [...new Set(fs.map((f) => f.roundLabel))];
      return { body: <>{fs.length} feature{fs.length > 1 ? "s" : ""} in this chapter, from round{rounds.length > 1 ? "s" : ""} {rounds.join(", ")}.</> };
    }
    case "cut": return { body: <>{r.removed.map((x) => <p key={x.id}>{md(x.why)}</p>)}</> };
    case "next": return { body: md(r.nextUp[0].oneLiner) };
    case "call": return { body: r.credits };
  }
  return { body: "" };
}

export function renderSlide(s: SlideSpec, step: number): ReactNode {
  return <SlideBody s={s} step={step} />;
}

function SlideBody({ s, step }: { s: SlideSpec; step: number }) {
  useRelease();
  switch (s.kind) {
    case "title": return <Title />;
    case "numbers": return <Numbers s={s} />;
    case "cover": return <Cover s={s} />;
    case "feature": return <FeatureSlide s={s} step={step} />;
    case "cli": return <Cli s={s} step={step} />;
    case "cut": return <Cut s={s} />;
    case "next": return <Next s={s} />;
    case "call": return <Call s={s} />;
  }
}

// ---------- opening ----------

function Title() {
  const r = R();
  return (
    <div className="t-root">
      <div className="t-glow" aria-hidden>{Object.values(HUES).map((h, i) => <span key={i} style={{ "--h": h, "--i": i } as CSSProperties} />)}</div>
      <div className="t-in">
        <div className="t-eyebrow">Release notes · v{r.version} · Oct 13, 2026</div>
        <h1 className="t-head" id="h-home" data-morph="head-home">
          <span>Agents write the page.</span>
          <span>The kit gives them the parts.</span>
          <span className="t-accent">You get one HTML file</span>
          <span className="t-accent">to read, present and answer.</span>
        </h1>
        <div className="t-start">
          <button className="s-btn s-btn-primary" onClick={next}>Begin <kbd>→</kbd></button>
          <button className="s-btn" onClick={toggleOverview}>All slides <kbd>Esc</kbd></button>
          <button className="s-btn" onClick={startPresent}>Present <kbd>P</kbd></button>
        </div>
        <p className="t-foot">32 slides, 6 chapters. Every demo on them is live: click it, answer it, comment on it (⌥ click).</p>
      </div>
    </div>
  );
}

function CountUp({ to, delay = 0 }: { to: number; delay?: number }) {
  const [v, setV] = useState(() => (typeof window === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches ? to : 0));
  useEffect(() => {
    if (v === to) return;
    let raf = 0; const t0 = performance.now() + delay;
    const tick = (t: number) => { const k = Math.min(1, Math.max(0, (t - t0) / 900)); setV(Math.round(to * (1 - Math.pow(1 - k, 3)))); if (k < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <>{v}</>;
}

function Numbers({ s }: { s: SlideSpec }) {
  const n = R().numbers;
  const items: [number, string][] = [[n.rounds, "rounds"], [n.tests, "kit tests"], [n.components, "components"], [R().features.length, "features"], [n.kitCommits, "kit commits"], [n.demos, "real-work demos"]];
  return (
    <div className="s-pad n-root">
      <Kicker spec={s} />
      <h1 className="s-head" id={`h-${s.id}`} data-morph={`head-${s.id}`}>{s.head}</h1>
      <p className="s-lead">Oct 12–13. Each round started from friction on real demo pages and from Alex's “not this”.</p>
      <div className="n-grid">
        {items.map(([v, l], i) => (
          <div key={l} className="n-cell" id={`n-${l.replace(/\W+/g, "-")}`} style={{ "--i": i } as CSSProperties}>
            <div className="n-v"><CountUp to={v} delay={i * 90} /></div><div className="n-l">{l}</div>
          </div>
        ))}
      </div>
      <div className="n-ticker" aria-label="Kit tests by round">
        <span className="n-ticker-k">tests by round</span>
        {n.testsByRound.map((t) => <span key={t.round} className="n-t"><b>{t.tests}</b><small>r{t.round}</small></span>)}
      </div>
    </div>
  );
}

// ---------- chapters ----------

function Cover({ s }: { s: SlideSpec }) {
  const t = R().themes.find((x) => x.id === s.theme)!;
  return (
    <div className="c-root">
      <div className="c-num" aria-hidden>{String(s.num).padStart(2, "0")}</div>
      <div className="c-in">
        <div className="c-eyebrow">Chapter {s.num} of 6</div>
        <h1 className="c-title" id={`h-${s.id}`}><span style={vt(`kick-${s.theme}`)}>{t.title}</span></h1>
        <p className="c-lead">{md(t.oneLiner)}</p>
        <ol className="c-list">
          {(s.items ?? []).map((id, k) => {
            const sp = byId(id)!;
            const sub = sp.feature ? feat(sp.feature).title : `${sp.features!.length} commands`;
            return (
              <li key={id} style={{ "--i": k } as CSSProperties}>
                <button onClick={() => go(id, "next")}>
                  <span className="c-li-n">{String(SLIDES.indexOf(sp) + 1).padStart(2, "0")}</span>
                  <span className="c-li-h" data-morph={`head-${id}`}>{sp.head}</span>
                  <span className="c-li-s">{md(sub)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

// ---------- features ----------

function FeatureSlide({ s, step }: { s: SlideSpec; step: number }) {
  const f = feat(s.feature!);
  return (
    <div className="s-pad f-root" data-wide={s.wide ? "" : undefined}>
      <Kicker spec={s} />
      <div className="f-grid">
        <header className="f-text">
          <h1 className="s-head" id={`h-${s.id}`} data-morph={`head-${s.id}`}>{s.head}</h1>
          <p className="s-lead" id={`lead-${s.id}`}>{md(f.oneLiner)}</p>
          <div className="f-meta">
            <span className="f-name">{md(f.title)}</span>
            <span className="f-chip">round {f.roundLabel}</span>
            <span className="f-chip" data-tone={f.status}>{f.status}</span>
          </div>
          <WhyButton />
        </header>
        <section className="f-demo" id={`demo-${s.id}`} aria-label="Demo">
          <Demo f={f} step={step} />
        </section>
      </div>
    </div>
  );
}

function WhyButton() {
  return <button className="f-why" onClick={() => setDeck({ notes: true })}>Why this exists <kbd>N</kbd></button>;
}

function Shot({ src, label, from, height }: { src: string; label?: string; from?: string; height?: number }) {
  return (
    <figure className="d-shot">
      <div className="d-shot-bar" aria-hidden><i /><i /><i /><span>{label ?? "artifact"}</span></div>
      <Img src={src} fit={height ? "cover" : undefined} height={height} alt={from ?? ""} />
      {from && <figcaption>{md(from)}</figcaption>}
    </figure>
  );
}

function HowCode({ f, title }: { f: Feature; title?: string }) {
  return f.how ? <div className="d-code"><Code code={f.how} lang="tsx" title={title} /></div> : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = (f: Feature, c: string): any => f.demo.props?.[c] ?? {};

function Demo({ f, step }: { f: Feature; step: number }) {
  switch (f.id) {
    case "artifact-dir":
      return (
        <div className="d-split">
          <div className="d-pane"><div className="d-pane-k">You write</div><Tree how={f.how!} /></div>
          <div className="d-pane d-live"><div className="d-pane-k">The reader sees</div>
            <Section {...P(f, "Section")}><Callout {...P(f, "Callout")}>status, review, plan, explainer: the agent names it and picks the shape.</Callout></Section>
          </div>
        </div>
      );
    case "data-evidence": return <Evidence f={f} />;
    case "status-blocks": return <div className="d-stack"><div className="d-live d-card"><Stats {...P(f, "Stats")} /></div><HowCode f={f} /></div>;
    case "present-hooks": return <Hooks f={f} step={step} />;
    case "present-mode":
      return (
        <div className="d-stack">
          <Shot src={f.demo.shot!} label="present mode" from={f.demo.shotFrom} />
          <div className="d-try"><span>This deck is the demo. In present mode the chrome goes and the slides go full screen.</span><button className="s-btn s-btn-primary" onClick={startPresent}>Present now <kbd>P</kbd></button></div>
        </div>
      );
    case "compact-header": return <Shot src={f.demo.shot!} label="header" from={f.demo.shotFrom} height={330} />;
    case "folding-more":
      return (
        <div className="d-live d-card d-fold">
          <Section {...P(f, "Section")}>
            <p>Click the heading above to fold this section.</p>
            <More {...P(f, "More")}><p className="d-dim">Skippable detail waits here until someone wants it: the method, the raw table, the long list.</p></More>
          </Section>
        </div>
      );
    case "download": return <Download f={f} />;
    case "gallery": return <Shot src={f.demo.shot!} label="gallery" from={f.demo.shotFrom} />;
    case "decision-walk":
      return (
        <div className="d-decision">
          <Decision {...P(f, "Decision")} why="Four prototypes on the same release notes; this deck is one of them. Your answer is saved in this browser and shows up in the Feedback drawer." />
        </div>
      );
    case "feedback-drawer":
      return (
        <div className="d-stack">
          <Shot src={f.demo.shot!} label="feedback" from={f.demo.shotFrom} />
          <div className="d-try"><span>Try it here: hold <kbd>⌥</kbd> and click this slide's headline, then open the drawer.</span><button className="s-btn" onClick={() => openFeedback()}>Open Feedback</button></div>
        </div>
      );
    case "scorecard": return <div className="d-live d-card"><Scorecard {...P(f, "Scorecard")} /></div>;
    case "map-fit": return <div className="d-live d-card d-map"><Map {...P(f, "Map")} /></div>;
    case "code-notes": return <Toggle items={[["Code", f.demo.shot!], ["Diff", f.demo.moreShots![0]]]} from={f.demo.shotFrom} />;
    case "timeaxis": return <div className="d-live d-card"><TimeAxis {...P(f, "TimeAxis")} /></div>;
    case "timeline-lanes": return <Shot src={f.demo.shot!} label="timeline" from={f.demo.shotFrom} />;
    case "walkthrough": return <div className="d-live d-card"><Walkthrough {...P(f, "Walkthrough")} /></div>;
    case "stages": return <div className="d-live d-card"><Stages {...P(f, "Stages")} /></div>;
    case "pages": return <PagesDemo f={f} />;
    case "tour":
      return (
        <div className="d-stack">
          <HowCode f={f} />
          <div className="d-try"><span>This deck plays the same idea its own way: <kbd>P</kbd> presents all {SLIDES.length} pages in order, and <kbd>→</kbd> crosses pages without leaving.</span></div>
          <div className="d-decision">
            <Decision id="d-present-owner" question="In bare artifacts, who owns present mode?"
              options={[
                { label: "The artifact", note: "kit gives hooks: onPresent, fullscreen, keys, steps" },
                { label: "The kit", note: "present stays generic: Sections are slides" },
              ]}
              recommend={0} owner="Alex"
              why="This deck first had to intercept P and the corner menu so Present would not walk one page's Sections; usePresentControl makes it one line." />
          </div>
        </div>
      );
  }
  if (f.demo.shot) return <Shot src={f.demo.shot} from={f.demo.shotFrom} />;
  return <HowCode f={f} />;
}

function Tree({ how }: { how: string }) {
  const rows = how.split("\n").map((l) => { const m = l.match(/^(\s*)(\S+)\s*(.*)$/); return m ? { depth: m[1].length ? 1 : 0, name: m[2], hint: m[3] } : null; }).filter(Boolean) as { depth: number; name: string; hint: string }[];
  return (
    <ul className="d-tree">
      {rows.map((r) => <li key={r.name} data-depth={r.depth}><code>{r.name}</code>{r.hint && <span>{r.hint}</span>}</li>)}
    </ul>
  );
}

function Toggle({ items, from }: { items: [string, string][]; from?: string }) {
  const [i, setI] = useState(0);
  return (
    <div className="d-stack">
      <div className="d-toggle" role="tablist" aria-label="Variant">
        {items.map(([l], k) => <button key={l} role="tab" aria-selected={k === i} onClick={() => setI(k)}>{l === "Code" ? "<Code>" : "<Diff>"}</button>)}
      </div>
      <Shot key={i} src={items[i][1]} label={items[i][0] === "Code" ? "code" : "diff"} from={from} />
    </div>
  );
}

function Evidence({ f }: { f: Feature }) {
  const shots = [...new Set(R().features.flatMap((x) => [x.demo.shot, ...(x.demo.moreShots ?? [])]).filter(Boolean) as string[])];
  const bytes = shots.reduce((a, s) => { const u = imageSrc(s); return a + (u.startsWith("data:") ? Math.round((u.length - u.indexOf(",") - 1) * 0.75) : 0); }, 0);
  return (
    <div className="d-stack">
      <div className="d-film" aria-label={`${shots.length} screenshots`}>
        {shots.map((s, k) => <img key={s} src={imageSrc(s)} alt="" style={{ "--i": k } as CSSProperties} />)}
      </div>
      <p className="d-fact"><b>{shots.length} screenshots</b> ride inside this one file{bytes ? <>, {(bytes / 1048576).toFixed(1)} MB of them</> : null}. No server, no broken links.</p>
      <HowCode f={f} />
    </div>
  );
}

function Hooks({ f, step }: { f: Feature; step: number }) {
  const hops = ["hop 1", "hop 2", "hop 3", "hop 4", "hop 5"];
  return (
    <div className="d-stack">
      <div className="d-card hk-trace" aria-label="A custom component with its own steps">
        <div className="hk-rail">
          {hops.map((h, k) => (
            <button key={h} className="hk-hop" data-on={k <= step ? "" : undefined} aria-current={k === step ? "step" : undefined} onClick={() => setDeck({ step: k })}>
              <span className="hk-dot" /><span>{h}</span>
            </button>
          ))}
        </div>
        <p className="hk-say">Press <kbd>→</kbd>: the component takes its 5 steps first, then the deck moves on. Click a hop: the counter follows.</p>
      </div>
      <HowCode f={f} />
    </div>
  );
}

function Download({ f }: { f: Feature }) {
  const [size, setSize] = useState<string>("");
  useEffect(() => { const b = document.documentElement.outerHTML.length; setSize(b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`); }, []);
  return (
    <div className="d-stack dl-root">
      <div className="dl-file" aria-hidden><div className="dl-ear" /><b>.html</b><span>{size || "…"}</span></div>
      <p className="d-fact">This deck is one file{size ? <> of about {size}</> : null}: pages, screenshots, live demos, your answers' plumbing. Download is on by default; <code>{'"host": { "download": false }'}</code> in artifact.json hides it.</p>
      <div className="d-try"><span>It lives in the corner menu, with Feedback and Present.</span><button className="s-btn s-btn-primary" onClick={() => { void download(); }}>Download it ↓</button></div>
    </div>
  );
}

function PagesDemo({ f }: { f: Feature }) {
  const pages = usePages(), route = useRoute();
  const k = pages.findIndex((p) => p.id === route.page);
  return (
    <div className="d-stack">
      <div className="pg-fan">
        <Shot src={f.demo.moreShots![0]} label="page cards" />
        <Shot src={f.demo.shot!} label="a page" from={f.demo.shotFrom} />
      </div>
      <div className="d-try"><span>You are on <code>#/{route.page}</code>, page {k + 1} of {pages.length} in this file. Every slide here is a page: Back works, links work, comments know the page.</span></div>
    </div>
  );
}

// ---------- cli ----------

function Cli({ s, step }: { s: SlideSpec; step: number }) {
  const fs = s.features!.map(feat);
  const cur = fs[Math.min(step, fs.length - 1)];
  const short: Record<string, string> = { "cli-core": "new · dev · check · build", "check-advice": "check: taste advice", shot: "shot", capture: "capture", gather: "gather", "evidence-safety": "evidence stays inside" };
  return (
    <div className="s-pad f-root cli-root">
      <Kicker spec={s} />
      <div className="f-grid">
        <header className="f-text">
          <h1 className="s-head" id={`h-${s.id}`} data-morph={`head-${s.id}`}>{s.head}</h1>
          <p className="s-lead">Six commands give an agent a tight loop and a way to look at its own output. Press <kbd>→</kbd> to walk them.</p>
          <ol className="cli-list" role="tablist" aria-label="Commands">
            {fs.map((f, k) => (
              <li key={f.id}><button role="tab" aria-selected={k === step} data-done={k < step ? "" : undefined} onClick={() => setDeck({ step: k })}>
                <span className="cli-n">{k + 1}</span>{short[f.id] ?? f.title}
              </button></li>
            ))}
          </ol>
          <WhyButton />
        </header>
        <section className="f-demo" id={`demo-${s.id}`} aria-label="Terminal">
          <div className="term" key={cur.id}>
            <div className="term-bar" aria-hidden><i /><i /><i /><span>~/workspaces/cs</span></div>
            <div className="term-body">
              <Typed text={cur.how ?? ""} />
              <div className="term-out"><span className="term-ok">→</span> {md(cur.oneLiner)}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Typed({ text }: { text: string }) {
  const lines = text.split("\n");
  const total = text.length;
  const [n, setN] = useState(() => (typeof window === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches ? total : 0));
  useEffect(() => {
    if (n >= total) return;
    const t = setInterval(() => setN((v) => { if (v >= total) { clearInterval(t); return v; } return Math.min(total, v + 3); }), 12);
    return () => clearInterval(t);
  }, []);
  let left = n;
  return (
    <pre className="term-in" aria-label={text}>
      {lines.map((l, i) => {
        const shown = l.slice(0, Math.max(0, left)); left -= l.length + 1;
        const isCmd = !l.trim().startsWith("<") && !l.trim().startsWith("//");
        return <div key={i}>{isCmd ? <span className="term-ps">$ </span> : null}{shown}{left < 0 && left > -l.length - 2 ? <span className="term-caret" /> : null}</div>;
      })}
    </pre>
  );
}

// ---------- closing ----------

function Cut({ s }: { s: SlideSpec }) {
  return (
    <div className="s-pad cut-root">
      <Kicker spec={s} />
      <h1 className="s-head" id={`h-${s.id}`} data-morph={`head-${s.id}`}>{s.head}</h1>
      <p className="s-lead">Two things that shipped earlier did not survive Alex's reading. Removing them made the kit quieter.</p>
      <div className="cut-list">
        {R().removed.map((x, k) => {
          const to = byId(x.replacedBy);
          return (
            <div key={x.id} className="cut-item" id={`cut-${x.id}`} style={{ "--i": k } as CSSProperties}>
              <div className="cut-was"><s>{md(x.title)}</s></div>
              <p className="cut-why">{md(x.oneLiner)}</p>
              {to && <button className="cut-to" onClick={() => go(to.id, "prev")}>Replaced by <b>{to.head}</b> <span aria-hidden>↩</span></button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Next({ s }: { s: SlideSpec }) {
  return (
    <div className="s-pad nx-root">
      <Kicker spec={s} />
      <h1 className="s-head" id={`h-${s.id}`} data-morph={`head-${s.id}`}>{s.head}</h1>
      <ol className="nx-list">
        {R().nextUp.map((x, k) => (
          <li key={x.title} data-now={k === 0 ? "" : undefined} style={{ "--i": k } as CSSProperties} id={`next-${k}`}>
            <span className="nx-n">{String(k + 1).padStart(2, "0")}</span>
            <div><b>{md(x.title)}</b>{k === 0 && <span className="nx-now">you are looking at one</span>}<p>{md(x.oneLiner)}</p></div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Call({ s }: { s: SlideSpec }) {
  const answers = useAnswers();
  const n = Object.keys(answers).length;
  return (
    <div className="s-pad call-root">
      <Kicker spec={s} />
      <div className="call-grid">
        <header>
          <h1 className="s-head" id={`h-${s.id}`} data-morph={`head-${s.id}`}>{s.head}</h1>
          <p className="s-lead">One answer moves round 14 forward. Pick, add a note if you like, then copy all your feedback back in one paste.</p>
          <div className="call-acts">
            <button className="s-btn s-btn-primary" onClick={() => openFeedback()}>Open Feedback {n ? <span className="call-n">{n} answered</span> : null}</button>
            <button className="s-btn" onClick={() => go("decision-walk", "prev")}>Layout question ↩</button>
            <button className="s-btn" onClick={() => go("tour", "prev")}>Present question ↩</button>
          </div>
          <p className="call-credits">{R().credits}</p>
        </header>
        <div className="call-ds">
          <div className="d-decision">
            <Decision id="d-deck-kit" question="Which part of this deck should the kit offer first?"
              options={[
                { label: "Light table", note: "Esc overview of all pages, grouped; works for any multi-page artifact" },
                { label: "Deck layout", note: "slides as pages, keys, chapter rail, builds, morphs" },
                { label: "Why drawer", note: "on-demand notes per page (N)" },
                { label: "None yet", note: "keep decks hand-built" },
              ]}
              recommend={0} owner="Alex"
              why="The light table helps every multi-page artifact, decks or not. The deck frame is about 300 lines and can follow once a second deck wants it." />
          </div>

        </div>
      </div>
    </div>
  );
}
