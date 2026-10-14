export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "1,3,5-7" | [1,3] | [[5,7]] → sorted unique numbers. */
export function parseNums(v: string | number | (number | [number, number])[] | undefined): number[] | undefined {
  if (v == null) return undefined;
  const out = new Set<number>();
  const add = (a: number, b = a) => { for (let i = a; i <= b; i++) out.add(i); };
  if (typeof v === "number") add(v);
  else if (typeof v === "string") {
    for (const part of v.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [a, b] = part.split("-").map(Number);
      add(a, b ?? a);
    }
  } else for (const x of v) Array.isArray(x) ? add(x[0], x[1]) : add(x);
  return [...out].sort((a, b) => a - b);
}
export const fmtDate = (s?: string) => {
  if (!s) return "";
  const d = new Date(s);
  return isNaN(+d) ? s : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

/** Round tick values (1, 2, 2.5, 5 × 10ⁿ) covering 0…max. */
export function niceTicks(maxIn: number, count = 5): { ticks: number[]; max: number } {
  if (!(maxIn > 0)) return { ticks: [0, 1], max: 1 };
  const p = 10 ** Math.floor(Math.log10(maxIn / count));
  const step = [1, 2, 2.5, 5, 10, 20].map((m) => m * p).find((st) => Math.ceil(maxIn / st - 1e-9) <= count)!;
  const n = Math.ceil(maxIn / step - 1e-9);
  const ticks = Array.from({ length: n + 1 }, (_, i) => Math.round(i * step * 1e6) / 1e6);
  return { ticks, max: ticks[ticks.length - 1] };
}

/** "3d ago" for an ISO time, measured from `asOf` (the gather time) or now. */
export function ageOf(iso: string, asOf?: string): { text: string; days: number } {
  const ms = (asOf ? Date.parse(asOf) : Date.now()) - Date.parse(iso);
  if (isNaN(ms)) return { text: String(iso), days: 0 };
  const m = Math.max(0, ms / 60000);
  const text = m < 1 ? "just now" : m < 60 ? `${Math.round(m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  return { text, days: m / 1440 };
}

/** "12 Oct 2026, 13:18 UTC": a date-time in one stated zone (`timeZone` IANA name, default UTC). */
export function fmtAsOf(iso: string, timeZone = "UTC"): string {
  const d = new Date(iso);
  if (isNaN(+d)) return iso;
  try { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone, timeZoneName: "short" }).format(d); } catch { return iso; }
}
