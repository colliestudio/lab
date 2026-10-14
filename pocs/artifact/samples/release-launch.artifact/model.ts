import { useData } from "artifact";

export interface Demo { kind: "live" | "shot" | "none"; components?: string[]; props?: Record<string, any>; shot?: string; shotFrom?: string; moreShots?: string[] }
export interface Feature {
  id: string; title: string; theme: string; oneLiner: string; why: string; how: string; demo: Demo;
  round: number; roundLabel: string; commits: string[]; status: "new" | "improved";
}
export interface Theme { id: string; title: string; oneLiner: string }
export interface Removed { id: string; title: string; oneLiner: string; why: string; addedRound: number; removedRound: number; commits: string[]; replacedBy: string }
export interface Round { round: string; date: string; summary: string; tests?: number; commits: string[] }
export interface Release {
  product: string; version: string; date: string; headline: string; intro: string;
  themes: Theme[]; features: Feature[]; rounds: Round[]; removed: Removed[];
  numbers: { rounds: number; tests: number; testsByRound: { round: string; tests: number }[]; components: number; kitCommits: number; customLinesRemovedByPorting: { demo: string; lines: number }[]; demos: number };
  nextUp: { title: string; oneLiner: string }[]; credits: string;
}
export interface Commit { h: string; at: string; s: string }

/** The bento: the features that carry the release, in reading order, with their tile size (cols x rows on a 6-col grid). */
export const HIGHLIGHTS: { id: string; size: "xl" | "tall" | "half" | "third" }[] = [
  { id: "pages", size: "xl" },
  { id: "decision-walk", size: "tall" },
  { id: "map-fit", size: "half" },
  { id: "walkthrough", size: "half" },
  { id: "present-mode", size: "third" },
  { id: "code-notes", size: "third" },
  { id: "timeaxis", size: "third" },
  { id: "scorecard", size: "half" },
  { id: "gallery", size: "half" },
  { id: "feedback-drawer", size: "third" },
  { id: "stages", size: "third" },
  { id: "shot", size: "third" },
];

export function useRelease() {
  const r = useData<Release>("release");
  const commits = useData<Commit[]>("commits");
  const byId = Object.fromEntries(r.features.map((f) => [f.id, f])) as Record<string, Feature>;
  const themeOf = Object.fromEntries(r.themes.map((t) => [t.id, t])) as Record<string, Theme>;
  const hi = new Set(HIGHLIGHTS.map((h) => h.id));
  // ← / → order: the bento first, then everything else grouped by theme
  const rest = r.themes.flatMap((t) => r.features.filter((f) => f.theme === t.id && !hi.has(f.id)));
  const order = [...HIGHLIGHTS.map((h) => byId[h.id]), ...rest];
  return { r, commits, byId, themeOf, order, rest };
}

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Minutes between two ISO times. */
export const minutesBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 60000);
