import { useMemo, type ReactNode } from "react";
import { meta } from "./registry.ts";
import { layoutSegments, niceTimeTicks, posOf, stackLevels, tickLabel, type Segment } from "./timescale.ts";
import { cx } from "./util.ts";
import type { Tone } from "./layout.tsx";

export interface TimeEvent { at: string | number; to?: string | number; label: ReactNode; lane?: string; tone?: Tone; href?: string; title?: string }
export interface TimeBand { from: string | number; to: string | number; label: ReactNode; tone?: Tone }

/**
 * A real time axis. `events` are dots (or bars when they have `to`), optionally in `lane`s; `bands` are shaded periods
 * across all lanes ("gap exists", "no way out"). `segments` break the axis for long-then-dense stories: each segment has
 * its own linear scale and `weight` of the width, e.g. 6 weeks at weight 1 then 36 hours at weight 2.
 * Without `segments` the axis runs from the first to the last time.
 */
export function TimeAxis({ events = [], bands = [], segments, lanes, id, timeZone }: {
  events?: TimeEvent[]; bands?: TimeBand[]; segments?: Segment[]; lanes?: string[]; id?: string; timeZone?: string;
}) {
  const tz = timeZone ?? meta.timeZone ?? "UTC";
  const segs = useMemo(() => {
    if (segments?.length) return layoutSegments(segments);
    const ts = [...events.flatMap((e) => [e.at, e.to]), ...bands.flatMap((b) => [b.from, b.to])].filter((x) => x != null).map((x) => (typeof x === "number" ? x : Date.parse(x as string)));
    const lo = Math.min(...ts), hi = Math.max(...ts);
    return layoutSegments([{ from: lo, to: hi > lo ? hi : lo + 3600e3 }]);
  }, [events, bands, segments]);
  const laneNames = lanes ?? [...new Set(events.map((e) => e.lane ?? ""))];
  const placed = laneNames.map((ln) => {
    const es = events.filter((e) => (e.lane ?? "") === ln).map((e) => ({ e, x: posOf(segs, e.at), x2: e.to != null ? posOf(segs, e.to) : undefined }))
      .sort((a, b) => a.x - b.x);
    const levels = stackLevels(es.map(({ e, x, x2 }) => ({ x, w: Math.max(typeof e.label === "string" ? e.label.length * 0.75 + 2 : 12, x2 != null ? x2 - x : 0) })));
    return { ln, es, levels, rows: Math.max(1, ...levels.map((l) => l + 1)) };
  });
  return (
    <div className="a-ta" data-c="timeaxis" data-aid={id}>
      <div className="a-ta-plot">
        {bands.map((b, i) => {
          const x0 = posOf(segs, b.from), x1 = posOf(segs, b.to);
          return <div key={i} className={cx("a-ta-band", `tone-${b.tone ?? "neutral"}`)} style={{ left: `${x0}%`, width: `${Math.max(0.5, x1 - x0)}%` }}><span>{b.label}</span></div>;
        })}
        {segs.slice(1).map((s, i) => <div key={i} className="a-ta-break" style={{ left: `${segs[i].x1}%`, width: `${s.x0 - segs[i].x1}%` }} title="axis break" />)}
        <div className="a-ta-lanes">
          {placed.map(({ ln, es, levels, rows }) => (
            <div key={ln} className="a-ta-lane" style={{ height: `${rows * 1.5 + 0.9}rem` }}>
              {ln && <span className="a-ta-lane-name">{ln}</span>}
              {es.map(({ e, x, x2 }, i) => {
                const lv = levels[i];
                const inner = <>{x2 == null && <i className="a-ta-dot" />}<span className="a-ta-lab">{e.label}</span></>;
                const flip = x2 == null && x > 82; // labels near the right edge read leftwards
                const style = { ...(flip ? { right: `${100 - x}%` } : { left: `${x}%` }), top: `${lv * 1.5 + 0.2}rem`, ...(x2 != null ? { width: `${Math.max(0.6, x2 - x)}%` } : {}) };
                return e.href
                  ? <a key={i} href={e.href} target="_blank" rel="noreferrer" title={e.title} className={cx("a-ta-ev", x2 != null && "bar", flip && "flip", `tone-${e.tone ?? "accent"}`)} style={style}>{inner}</a>
                  : <div key={i} title={e.title} className={cx("a-ta-ev", x2 != null && "bar", flip && "flip", `tone-${e.tone ?? "accent"}`)} style={style}>{inner}</div>;
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="a-ta-axis">
        {segs.map((s, i) => (
          <div key={i} className="a-ta-seg" style={{ left: `${s.x0}%`, width: `${s.x1 - s.x0}%` }}>
            {niceTimeTicks(s.from, s.to).map((t) => (
              <span key={t} className="a-ta-tick" style={{ left: `${((t - s.from) / Math.max(1, s.to - s.from)) * 100}%` }}>{tickLabel(t, s.to - s.from, tz)}</span>
            ))}
            {s.label && <span className="a-ta-seglabel">{s.label}</span>}
          </div>
        ))}
      </div>
      <div className="a-muted a-ta-tz">times in {tz}{segs.length > 1 ? "; the axis is broken between segments (each has its own scale)" : ""}</div>
    </div>
  );
}
