import { useLayoutEffect, useState } from "react";
import { Slide, navigate } from "artifact";
import { minutesBetween, reducedMotion, useRelease, type Commit, type Round } from "./model.ts";

/** Counts from 0 to `to` once on mount (ease-out), unless the reader prefers reduced motion. */
function useCountUp(to: number, delay: number, dur = 1500) {
  const [v, setV] = useState(to);
  useLayoutEffect(() => {
    if (reducedMotion()) return;
    setV(0);
    let raf = 0;
    const t0 = performance.now() + delay;
    const tick = (t: number) => {
      const p = Math.min(1, Math.max(0, (t - t0) / dur));
      setV(Math.round(to * (p === 1 ? 1 : 1 - Math.pow(2, -10 * p))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, delay, dur]);
  return v;
}

function Num({ value, format, label, sub, delay, id }: { value: number; format?: (n: number) => string; label: string; sub: string; delay: number; id: string }) {
  const n = useCountUp(value, delay);
  return (
    <div className="l-num" id={id}>
      <dt>{label}</dt>
      <dd>
        <span className="l-num-v" aria-label={format ? format(value) : String(value)}>{format ? format(n) : n}</span>
        <span className="l-num-sub">{sub}</span>
      </dd>
    </div>
  );
}

const hm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
const time = (iso: string) => iso.slice(11, 16);

/** Every kit commit of rounds 1–13 on a real time axis, with the first commit of each round labelled. */
function CommitStrip({ commits, rounds }: { commits: Commit[]; rounds: Round[] }) {
  const t0 = Date.parse(commits[0].at), t1 = Date.parse(commits[commits.length - 1].at);
  const x = (iso: string) => ((Date.parse(iso) - t0) / (t1 - t0)) * 100;
  const at = Object.fromEntries(commits.map((c) => [c.h, c.at]));
  const marks = rounds.map((r) => ({ r: r.round, at: r.commits.map((h) => at[h]).filter(Boolean).sort()[0] })).filter((m) => m.at);
  return (
    <figure className="l-strip" id="commit-strip">
      <figcaption>
        <b>{commits.length} kit commits</b> from {time(commits[0].at)} Oct 12 to {time(commits[commits.length - 1].at)} Oct 13 (+07). Numbers mark where each round starts.
      </figcaption>
      <div className="l-strip-track" role="img" aria-label={`${commits.length} commits between ${commits[0].at} and ${commits[commits.length - 1].at}`}>
        <div className="l-strip-line" />
        {commits.map((c, i) => (
          <span key={c.h} className="l-strip-dot" style={{ left: `${x(c.at)}%`, animationDelay: `${600 + i * 45}ms` }} title={`${c.h} ${time(c.at)}: ${c.s}`} />
        ))}
        {marks.map((m, i) => (
          <span key={m.r} className="l-strip-mark" data-row={i % 2} data-minor={["2", "3–4", "5–6", "12"].includes(m.r) ? "" : undefined} style={{ left: `${x(m.at)}%` }}>
            {m.r}
          </span>
        ))}
      </div>
    </figure>
  );
}

export function Hero() {
  const { r, commits } = useRelease();
  const n = r.numbers;
  const removed = n.customLinesRemovedByPorting.reduce((a, d) => a + d.lines, 0);
  const span = minutesBetween(commits[0].at, commits[commits.length - 1].at);
  const firstTests = n.testsByRound[0].tests;
  return (
    <Slide id="top" title={`${r.product} ${r.version}`} className="l-hero">
      <div className="l-hero-glow" aria-hidden />
      <div className="l-hero-grid" aria-hidden />
      <div className="l-wrap l-hero-in">
        <a className="l-pill" href="#/home?sheet=pages" onClick={(e) => { e.preventDefault(); void navigate("home", { params: { sheet: "pages" }, morph: document.getElementById("card-pages") ?? undefined }); }}>
          <span className="l-pill-tag">New</span> Multi-page artifacts, in one HTML file <span aria-hidden>→</span>
        </a>
        <h1 className="l-h1" id="headline">
          Agents write the page.
          <span className="l-h1-2"> You read, present and answer it.</span>
        </h1>
        <p className="l-sub" id="intro">
          <b>{r.product} {r.version}</b> is the toolbox an agent uses to show what it did, found or proposes. It writes TSX with the kit's
          components; <code>artifact build</code> turns it into one self-contained HTML file. Grown over {n.rounds} rounds on Oct 12–13,
          each one driven by friction from real demo pages.
        </p>
        <div className="l-cta">
          <a className="l-btn l-btn-primary" href="#new" onClick={(e) => { e.preventDefault(); document.getElementById("new")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" }); }}>
            See what's new <span aria-hidden>↓</span>
          </a>
          <span className="l-hint"><kbd>p</kbd> present <span className="l-dot-sep">·</span> <kbd>⌥</kbd> click anything to comment</span>
        </div>
        <dl className="l-numbers">
          <Num id="n-rounds" value={n.rounds} label="rounds" sub="each from real friction" delay={150} />
          <Num id="n-time" value={span} format={hm} label="first to last commit" sub={`${n.kitCommits} commits, one evening`} delay={250} />
          <Num id="n-tests" value={n.tests} label="kit tests" sub={`up from ${firstTests} in round 1`} delay={350} />
          <Num id="n-components" value={n.components} label="components" sub="documented in COMPONENTS.md" delay={450} />
          <Num id="n-lines" value={removed} format={(v) => `−${v}`} label="custom lines deleted" sub="porting 4 demos to the kit" delay={550} />
        </dl>
        <CommitStrip commits={commits} rounds={r.rounds} />
      </div>
    </Slide>
  );
}
