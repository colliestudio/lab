import { Fragment, type CSSProperties, type ReactNode } from "react";
import { useData } from "artifact";
import "./story.css";

export interface Feature {
  id: string; title: string; theme: string; oneLiner: string; why: string; how: string;
  demo: { kind: "live" | "shot" | "none"; components?: string[]; props?: Record<string, any>; shot?: string; shotFrom?: string; moreShots?: string[] };
  round: number; roundLabel: string; commits: string[]; status: string;
}
export interface Theme { id: string; title: string; oneLiner: string }
export interface Round { round: string; date: string; summary: string; tests?: number; commits: string[] }
export interface Release {
  product: string; version: string; date: string; headline: string; intro: string;
  themes: Theme[]; rounds: Round[]; features: Feature[];
  removed: { id: string; title: string; oneLiner: string; why: string; addedRound?: number; removedRound?: number; commits?: string[]; replacedBy?: string }[];
  numbers: {
    rounds: number; tests: number; components: number; demos: number; kitCommits: number;
    testsByRound: { round: string; tests: number }[];
    customLinesRemovedByPorting: { demo: string; lines: number }[];
    demoSizes: { demo: string; size: string }[]; sizeNote: string;
  };
  nextUp: { title: string; oneLiner: string }[];
  credits: string;
}

export const useRelease = () => useData<Release>("release");

/** Story order of the chapters (a narrative arc, not the data order) and each chapter's hue (oklch). */
export const CHAPTERS: { id: string; hue: number; kicker: string; title?: string }[] = [
  { id: "authoring", hue: 268, kicker: "The agent" },
  { id: "technical", hue: 200, kicker: "The proof" },
  { id: "reading", hue: 155, kicker: "The reader" },
  { id: "decisions", hue: 65, kicker: "The answer" },
  { id: "multipage", hue: 20, kicker: "The shape" },
  { id: "cli", hue: 315, kicker: "The loop", title: "Under the hood" },
];
/** Beat order inside a chapter, when it should differ from the data (a Walkthrough last, so present mode can keep stepping it). */
const ORDER: Record<string, string[]> = {
  authoring: ["artifact-dir", "status-blocks", "data-evidence", "present-hooks"],
  technical: ["map-fit", "code-notes", "timeaxis", "timeline-lanes", "stages", "walkthrough"],
  reading: ["present-mode", "folding-more", "gallery", "compact-header", "download"],
  decisions: ["decision-walk", "scorecard", "feedback-drawer"],
  multipage: ["pages", "tour"],
  cli: ["cli-core", "check-advice", "shot", "capture", "gather", "evidence-safety"],
};

export function useChapters() {
  const r = useRelease();
  return CHAPTERS.map((c, i) => {
    const t = r.themes.find((x) => x.id === c.id)!;
    const all = r.features.filter((f) => f.theme === c.id);
    const order = ORDER[c.id] ?? [];
    const features = [...all].sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
    return { ...c, n: i + 1, title: c.title ?? t.title, oneLiner: t.oneLiner, features };
  });
}
export type Chapter = ReturnType<typeof useChapters>[number];

export const hue = (h: number) => ({ "--h": h } as CSSProperties);
export const pad = (n: number) => String(n).padStart(2, "0");

/** `code` spans and nothing else: the data's one-liners use backticks. */
export function md(s: string): ReactNode {
  return s.split(/(`[^`]+`)/).map((p, i) => (p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>));
}

export const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Tests per round as a line: small on the story's hero card, large on the rounds page (same Morph name). */
export function Spark({ points, w = 120, h = 36, labels }: { points: { round: string; tests: number }[]; w?: number; h?: number; labels?: boolean }) {
  const min = 80, max = 132;
  const px = (i: number) => 4 + (i * (w - 8)) / (points.length - 1);
  const py = (v: number) => h - 4 - ((v - min) / (max - min)) * (h - 8);
  const d = points.map((p, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(p.tests).toFixed(1)}`).join(" ");
  return (
    <svg className="st-spark" viewBox={`0 0 ${w} ${h}`} width="100%" aria-hidden={!labels} role={labels ? "img" : undefined}
      aria-label={labels ? `Kit tests per round: ${points.map((p) => `${p.round}: ${p.tests}`).join(", ")}` : undefined}>
      <path d={`${d} L${px(points.length - 1)},${h} L${px(0)},${h} Z`} className="st-spark-fill" />
      <path d={d} className="st-spark-line" vectorEffect="non-scaling-stroke" />
      {points.map((p, i) => <circle key={i} cx={px(i)} cy={py(p.tests)} r={labels ? 0.9 : 1.6} className="st-spark-dot" />)}
    </svg>
  );
}

/** Scroll so `el` sits where a reader would want it: beats centred, big moments at the top. */
export function scrollToEl(el: Element | null, block: ScrollLogicalPosition = "start") {
  if (!el) return;
  el.scrollIntoView({ block, behavior: reduced() ? "auto" : "smooth" });
}

