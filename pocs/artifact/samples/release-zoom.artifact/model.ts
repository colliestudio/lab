// One layout model for the whole map: the board, the minimap, arrow-key neighbours and the zoom origin all read it.
import { useData } from "artifact";

export interface Feature {
  id: string; title: string; theme: string; oneLiner: string; why: string; how: string;
  demo: { kind: "live" | "shot" | "none"; components?: string[]; props?: Record<string, any>; shot?: string; shotFrom?: string; moreShots?: string[] };
  round: number; roundLabel: string; commits: string[]; status: "new" | "improved";
}
export interface Theme { id: string; title: string; oneLiner: string }
export interface Removed { id: string; title: string; oneLiner: string; why: string; addedRound?: number; removedRound?: number; commits?: string[]; replacedBy?: string }
export interface Release {
  product: string; version: string; date: string; headline: string; intro: string;
  themes: Theme[]; features: Feature[]; removed: Removed[];
  rounds: { round: string; date: string; summary: string; tests?: number; commits: string[] }[];
  numbers: { rounds: number; tests: number; testsByRound: { round: string; tests: number }[]; components: number; demos: number; kitCommits: number; customLinesRemovedByPorting: { demo: string; lines: number }[] };
  nextUp: { title: string; oneLiner: string }[]; credits: string;
}

let cache: Release | undefined;
export const rel = (): Release => (cache ??= useData<Release>("release"));
export const feature = (id: string) => rel().features.find((f) => f.id === id)!;
export const theme = (id: string) => rel().themes.find((t) => t.id === id)!;

/** Short tile labels (the full titles are on each page). */
export const LABEL: Record<string, string> = {
  "artifact-dir": "Artifact directories", "data-evidence": "Evidence inlined", "status-blocks": "Status blocks", "present-hooks": "Present steps hook",
  "present-mode": "Present mode", "compact-header": "Compact header", "folding-more": "Folding and <More>", download: "Download one file", gallery: "Gallery",
  "decision-walk": "Decision walk", "feedback-drawer": "Feedback drawer", scorecard: "Scorecard, RiskMatrix",
  "map-fit": "Map fits its column", "code-notes": "Code and diffs, noted", timeaxis: "TimeAxis", "timeline-lanes": "Timeline lanes", walkthrough: "Walkthrough", stages: "Stages",
  "cli-core": "new, dev, check, build", "evidence-safety": "Evidence stays inside", shot: "artifact shot", capture: "artifact capture", gather: "artifact gather", "check-advice": "Taste advice in check",
  pages: "Multi-page", tour: "Tour across pages",
};

/** Region subtitles, shortened from the theme one-liners. */
export const SUB: Record<string, string> = {
  authoring: "TSX, data, evidence. The agent picks the shape.",
  reading: "Present, fold, download: the host's reading layer.",
  decisions: "Answer on the page, copy it back in one paste.",
  technical: "Maps, real diffs, time axes, step-by-step walks.",
  cli: "Agents gather, check and look at their own output.",
  multipage: "Many pages, one HTML file.",
};

/** Hue per theme (oklch); the CSS derives tint, line and ink for both themes from it. */
export const HUE: Record<string, number> = { authoring: 292, reading: 250, decisions: 70, technical: 170, cli: 215, multipage: 345 };

// The map: a 5-column x 6-row grid of tile slots in three bands, a left column (intro on top, removed in the corner)
// and the next-up edge on the right. Each region lists its tiles in row-major order.
export const REGIONS: { theme: string; col: number; row: number; cols: number; rows: number; tiles: string[]; note?: "call" | "self" }[] = [
  { theme: "authoring", col: 0, row: 0, cols: 2, rows: 2, tiles: ["artifact-dir", "data-evidence", "status-blocks", "present-hooks"] },
  { theme: "reading", col: 2, row: 0, cols: 3, rows: 2, tiles: ["present-mode", "folding-more", "gallery", "compact-header", "download"] },
  { theme: "technical", col: 0, row: 2, cols: 3, rows: 2, tiles: ["map-fit", "code-notes", "walkthrough", "timeaxis", "timeline-lanes", "stages"] },
  { theme: "decisions", col: 3, row: 2, cols: 2, rows: 2, tiles: ["decision-walk", "scorecard", "feedback-drawer"], note: "call" },
  { theme: "cli", col: 0, row: 4, cols: 3, rows: 2, tiles: ["cli-core", "shot", "capture", "check-advice", "gather", "evidence-safety"] },
  { theme: "multipage", col: 3, row: 4, cols: 2, rows: 2, tiles: ["pages", "tour"], note: "self" },
];

/** Board geometry in board units (1 unit = 1 px at scale 1). */
export const G = { W: 1600, H: 980, M: 30, LEFT: 300, GUT: 22, EDGE: 236, TW: 174, TH: 108, GAP: 12, PAD: 14, HEAD: 66, RGAP: 16, BGAP: 16 };

export interface Slot { id: string; theme: string; gx: number; gy: number; x: number; y: number; w: number; h: number }
export interface RegionBox { theme: string; x: number; y: number; w: number; h: number; tiles: Slot[]; note?: { kind: "call" | "self"; x: number; y: number; w: number; h: number } }

const regionW = (cols: number) => 2 * G.PAD + cols * G.TW + (cols - 1) * G.GAP;
const bandH = G.HEAD + 2 * G.TH + G.GAP + G.PAD;
export const MID_X = G.M + G.LEFT + G.GUT;
export const MID_W = regionW(2) + G.RGAP + regionW(3);
export const EDGE_X = MID_X + MID_W + G.GUT;
export const BAND_H = bandH;
export const BOARD_H = 2 * G.M + 3 * bandH + 2 * G.BGAP;

let boxes: RegionBox[] | undefined;
export function layout(): RegionBox[] {
  if (boxes) return boxes;
  boxes = REGIONS.map((r) => {
    const x = MID_X + (r.col === 0 ? 0 : regionW(r.col === 2 ? 2 : 3) + G.RGAP);
    const y = G.M + (r.row / 2) * (bandH + G.BGAP);
    const w = regionW(r.cols), h = bandH;
    const tiles = r.tiles.map((id, i) => {
      const c = i % r.cols, rr = Math.floor(i / r.cols);
      return { id, theme: r.theme, gx: r.col + c, gy: r.row + rr, x: x + G.PAD + c * (G.TW + G.GAP), y: y + G.HEAD + rr * (G.TH + G.GAP), w: G.TW, h: G.TH };
    });
    const used = r.tiles.length, free = r.cols * r.rows - used;
    let note: RegionBox["note"];
    if (r.note && free > 0) {
      const c = used % r.cols, rr = Math.floor(used / r.cols);
      note = { kind: r.note, x: x + G.PAD + c * (G.TW + G.GAP), y: y + G.HEAD + rr * (G.TH + G.GAP), w: (r.cols - c) * G.TW + (r.cols - c - 1) * G.GAP, h: G.TH };
    }
    return { theme: r.theme, x, y, w, h, tiles, note };
  });
  return boxes;
}
export const slots = (): Slot[] => layout().flatMap((r) => r.tiles);
export const slot = (id: string) => slots().find((s) => s.id === id);

/** Every place you can zoom into, in reading order: the tiles, then the removed corner and the next-up edge. */
export const ORDER = (): string[] => [...REGIONS.flatMap((r) => r.tiles), "removed", "next"];

/** Grid position of a page: tiles on the 5x6 grid, removed at the bottom-left corner, next along the right edge. */
function pos(id: string, fromY = 0): { x: number; y: number } | undefined {
  if (id === "removed") return { x: -1, y: 4.5 };
  if (id === "next") return { x: 5, y: fromY };
  const s = slot(id);
  return s && { x: s.gx, y: s.gy };
}
export type Dir = "left" | "right" | "up" | "down";
const D: Record<Dir, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
/** The nearest place in a direction (straight ahead first, then sideways). */
export function neighbour(id: string, dir: Dir): string | undefined {
  const [dx, dy] = D[dir];
  if ((id === "removed" || id === "next") && dy) return; // the corner and the edge only open sideways
  const me = pos(id, lastRow(id));
  if (!me) return;
  let best: string | undefined, score = Infinity;
  for (const o of ORDER()) {
    if (o === id) continue;
    const p = pos(o, me.y)!;
    const along = (p.x - me.x) * dx + (p.y - me.y) * dy;
    if (along <= 0.01) continue;
    const side0 = Math.abs((p.x - me.x) * dy) + Math.abs((p.y - me.y) * dx);
    if (side0 > 1.6) continue; // nothing in that direction: the edge of the map
    const side = Math.abs((p.x - me.x) * dy) + Math.abs((p.y - me.y) * dx);
    const s = along + side * 2.2;
    if (s < score) { score = s; best = o; }
  }
  return best;
}
// The next-up edge spans every row: remember which row you came from so ← returns there.
let edgeRow = 0;
function lastRow(id: string) { return id === "next" ? edgeRow : 0; }
export function noteTravel(from: string, to: string) {
  if (to === "next") edgeRow = pos(from)?.y ?? 0;
}
