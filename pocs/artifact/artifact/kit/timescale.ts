// Pure time-axis maths (no DOM, no registry): segments with their own scale, nice ticks, label placement.

export interface Segment { from: string | number; to: string | number; weight?: number; label?: string }
export interface Seg { from: number; to: number; x0: number; x1: number; label?: string }
const ms = (t: string | number) => (typeof t === "number" ? t : Date.parse(t));

/** Lay segments side by side in 0..100 (%), each linear in time, with `gap` % between them (the axis break). */
export function layoutSegments(segs: Segment[], gap = 2.5): Seg[] {
  const total = segs.reduce((a, s) => a + (s.weight ?? 1), 0);
  const room = 100 - gap * (segs.length - 1);
  let x = 0;
  return segs.map((s) => {
    const w = (room * (s.weight ?? 1)) / total;
    const r = { from: ms(s.from), to: ms(s.to), x0: x, x1: x + w, label: s.label };
    x += w + gap;
    return r;
  });
}

/** Position (%) of time t; a time in a break snaps to the nearer edge; outside everything clamps. */
export function posOf(segs: Seg[], t: string | number): number {
  const v = ms(t);
  for (const s of segs) if (v >= s.from && v <= s.to) return s.x0 + ((v - s.from) / Math.max(1, s.to - s.from)) * (s.x1 - s.x0);
  if (v < segs[0].from) return segs[0].x0;
  for (let i = 0; i < segs.length - 1; i++) if (v > segs[i].to && v < segs[i + 1].from) return v - segs[i].to < segs[i + 1].from - v ? segs[i].x1 : segs[i + 1].x0;
  return segs[segs.length - 1].x1;
}

const STEPS = [60e3, 5 * 60e3, 15 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 2 * 86400e3, 7 * 86400e3, 14 * 86400e3, 30 * 86400e3];
/** About `n` round tick times in [from, to] (UTC-aligned steps). */
export function niceTimeTicks(from: number, to: number, n = 5): number[] {
  const step = STEPS.find((s) => (to - from) / s <= n) ?? STEPS[STEPS.length - 1];
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out.length ? out : [from];
}

/** Tick label: time of day for short spans, date for long ones, in `timeZone` (default UTC). */
export function tickLabel(t: number, spanMs: number, timeZone = "UTC"): string {
  const date: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone };
  // midnight in a short span is where the day changes: say which day
  if (spanMs <= 2 * 86400e3 && new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(t) === "00:00") return new Intl.DateTimeFormat("en-GB", date).format(t);
  const o: Intl.DateTimeFormatOptions = spanMs <= 2 * 86400e3 ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone } : { day: "numeric", month: "short", timeZone };
  return new Intl.DateTimeFormat("en-GB", o).format(t);
}

/** Assign each label a row so labels in the same lane don't overlap: `items` = {x (%), w (% label width)} in x order. */
export function stackLevels(items: { x: number; w: number }[]): number[] {
  const ends: number[] = [];
  return items.map((it) => {
    let lv = ends.findIndex((e) => e <= it.x);
    if (lv < 0) { lv = ends.length; ends.push(0); }
    ends[lv] = it.x + it.w;
    return lv;
  });
}
