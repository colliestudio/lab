import { useEffect, useState } from "react";
import { hue, pad, scrollToEl, type Chapter } from "./parts";

interface Tick { id: string; at: number; label: string; ch?: Chapter; major: boolean; beat: boolean }

/**
 * The progress spine: a hairline down the left edge (a bar across the top on narrow screens). Each chapter is a coloured
 * run, each feature a tick at its real place in the page; the fill follows the reading line. Hover or focus a tick for its
 * name; click (or Enter) jumps there.
 */
export function Spine({ chapters }: { chapters: Chapter[] }) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [p, setP] = useState(0);
  const [awake, setAwake] = useState(false);

  useEffect(() => {
    const measure = () => {
      const H = document.documentElement.scrollHeight;
      const abs = (el: HTMLElement | null) => (el ? el.getBoundingClientRect().top + scrollY : 0);
      const out: Tick[] = [{ id: "top", at: 0, label: "Start", major: true, beat: false }];
      const add = (id: string, label: string, ch?: Chapter) => {
        const el = document.getElementById(id);
        if (!el) return;
        const beat = el.hasAttribute("data-beat");
        out.push({ id, label, ch, major: !beat, beat, at: (abs(el) + (beat ? el.offsetHeight / 2 : 0)) / H });
      };
      for (const id of ["authoring", "technical", "reading", "decisions", "cut", "multipage", "cli", "next"]) {
        const ch = chapters.find((c) => c.id === id);
        add(id, ch ? `${pad(ch.n)} ${ch.title}` : id === "cut" ? "What we took out" : "What's next", ch);
        ch?.features.forEach((f) => add(f.id, f.title, ch));
      }
      setTicks(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    const t = setTimeout(measure, 800);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [chapters]);

  useEffect(() => {
    let idle = 0;
    const f = () => {
      const H = document.documentElement.scrollHeight;
      setP(Math.min(1, (scrollY + innerHeight / 2) / H));
      setAwake(true);
      clearTimeout(idle);
      idle = window.setTimeout(() => setAwake(false), 1400);
    };
    f();
    setAwake(false);
    addEventListener("scroll", f, { passive: true });
    addEventListener("resize", f);
    return () => { removeEventListener("scroll", f); removeEventListener("resize", f); clearTimeout(idle); };
  }, []);

  const curIdx = ticks.reduce((k, t, i) => (t.at <= p + 0.0005 ? i : k), 0);
  const cur = ticks[curIdx];
  const chapterOf = (i: number) => { for (let k = i; k >= 0; k--) if (ticks[k].major) return ticks[k]; return ticks[0]; };
  const curCh = cur ? chapterOf(curIdx) : undefined;
  // runs: from each major tick to the next one, coloured by its chapter
  const runs = ticks.map((t, i) => ({ t, i })).filter(({ t }) => t.major).map(({ t, i }, k, arr) => ({ t, from: t.at, to: arr[k + 1]?.t.at ?? 1, i }));

  return (
    <nav className="st-spine" data-awake={awake ? "" : undefined} data-past-hero={curIdx > 0 ? "" : undefined} data-in-opener={cur?.major && cur.ch ? "" : undefined} aria-label="Story progress">
      <div className="st-spine-track">
        {runs.map(({ t, from, to }) => (
          <span key={t.id} className={t.ch ? "st-run hue" : "st-run"} style={{ ...(t.ch ? hue(t.ch.hue) : {}), "--a": from, "--b": to, "--f": Math.max(0, Math.min(1, (p - from) / (to - from))) } as React.CSSProperties} />
        ))}
        {ticks.map((t, i) => (
          <button key={t.id} className={t.ch ? "st-tick hue" : "st-tick"} data-major={t.major ? "" : undefined} data-past={t.at <= p ? "" : undefined} data-cur={i === curIdx ? "" : undefined}
            style={{ ...(t.ch ? hue(t.ch.hue) : {}), "--a": t.at } as React.CSSProperties}
            aria-label={t.label} aria-current={i === curIdx ? "location" : undefined}
            onClick={() => { const el = document.getElementById(t.id); scrollToEl(el, t.beat ? "center" : "start"); (el?.querySelector("h1,h2,h3") as HTMLElement | null)?.focus?.({ preventScroll: true }); }}>
            <span className="st-tip">{t.label}</span>
          </button>
        ))}
        <span className="st-head" style={{ "--a": p } as React.CSSProperties} />
      </div>
      {cur && (
        <div className={curCh?.ch ? "st-now hue" : "st-now"} style={curCh?.ch ? hue(curCh.ch.hue) : undefined} aria-hidden>
          <b>{curCh?.label}</b>{cur.beat && <span>{cur.label}</span>}
        </div>
      )}
    </nav>
  );
}
