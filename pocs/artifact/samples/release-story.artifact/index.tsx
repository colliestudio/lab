import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Decision, Morph, Slide, navigate, usePresentSteps } from "artifact";
import { Spark, hue, md, pad, scrollToEl, useChapters, useRelease, type Chapter as Ch } from "./parts";
import { StageCard } from "./demos";
import { Spine } from "./spine";

export const page = { title: "The story", summary: "artifact kit v0.1, told chapter by chapter with a live stage." };

function useNarrow() {
  const q = "(max-width: 900px)";
  const [n, setN] = useState(() => typeof matchMedia === "function" && matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const f = () => setN(m.matches); m.addEventListener("change", f); return () => m.removeEventListener("change", f); }, []);
  return n;
}

function Hero() {
  const r = useRelease();
  const chapters = useChapters();
  const n = r.numbers;
  const removed = n.customLinesRemovedByPorting.reduce((s, d) => s + d.lines, 0);
  const improved = r.features.filter((f) => f.status === "improved").length;
  const idx = Object.fromEntries(chapters.flatMap((c) => c.features).map((f, i) => [f.id, i]));
  return (
    <Slide id="top" title="artifact kit v0.1" className="st-hero" data-stop="">
      <div className="st-hero-in">
        <p className="st-kicker"><span className="st-ver">v{r.version}</span> {r.product} · Oct 13, 2026</p>
        <h1 className="st-h1">
          <span className="st-l">Agents write the page.</span>
          <span className="st-l">The kit gives them the parts.</span>
          <span className="st-l">You get <em>one HTML file</em> to read, present and answer.</span>
        </h1>
        <p className="st-intro">The first cut of a toolbox agents use to show what they did, found or propose. It grew over 13 rounds on Oct 12–13, each round driven by friction from real demo pages and by Alex's feedback.</p>

        <div className="st-map" id="feature-map">
          <div className="st-map-head"><b>{r.features.length} features</b> in six chapters <span className="a-muted">· {r.features.length - improved} new, {improved} improved</span></div>
          <div className="st-map-row">
            {chapters.map((c) => (
              <div key={c.id} className="st-map-ch hue" style={{ ...hue(c.hue), "--n": c.features.length } as React.CSSProperties}>
                <div className="st-map-bars">
                  {c.features.map((f) => (
                    <button key={f.id} className="st-bar" style={{ "--i": idx[f.id] } as React.CSSProperties} data-status={f.status} title={f.title} aria-label={`${c.title}: ${f.title}`} onClick={() => scrollToEl(document.getElementById(f.id), "center")} />
                  ))}
                </div>
                <button className="st-map-label" onClick={() => scrollToEl(document.getElementById(c.id))}><span>{pad(c.n)}</span> {c.title}</button>
              </div>
            ))}
          </div>
        </div>

        <div className="st-nums">
          <div><b>{n.rounds}</b><span>rounds</span></div>
          <div><b>{n.tests}</b><span>kit tests</span></div>
          <div><b>{n.components}</b><span>components</span></div>
          <div><b>−{removed}</b><span>custom lines removed by porting 4 demos</span></div>
          <a className="st-rounds-link" id="rounds-link" href="#/rounds" onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); void navigate("rounds"); }}>
            <Morph name="rounds-spark" className="st-rounds-spark"><Spark points={n.testsByRound} /></Morph>
            <span><b>How it was built</b><span>13 rounds, 88 → 128 tests →</span></span>
          </a>
        </div>
        <p className="st-cue" aria-hidden><span className="st-cue-line" />Scroll, or press <kbd>j</kbd> <kbd>k</kbd></p>
      </div>
    </Slide>
  );
}

function Chapter({ c, narrow }: { c: Ch; narrow: boolean }) {
  const { step, active: presenting, markers } = usePresentSteps(c.features.length, 0);
  const [cur, setCur] = useState(0);
  const beats = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const els = [...(beats.current?.querySelectorAll<HTMLElement>("[data-beat]") ?? [])];
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) setCur(els.indexOf(e.target as HTMLElement));
    }, { rootMargin: "-48% 0px -48% 0px" });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  const on = presenting ? step - 1 : cur;
  return (
    <Slide id={c.id} title={`${pad(c.n)} ${c.title}`} className="st-ch hue" style={hue(c.hue)} data-pstep={presenting ? step : undefined}>
      {markers}
      <header className="st-open" data-stop="" data-aid={`${c.id}-open`}>
        <div className="st-open-bg" aria-hidden />
        <span className="st-num" aria-hidden>{pad(c.n)}</span>
        <div className="st-open-in">
          <p className="st-open-k">Chapter {c.n} · {c.kicker}</p>
          <h2 className="st-h2">{c.title}</h2>
          <p className="st-open-lead">{md(c.oneLiner)}</p>
          <ol className="st-open-list">
            {c.features.map((f) => <li key={f.id}><a href={`#${f.id}`} onClick={(e) => { e.preventDefault(); scrollToEl(document.getElementById(f.id), "center"); }}>{f.title}</a></li>)}
          </ol>
        </div>
      </header>
      <div className="st-body">
        <div className="st-beats" ref={beats}>
          {c.features.map((f, i) => (
            <article key={f.id} id={f.id} className="st-beat" data-beat="" data-stop="" data-on={i === on ? "" : undefined} style={{ order: i * 2 }}>
              <p className="st-meta"><span>Round {f.roundLabel}</span>{f.status !== "new" && <span className="st-tag">{f.status}</span>}</p>
              <h3 className="st-h3" data-aid={`${f.id}-title`}>{f.title}</h3>
              <p className="st-one">{md(f.oneLiner)}</p>
              <p className="st-why"><span>Why</span>{md(f.why)}</p>
              {f.id === "timeaxis" && <p className="st-deeplink"><a href="#/rounds" onClick={(e) => { e.preventDefault(); void navigate("rounds"); }}>All 13 rounds, one by one →</a></p>}
              <p className="st-commits" aria-label="commits">{f.commits.map((h) => <code key={h}>{h}</code>)}</p>
            </article>
          ))}
        </div>
        <div className="st-stage-wrap">
          <div className="st-stage">
            {c.features.map((f, i) => (
              <div key={f.id} className="st-slot" style={{ order: i * 2 + 1 }}>
                <StageCard f={f} on={narrow || i === on} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Slide>
  );
}

function Cut() {
  const r = useRelease();
  return (
    <Slide id="cut" title="What we took out" className="st-cut" data-stop="">
      <div className="st-cut-in">
        <p className="st-open-k">Interlude · What we took out</p>
        <h2 className="st-h2">Two ideas didn't make it.</h2>
        <div className="st-cut-grid">
          {r.removed.map((x) => (
            <article key={x.id} className="st-cut-item" id={`cut-${x.id}`}>
              <h3><s>{x.title}</s></h3>
              <p>{md(x.oneLiner)}</p>
              <blockquote>{md(x.why)}</blockquote>
              {x.addedRound && <p className="st-meta"><span>Added round {x.addedRound}, removed round {x.removedRound}</span></p>}
            </article>
          ))}
        </div>
      </div>
    </Slide>
  );
}

function Next() {
  const r = useRelease();
  return (
    <Slide id="next" title="What's next" className="st-next" data-stop="">
      <div className="st-next-in">
        <p className="st-open-k">What's next</p>
        <h2 className="st-h2">Round 14 is already running.</h2>
        <ol className="st-next-list">
          {r.nextUp.map((x, i) => (
            <li key={x.title} id={`next-${i}`} data-first={i === 0 ? "" : undefined}>
              <b>{x.title}</b><span>{md(x.oneLiner)}</span>
              {i === 0 && <em className="st-you">You are reading one of the four prototypes.</em>}
            </li>
          ))}
        </ol>
        <div className="st-ask">
          <Decision id="d-story-layout" question="Should this scroll story become something the kit offers?"
            options={[
              { label: "A kit layout", note: "<Story> with chapters, a sticky stage and the spine, filled from data" },
              { label: "Parts only", note: "export Spine, StickyStage and ChapterOpener; each artifact composes them" },
              { label: "Keep it a sample", note: "copy-paste from samples/, no kit API" },
            ]}
            recommend={1} owner="Alex"
            why="The stage and the spine carry the experience; the chapter opener and the copy change per artifact. Parts keep artifacts free to differ." />
        </div>
        <p className="st-credits">{r.credits}</p>
        <p className="st-end"><button className="st-top" onClick={() => scrollToEl(document.getElementById("top"))}>↑ Back to the top</button></p>
      </div>
    </Slide>
  );
}

export default function Story() {
  const chapters = useChapters();
  const narrow = useNarrow();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // j / k: next and previous stop (hero, chapter openers, beats, interlude, end)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || "present" in document.documentElement.dataset) return;
      if (e.key !== "j" && e.key !== "k") return;
      const stops = [...document.querySelectorAll<HTMLElement>("[data-stop]")];
      const mid = innerHeight / 2;
      const pos = stops.map((s) => { const r = s.getBoundingClientRect(); return s.hasAttribute("data-beat") ? r.top + r.height / 2 - mid : r.top; });
      const i = e.key === "j" ? pos.findIndex((p) => p > 8) : pos.map((p, j) => [p, j]).filter(([p]) => p < -8).pop()?.[1] ?? -1;
      const el = stops[i];
      if (!el) return;
      e.preventDefault();
      scrollToEl(el, el.hasAttribute("data-beat") ? "center" : "start");
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);

  return (
    <div className="st" data-narrow={narrow ? "" : undefined}>
      <Hero />
      {chapters.slice(0, 4).map((c) => <Chapter key={c.id} c={c} narrow={narrow} />)}
      <Cut />
      {chapters.slice(4).map((c) => <Chapter key={c.id} c={c} narrow={narrow} />)}
      <Next />
      {mounted && createPortal(<Spine chapters={chapters} />, document.body)}
    </div>
  );
}

