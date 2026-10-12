// Routing primitives for artifacts that own their layout: the page list, the current route, navigate() and the
// view-transition helper behind it.
import { useSyncExternalStore, type CSSProperties, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { allPages } from "./pages.ts";
import { HOME, hrefFor, parseHash, type Params } from "./route.ts";

export interface PageEntry {
  id: string; title: string; order: number; href: string;
  group?: string; summary?: string; status?: string | { label: string; tone?: string }; icon?: string; thumb?: string;
  /** Any other fields a data-driven page (`pages/[id].tsx`) listed for itself. */
  [extra: string]: unknown;
}
export interface RouteState {
  page: string; anchor?: string;
  /** Free-form `?k=v` state in the hash; the host never scrolls to it. */
  params: Params;
  /** The page we came from (undefined on first load); lets a page find "where we came from" without module state. */
  previous?: string;
  /** "forward" | "back" | whatever `navigate({direction})` said. Browser back/forward report "back"/"forward". */
  direction?: string;
  /** True when this arrival should put the page's scroll position back (back button or `navigate({restore: true})`). */
  restore?: boolean;
}

let entries: PageEntry[] | undefined;
/** Every page in order, home first (then by `order`, then id), with the `page` meta each one exports. */
export function usePages(): PageEntry[] {
  return (entries ??= allPages().map(({ Component: _c, props: _p, ...m }) => ({ ...m, href: hrefFor(m.id) })));
}

// One snapshot object per hash, so useSyncExternalStore sees a stable value. A plain "#anchor" keeps the page.
let snap: RouteState & { hash: string } = { hash: "\0", page: HOME, params: {} };
let pending: { direction?: string; restore?: boolean } | null = null;
function read(): RouteState {
  if (typeof location === "undefined") return snap;
  const h = location.hash;
  if (h === snap.hash) return snap;
  const r = parseHash(h);
  const nav = pending; pending = null;
  const first = snap.hash === "\0";
  const next = r ? { page: r.page, anchor: r.section, params: r.params } : h === "" || h === "#" ? { page: HOME, params: {} } : { page: first ? HOME : snap.page, anchor: decodeURIComponent(h.slice(1)), params: first ? {} : snap.params };
  snap = { hash: h, ...next, previous: first ? undefined : next.page !== snap.page ? snap.page : snap.previous, direction: nav?.direction, restore: nav?.restore };
  return snap;
}
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

/** The current page id, the section/anchor, the `?params`, and where we came from. */
export function useRoute(): RouteState {
  return useSyncExternalStore(subscribe, read, read);
}

// --- scroll positions: saved when leaving a page, put back (and held while async layout settles) on return ---
const positions = new Map<string, number>();
export const savedScroll = (page: string): number | undefined => positions.get(page);
let hold: (() => void) | undefined;
/** Scroll to `y` and keep it there for ~1.2 s while images/maps/layout shift, until the reader scrolls on their own. */
export function holdScroll(y: number): void {
  hold?.();
  const to = () => scrollTo({ top: y, behavior: "instant" });
  to();
  let stop = false;
  const end = () => { stop = true; for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) removeEventListener(e, end, true); if (hold === end) hold = undefined; };
  for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) addEventListener(e, end, { capture: true, passive: true });
  hold = end;
  const t0 = performance.now();
  const tick = () => { if (stop) return; if (Math.abs(scrollY - y) > 2) to(); if (performance.now() - t0 < 1200) requestAnimationFrame(tick); else end(); };
  requestAnimationFrame(tick);
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- the view-transition helper ---

type VT = { finished: Promise<unknown>; ready: Promise<unknown>; updateCallbackDone: Promise<unknown> };
type StartVT = (o: (() => void) | { update: () => void; types?: string[] }) => VT;
const supportsTypes = () => { const V = (globalThis as { ViewTransition?: { prototype: object } }).ViewTransition; return !!V && "types" in V.prototype; };
const DEV = typeof __ARTIFACT_DEV__ !== "undefined" && __ARTIFACT_DEV__;
const ident = (s: string) => s.replace(/[^\w-]+/g, "-").replace(/^(\d)/, "n$1");
const morphEls = (key: string) => [...document.querySelectorAll<HTMLElement>("[data-morph]")].filter((e) => e.dataset.morph === key);

/** Names that more than one rendered element carries (Chrome aborts the whole transition, silently). */
export function duplicateTransitionNames(root: ParentNode = document): string[] {
  const seen = new Map<string, number>();
  const nodes = DEV ? root.querySelectorAll<HTMLElement>("*") : root.querySelectorAll<HTMLElement>('[style*="view-transition-name"]');
  for (const el of nodes) {
    const n = DEV ? getComputedStyle(el).getPropertyValue("view-transition-name") : el.style.getPropertyValue("view-transition-name");
    if (!n || n === "none" || n.startsWith("match-element") || !el.getClientRects().length) continue;
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  return [...seen].filter(([, c]) => c > 1).map(([n]) => n);
}
let epoch = 0; // a newer transition owns html[data-nav-*] and the vars; an older one finishing must not wipe them
const warned = new Set<string>();
function warnDuplicates() {
  for (const n of duplicateTransitionNames()) if (!warned.has(n)) { warned.add(n); console.warn(`[artifact] view-transition-name "${n}" is on more than one element: the browser skips the transition. Name one element per transition (navigate({morph}) does).`); }
}

export interface TransitionOpts {
  /** View-transition types for `:active-view-transition-type(x)`; also written to `html[data-nav-type]` as a fallback. */
  types?: string[];
  /** "forward" | "back" | …: `html[data-nav-dir]` during the transition, and a type of the same name. */
  direction?: string;
  /** One element pair to morph: the source (an element, or a `data-morph` key) is named now, the element with the same `data-morph` after the update. */
  morph?: Element | string;
}

/**
 * Run `update` (a state change that re-renders; it is flushed synchronously) inside a View Transition. Sets
 * `html[data-nav-dir]`, `html[data-nav-type]` and the origin vars `--nav-x/y/w/h` (the morph source's box in px) and
 * `--nav-to-x/y/w/h` (the target's, once rendered) for the duration; `morph` names exactly one pair, for this transition only.
 * Without View Transitions, or under reduced motion, it just runs `update`. Resolves when the transition has finished.
 */
export function withTransition(update: () => void, o: TransitionOpts = {}): Promise<void> {
  const d = typeof document === "undefined" ? undefined : (document as Document & { startViewTransition?: StartVT });
  if (!d?.startViewTransition || reduced()) { update(); return Promise.resolve(); }
  const root = document.documentElement;
  const key = typeof o.morph === "string" ? o.morph : (o.morph as HTMLElement | undefined)?.dataset?.morph ?? "morph";
  const src = o.morph == null ? undefined : typeof o.morph === "string" ? morphEls(o.morph)[0] : (o.morph as HTMLElement);
  const name = ident(key);
  const named: [HTMLElement, string][] = [];
  const nameIt = (el: HTMLElement) => { named.push([el, el.style.getPropertyValue("view-transition-name")]); el.style.setProperty("view-transition-name", name); };
  const types = [...new Set([...(o.direction ? [o.direction] : []), ...(o.types ?? [])])];
  const vars = (p: string, el?: Element) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    for (const [k, v] of Object.entries({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height })) root.style.setProperty(`--nav-${p}${k}`, `${Math.round(v)}px`);
  };
  const mine = ++epoch;
  if (o.direction) root.dataset.navDir = o.direction;
  if (types.length) root.dataset.navType = types.join(" ");
  if (src) { vars("", src); nameIt(src as HTMLElement); }
  warnDuplicates();
  const cleanup = () => {
    for (const [el, prev] of named) { if (prev) el.style.setProperty("view-transition-name", prev); else el.style.removeProperty("view-transition-name"); }
    if (mine !== epoch) return;
    delete root.dataset.navDir; delete root.dataset.navType;
    for (const p of ["", "to-"]) for (const k of ["x", "y", "w", "h"]) root.style.removeProperty(`--nav-${p}${k}`);
  };
  const run = () => {
    flushSync(update);
    if (src || o.morph != null) {
      const to = morphEls(key).find((e) => e !== src);
      if (to) { nameIt(to); vars("to-", to); }
    }
    warnDuplicates();
  };
  try {
    const t = types.length && supportsTypes() ? d.startViewTransition({ update: run, types }) : d.startViewTransition(run);
    t.ready.catch(() => {}); t.updateCallbackDone.catch(() => {}); // a skipped transition rejects these; nobody needs to hear
    const done = () => cleanup();
    t.finished.then(done, done);
    return t.finished.then(() => {}, () => {});
  } catch (e) { cleanup(); update(); return Promise.resolve(); }
}

// --- browser back/forward and links that bypass navigate(): same transition, direction from the history ---
let selfHash: string | null = null;
let traversing = false;
const navIdx = () => (window as unknown as { navigation?: { currentEntry?: { index: number } } }).navigation?.currentEntry?.index ?? null;
let lastIdx: number | null = null;
if (typeof window !== "undefined") {
  lastIdx = navIdx();
  // Navigation API where there is one (popstate also fires for some fragment pushes); popstate elsewhere
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  if (nav) nav.addEventListener("navigate", (e) => { traversing = (e as Event & { navigationType?: string }).navigationType === "traverse"; });
  else addEventListener("popstate", () => { traversing = true; });
  addEventListener("hashchange", () => {
    const idx = navIdx();
    const back = traversing ? (idx != null && lastIdx != null ? idx < lastIdx : true) : false;
    const wasTraverse = traversing;
    traversing = false; lastIdx = idx;
    if (selfHash === location.hash) { selfHash = null; return; } // navigate() already rendered this one
    positions.set(snap.page, scrollY);
    const dir = back ? "back" : "forward";
    pending = { direction: dir, restore: wasTraverse };
    const r = parseHash(location.hash);
    if (r && r.page !== snap.page) void withTransition(emit, { direction: dir }); else emit();
  });
}

export interface NavOpts {
  /** A section/element id to scroll to on the page. */
  anchor?: string;
  /** `?k=v` state on the page; `undefined` drops a key. The host never scrolls to these. */
  params?: Record<string, string | undefined>;
  /** Morph exactly this element pair for this transition: the source element (or its `data-morph` key) and the element with the same `data-morph` on the new page. One-shot: names are removed afterwards. */
  morph?: Element | string;
  /** "forward" (default) | "back" | any string: `html[data-nav-dir]` and a view-transition type of that name. */
  direction?: string;
  /** `false` skips the transition; a string or list adds view-transition types. */
  transition?: boolean | string | string[];
  /** Put the page's saved scroll position back (as the back button does). */
  restore?: boolean;
  /** Replace the history entry instead of adding one. */
  replace?: boolean;
}

/**
 * Go to a page (and an anchor, and `?params`, on it). Uses a View Transition when the browser has them and the reader allows
 * motion; otherwise it switches at once. Returns when the transition has finished.
 */
export function navigate(id: string, opts: NavOpts = {}): Promise<void> {
  if (typeof location === "undefined") return Promise.resolve();
  const href = hrefFor(id, opts.anchor, opts.params);
  if (location.hash === href || (href === "#/" && (location.hash === "" || location.hash === "#"))) return Promise.resolve();
  const cur = read();
  const samePage = cur.page === id;
  positions.set(cur.page, scrollY);
  const direction = opts.direction ?? "forward";
  const apply = () => {
    pending = { direction, restore: opts.restore };
    if (opts.replace) history.replaceState(null, "", href); else { selfHash = href; location.hash = href; }
    lastIdx = navIdx();
    emit();
    if (!opts.anchor && !samePage) scrollTo({ top: (opts.restore ? positions.get(id) : undefined) ?? 0, behavior: "instant" });
  };
  if (opts.transition === false) { apply(); return Promise.resolve(); }
  return withTransition(apply, { direction, morph: opts.morph, types: typeof opts.transition === "string" ? [opts.transition] : Array.isArray(opts.transition) ? opts.transition : undefined });
}

/** onClick for an `<a href="#/…">`: plain left clicks go through navigate() (with the transition), the rest stay browser defaults. */
export function navClick(id: string, anchor?: string) {
  return (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void navigate(id, { anchor });
  };
}

/**
 * Marks an element as one end of a morph. By default it also keeps a permanent view-transition `name` (the same name on a
 * card and on the page it opens morphs on every navigate(); a name must be unique on a page). With `when={false}` it only
 * carries `data-morph`, and `navigate(id, { morph: name })` names that pair for one transition: use this for lists and boards.
 */
export function Morph({ name, when = true, children, style, className, as: Tag = "div" }: { name: string; when?: boolean; children?: React.ReactNode; style?: CSSProperties; className?: string; as?: React.ElementType }) {
  return <Tag className={className} data-morph={name} style={{ ...(when ? { viewTransitionName: ident(name) } : {}), ...style } as CSSProperties}>{children}</Tag>;
}
