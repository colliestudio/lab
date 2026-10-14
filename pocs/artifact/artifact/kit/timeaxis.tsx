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
export function TimeAxis({ events = [], bands = [], segments, lanes, id, timeZone, title, lead, breakLabel }: {
  events?: TimeEvent[]; bands?: TimeBand[]; segments?: Segment[]; lanes?: string[]; id?: string; timeZone?: string;
  /** A heading and a one-line "how to read this" above the axis. `breakLabel` overrides the text on each axis break. */
  title?: ReactNode; lead?: ReactNode; breakLabel?: ReactNode;
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
  const named = laneNames.some((n) => n);
  // band labels are chips that may be wider than their band: give overlapping ones their own row
  const bandPos = bands.map((b) => ({ x0: posOf(segs, b.from), x1: posOf(segs, b.to) }));
  const bandOrder = bandPos.map((_, i) => i).sort((a, b) => bandPos[a].x0 - bandPos[b].x0);
  const bandLv = new Array<number>(bands.length);
  stackLevels(bandOrder.map((i) => ({ x: bandPos[i].x0, w: typeof bands[i].label === "string" ? (bands[i].label as string).length * 0.75 + 2 : 10 }))).forEach((lv, k) => { bandLv[bandOrder[k]] = lv; });
  const bandRows = Math.max(1, ...bandLv.map((l) => l + 1));
  const breakStarts = segs.slice(0, -1).map((s) => s.x1);
  return (
    <div className={cx("a-ta", named && "named", segs.length > 1 && "broken")} data-c="timeaxis" data-aid={id}>
      {(title || lead) && <div className="a-ta-head">{title && <b>{title}</b>}{lead && <span className="a-muted"> {lead}</span>}</div>}
      <div className="a-ta-gutter" style={{ paddingTop: `${bandRows * 1.3 + 0.5}rem` }} aria-hidden>
        {named && placed.map(({ ln, rows }) => <div key={ln} className="a-ta-gutter-name" style={{ height: `${rows * 1.5 + 0.9}rem` }}>{ln}</div>)}
      </div>
      <div className="a-ta-plot" style={{ paddingTop: `${bandRows * 1.3 + 0.5}rem` }}>
        {bands.map((b, i) => (
          <div key={i} className={cx("a-ta-band", `tone-${b.tone ?? "neutral"}`)} style={{ left: `${bandPos[i].x0}%`, width: `${Math.max(0.5, bandPos[i].x1 - bandPos[i].x0)}%` }}>
            <span style={{ top: `${bandLv[i] * 1.3 + 0.15}rem` }}>{b.label}</span>
          </div>
        ))}
        {segs.slice(1).map((s, i) => <div key={i} className="a-ta-break" style={{ left: `${segs[i].x1}%`, width: `${s.x0 - segs[i].x1}%` }} title="axis break" />)}
        <div className="a-ta-lanes">
          {placed.map(({ ln, es, levels, rows }) => (
            <div key={ln} className="a-ta-lane" style={{ height: `${rows * 1.5 + 0.9}rem` }}>
              
              {es.map(({ e, x, x2 }, i) => {
                const lv = levels[i];
                const inner = <>{x2 == null && <i className="a-ta-dot" />}<span className="a-ta-lab">{e.label}</span></>;
                const w = typeof e.label === "string" ? e.label.length * 0.75 + 2 : 12;
                // labels read leftwards near the right edge, and when they would run over an axis break
                const flip = x2 == null && (x > 82 || breakStarts.some((bx) => x < bx && x + w > bx - 0.5));
                const style = { ...(flip ? { right: `${100 - x}%` } : { left: `${x}%` }), top: `${lv * 1.5 + 0.2}rem`, ...(x2 != null ? { width: `${Math.max(0.6, x2 - x)}%` } : {}) };
                return e.href
                  ? <a key={i} href={e.href} target="_blank" rel="noreferrer" title={e.title} className={cx("a-ta-ev", x2 != null && "bar", flip && "flip", `tone-${e.tone ?? "accent"}`)} style={style}>{inner}</a>
                  : <div key={i} title={e.title} className={cx("a-ta-ev", x2 != null && "bar", flip && "flip", `tone-${e.tone ?? "accent"}`)} style={style}>{inner}</div>;
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="a-ta-axis" style={{ gridColumn: named ? 2 : 1 }}>
        {segs.slice(1).map((s, i) => {
          const zoomIn = s.to - s.from < segs[i].to - segs[i].from;
          return <span key={"b" + i} className="a-ta-breaklab" style={{ left: `${(segs[i].x1 + s.x0) / 2}%` }}>{breakLabel ?? <>{zoomIn ? "zoomed in" : "zoomed out"}{s.label ? `: ${s.label}` : ""} ▸</>}</span>;
        })}
        {segs.map((s, i) => (
          <div key={i} className="a-ta-seg" style={{ left: `${s.x0}%`, width: `${s.x1 - s.x0}%` }}>
            {niceTimeTicks(s.from, s.to).map((t) => (
              <span key={t} className="a-ta-tick" style={{ left: `${((t - s.from) / Math.max(1, s.to - s.from)) * 100}%` }}>{tickLabel(t, s.to - s.from, tz)}</span>
            ))}
            {s.label && <span className="a-ta-seglabel">{s.label}</span>}
          </div>
        ))}
      </div>
      <div className="a-muted a-ta-tz" style={{ gridColumn: "1 / -1" }}>times in {tz}{segs.length > 1 ? "; the axis is broken between segments (each has its own scale)" : ""}</div>
    </div>
  );
}
