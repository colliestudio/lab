import { useEffect, useRef, useState } from "react";
import { Chart, Morph, Slide, TimeAxis, navigate } from "artifact";
import { md, useRelease } from "../parts";

export const page = { title: "How it was built", order: 1, summary: "Thirteen rounds on Oct 12–13: what each one added, and the tests that came with it." };

// back lands where the reader left the story: the kit restores the home page's scroll position
function back() { void navigate("home", { restore: true, direction: "back" }); }

/** Tests per round, large: the hero card's sparkline morphs into this. */
function Climb({ points }: { points: { round: string; tests: number }[] }) {
  const w = 720, h = 210, min = 80, max = 132, l = 24, r = 24, t = 34, b = 34;
  const px = (i: number) => l + (i * (w - l - r)) / (points.length - 1);
  const py = (v: number) => t + (1 - (v - min) / (max - min)) * (h - t - b);
  const d = points.map((p, i) => `${i ? "L" : "M"}${px(i)},${py(p.tests)}`).join(" ");
  return (
    <svg className="rd-climb" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Kit tests per round: ${points.map((p) => `round ${p.round}: ${p.tests}`).join(", ")}`}>
      <path d={`${d} L${px(points.length - 1)},${h - b} L${px(0)},${h - b} Z`} className="st-spark-fill" />
      <path d={d} className="st-spark-line" />
      {points.map((p, i) => (
        <g key={p.round}>
          <circle cx={px(i)} cy={py(p.tests)} r={4} className="st-spark-dot" />
          <text x={px(i)} y={py(p.tests) - 12} textAnchor="middle" className="rd-v">{p.tests}</text>
          <text x={px(i)} y={h - 10} textAnchor="middle" className="rd-r">{p.round}</text>
        </g>
      ))}
    </svg>
  );
}

export default function Rounds() {
  const r = useRelease();
  const ta = r.features.find((f) => f.id === "timeaxis")!.demo.props!.TimeAxis;
  const list = useRef<HTMLOListElement>(null);
  const [cur, setCur] = useState(0);
  useEffect(() => {
    const els = [...(list.current?.children ?? [])] as HTMLElement[];
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) setCur(els.indexOf(e.target as HTMLElement)); }, { rootMargin: "-45% 0px -45% 0px" });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  // the counter shows the last known test count at or before the current round (round 11 logged none)
  const testsAt = (i: number) => { for (let k = i; k >= 0; k--) if (r.rounds[k].tests) return r.rounds[k].tests!; return 0; };
  const removed = r.numbers.customLinesRemovedByPorting;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !("present" in document.documentElement.dataset) && !document.querySelector(".h-panel, [role=dialog]")) back(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);

  return (
    <div className="st rd">
      <button className="rd-back" onClick={back}><span aria-hidden>←</span> Back to the story <kbd>Esc</kbd></button>

      <Slide id="built" title="How it was built" className="rd-hero">
        <p className="st-open-k">artifact kit v{r.version} · How it was built</p>
        <h1 className="st-h2">Thirteen rounds, <br />Oct 12 to 13.</h1>
        <p className="st-open-lead">Each round started from friction on a real demo page or from Alex's feedback. Tests went from {r.numbers.testsByRound[0].tests} to {r.numbers.tests}.</p>
        <Morph name="rounds-spark" className="rd-climb-wrap"><Climb points={r.numbers.testsByRound} /></Morph>
        <p className="rd-note">Kit tests at the end of each logged round. Round 11 logged no count.</p>
      </Slide>

      <Slide id="clock" title="On the clock" className="rd-sec">
        <TimeAxis {...ta} />
      </Slide>

      <Slide id="rounds" title="Round by round" className="rd-sec rd-rounds">
        <aside className="rd-counter" aria-hidden>
          <span className="rd-counter-k">Round</span>
          <b className="rd-counter-r">{r.rounds[cur].round}</b>
          <span className="rd-counter-k">kit tests</span>
          <b className="rd-counter-t">{testsAt(cur)}</b>
          <span className="rd-bar"><i style={{ width: `${((testsAt(cur) - 80) / (r.numbers.tests - 80)) * 100}%` }} /></span>
        </aside>
        <ol className="rd-list" ref={list}>
          {r.rounds.map((x, i) => (
            <li key={x.round} id={`round-${x.round}`} data-on={i === cur ? "" : undefined}>
              <span className="rd-n">{x.round}</span>
              <div>
                <p className="st-meta"><span>{x.date}</span>{x.tests != null && <span>{x.tests} tests</span>}</p>
                <p className="rd-sum">{md(x.summary)}</p>
                <p className="st-commits">{x.commits.map((h) => <code key={h}>{h}</code>)}</p>
              </div>
            </li>
          ))}
        </ol>
      </Slide>

      <Slide id="porting" title="Porting removed code" className="rd-sec">
        <h2 className="rd-h">Porting four demos to the kit removed {removed.reduce((s, d) => s + d.lines, 0)} custom lines.</h2>
        <Chart data={removed.map((d) => ({ label: d.demo, value: d.lines }))} kind="bar" unit=" lines" />
        <p className="rd-note">Build sizes of the same demos: {r.numbers.demoSizes.map((d) => `${d.demo} ${d.size}`).join(", ")}. {r.numbers.sizeNote}</p>
      </Slide>

      <p className="rd-foot"><button className="st-top" onClick={back}>← Back to where you were in the story</button></p>
    </div>
  );
}
