// The pages of a multi-page artifact (pages/*.tsx next to index.tsx). index.tsx is the home page.
import type { ComponentType, ReactNode } from "react";
import data from "artifact:pages";
import { allData, meta } from "./registry.ts";
import { HOME } from "./route.ts";

export interface PageMeta {
  title?: string; group?: string; order?: number; summary?: string;
  /** a Status key or {label, tone} */
  status?: string | { label: string; tone?: string };
  icon?: string;
  /** an evidence image path for PageCards */
  thumb?: string;
}
/** What a data-driven page (`pages/[id].tsx`, which exports `pages`) receives: its id and the entry it was listed with. */
export interface PageProps<T = unknown> { id: string; page: PageMeta & { id: string } & T }
export interface PageInfo extends PageMeta { id: string; title: string; order: number; Component: ComponentType<any>; props?: PageProps; [extra: string]: unknown }

type LayoutC = ComponentType<{ children?: ReactNode }>;
interface RawModule { default: ComponentType<any>; page?: PageMeta; pages?: (PageMeta & { id: string })[] | ((data: Record<string, any>) => (PageMeta & { id: string })[]); Layout?: LayoutC }
const pretty = (id: string) => id.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

// Computed on first use: the page modules import the kit, so reading them at import time would be a cycle.
let cache: { home: PageInfo; pages: PageInfo[]; layout?: LayoutC } | undefined;
function load() {
  if (cache) return cache;
  const raw = data as { home: RawModule; layout?: RawModule; pages: { id: string; file?: string; mod: RawModule }[] };
  const h: PageInfo = { ...(raw.home.page ?? {}), id: HOME, title: raw.home.page?.title ?? meta.title, summary: raw.home.page?.summary ?? meta.summary, order: -1, Component: raw.home.default };
  const list: PageInfo[] = [];
  const from = new Map<string, string>([[HOME, "index"]]);
  const add = (p: PageInfo, file: string) => {
    if (from.has(p.id)) throw new Error(`two pages have the id "${p.id}" (${from.get(p.id)} and ${file}): ids are the route (#/${p.id}) and must be unique`);
    from.set(p.id, file); list.push(p);
  };
  for (const p of raw.pages) {
    const file = p.file ?? p.id;
    if (p.mod.pages != null) {
      // one module, many routes: the list comes from code or from data/*.json
      const entries = typeof p.mod.pages === "function" ? p.mod.pages(allData()) : p.mod.pages;
      if (!Array.isArray(entries)) throw new Error(`${file}: \`pages\` must be a list or a function returning one`);
      for (const e of entries) {
        if (!e || typeof e.id !== "string" || !e.id) throw new Error(`${file}: every entry of \`pages\` needs an id (got ${JSON.stringify(e)?.slice(0, 80)})`);
        add({ ...e, id: e.id, title: e.title ?? pretty(e.id), order: e.order ?? 1000 + list.length, Component: p.mod.default, props: { id: e.id, page: e } }, file);
      }
    } else add({ ...(p.mod.page ?? {}), id: p.id, title: p.mod.page?.title ?? pretty(p.id), order: p.mod.page?.order ?? 1000 + list.length, Component: p.mod.default }, file);
  }
  cache = { home: h, pages: list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)), layout: raw.layout?.default ?? raw.layout?.Layout ?? raw.home.Layout };
  return cache;
}
export const home = (): PageInfo => load().home;
/** A `Layout` component (layout.tsx, or exported from index.tsx) that wraps every page and stays mounted across routes. */
export const layout = (): LayoutC | undefined => load().layout;
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
