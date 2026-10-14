// The camera: zoom into a tile, zoom back out to the board, pan to a neighbour. Each move is one navigate() call: the kit
// names just the tile (morph), reports the motion as a transition type (html[data-nav-type]) and the origin as --nav-x/y
// (the tile, zooming in) or --nav-to-x/y (the tile on the board we land on, zooming out).
import { navigate } from "artifact";
import { type Dir, neighbour, noteTravel, ORDER } from "./model.ts";

const html = () => document.documentElement;

const KEY = "zoom-board-visited|artifact kit v0.1";
export function visited(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]")); } catch { return new Set(); }
}
function visit(id: string) {
  const v = visited(); v.add(id);
  try { localStorage.setItem(KEY, JSON.stringify([...v])); } catch { /* private mode */ }
}

/** Zoom into a place on the board, around the tile the reader clicked. */
export function zoomIn(id: string, from?: Element | null) {
  const box = from?.closest<HTMLElement>("[data-morph]") ?? `zt-${id}`;
  visit(id);
  void navigate(id, { morph: box, transition: "zoom-in" });
}

/** Back to the board, zooming out to the tile we came from. */
export function zoomOut(id: string) {
  void navigate("home", { morph: `zt-${id}`, direction: "back", transition: "zoom-out" });
}

/** Pan the camera to a neighbouring place (or any place, given the direction it lies in). */
export function travel(from: string, to: string | undefined, dir: Dir) {
  if (!to || to === from) return;
  noteTravel(from, to);
  visit(to);
  void navigate(to, { direction: dir, transition: "pan" });
}
export const travelDir = (from: string, dir: Dir) => travel(from, neighbour(from, dir), dir);

/** Position in the reading order, for "7 of 28". */
export const indexOf = (id: string) => ORDER().indexOf(id);

/** True when a key press belongs to something else: typing, the host's dialogs, present mode, a focused widget. */
export function keyIsBusy(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return true;
  const t = e.target as HTMLElement;
  if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return true;
  if (t.closest?.(".a-walk, .a-map, [role=tablist], [role=radiogroup], [role=radio], .h-panel, .h-corner, [role=dialog]")) return true;
  const h = html();
  if (h.hasAttribute("data-present") || h.hasAttribute("data-commenting")) return true;
  return !!document.querySelector(".a-lightbox, .h-composer, .h-pop, .h-corner[data-open]");
}

export const ARROWS: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
