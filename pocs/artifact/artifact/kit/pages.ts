// The pages of a multi-page artifact (pages/*.tsx next to index.tsx). index.tsx is the home page.
import type { ComponentType } from "react";
import data from "artifact:pages";
import { meta } from "./registry.ts";
import { HOME } from "./route.ts";

export interface PageMeta {
  title?: string; group?: string; order?: number; summary?: string;
  /** a Status key or {label, tone} */
  status?: string | { label: string; tone?: string };
  icon?: string;
  /** an evidence image path for PageCards */
  thumb?: string;
}
export interface PageInfo extends PageMeta { id: string; title: string; order: number; Component: ComponentType }

interface RawModule { default: ComponentType; page?: PageMeta }
const pretty = (id: string) => id.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

// Computed on first use: the page modules import the kit, so reading them at import time would be a cycle.
let cache: { home: PageInfo; pages: PageInfo[] } | undefined;
function load() {
  if (cache) return cache;
  const raw = data as { home: RawModule; pages: { id: string; mod: RawModule }[] };
  const h: PageInfo = { ...(raw.home.page ?? {}), id: HOME, title: raw.home.page?.title ?? meta.title, summary: raw.home.page?.summary ?? meta.summary, order: -1, Component: raw.home.default };
  const list: PageInfo[] = raw.pages.map((p, i) => ({ ...(p.mod.page ?? {}), id: p.id, title: p.mod.page?.title ?? pretty(p.id), order: p.mod.page?.order ?? 1000 + i, Component: p.mod.default }));
  cache = { home: h, pages: list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) };
  return cache;
}
export const home = (): PageInfo => load().home;
/** The pages other than home, in nav order (by `order`, then file name). */
export const pages = (): PageInfo[] => load().pages;
export const isMulti = (): boolean => load().pages.length > 0;
/** Home first, then the others: the order of prev/next. */
export const allPages = (): PageInfo[] => [load().home, ...load().pages];
export const pageById = (id: string) => allPages().find((p) => p.id === id);

/** Groups of pages in order of first appearance; ungrouped pages come first under `""`. */
export function groups(): { name: string; pages: PageInfo[] }[] {
  const out: { name: string; pages: PageInfo[] }[] = [];
  for (const p of pages()) {
    const name = p.group ?? "";
    let g = out.find((x) => x.name === name);
    if (!g) { g = { name, pages: [] }; out.push(g); }
    g.pages.push(p);
  }
  return out.sort((a, b) => (a.name === "" ? -1 : b.name === "" ? 1 : 0));
}
