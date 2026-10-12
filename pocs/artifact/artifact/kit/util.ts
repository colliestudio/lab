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
