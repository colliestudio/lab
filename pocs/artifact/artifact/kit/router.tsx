// Routing primitives for artifacts that own their layout: the page list, the current route, and navigate().
import { useSyncExternalStore, type CSSProperties, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { allPages } from "./pages.ts";
import { HOME, hrefFor, parseHash } from "./route.ts";

export interface PageEntry {
  id: string; title: string; order: number; href: string;
  group?: string; summary?: string; status?: string | { label: string; tone?: string }; icon?: string; thumb?: string;
}
export interface RouteState { page: string; anchor?: string }

let entries: PageEntry[] | undefined;
/** Every page in order, home first (then by `order`, then id), with the `page` meta each one exports. */
export function usePages(): PageEntry[] {
  return (entries ??= allPages().map(({ Component: _c, ...m }) => ({ ...m, href: hrefFor(m.id) })));
}

// One snapshot object per hash, so useSyncExternalStore sees a stable value. A plain "#anchor" keeps the page.
let snap: RouteState & { hash: string } = { hash: "\0", page: HOME };
function read(): RouteState {
  if (typeof location === "undefined") return snap;
  const h = location.hash;
  if (h === snap.hash) return snap;
  const r = parseHash(h);
  if (r) snap = { hash: h, page: r.page, anchor: r.section };
  else if (h === "" || h === "#") snap = { hash: h, page: HOME };
  else snap = { hash: h, page: snap.hash === "\0" ? HOME : snap.page, anchor: decodeURIComponent(h.slice(1)) };
  return snap;
}
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
if (typeof window !== "undefined") addEventListener("hashchange", emit);
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

/** The current page id and the section/anchor in the hash. */
export function useRoute(): RouteState {
  return useSyncExternalStore(subscribe, read, read);
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Go to a page (and an anchor on it). Uses a View Transition when the browser has them and the reader allows motion
 * (elements sharing a `<Morph name>` on both pages morph); otherwise it switches at once. Pass `transition: false` to skip.
 */
export function navigate(id: string, opts: { anchor?: string; transition?: boolean } = {}): void {
  if (typeof location === "undefined") return;
  const href = hrefFor(id, opts.anchor);
  if (location.hash === href || (href === "#/" && (location.hash === "" || location.hash === "#"))) return;
  const samePage = read().page === id;
  const apply = () => {
    location.hash = href;
    emit();
    if (!opts.anchor && !samePage) scrollTo({ top: 0, behavior: "instant" });
  };
  const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (opts.transition === false || !d.startViewTransition || reduced()) { apply(); return; }
  d.startViewTransition(() => { flushSync(apply); });
}

/** onClick for an `<a href="#/…">`: plain left clicks go through navigate() (with the transition), the rest stay browser defaults. */
export function navClick(id: string, anchor?: string) {
  return (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(id, { anchor });
  };
}

/**
 * Give an element a view-transition name: the same `name` on one page (a card's thumbnail) and the next (the hero) makes
 * it morph there on navigate(). A name must be unique on a page.
 */
export function Morph({ name, children, style, className, as: Tag = "div" }: { name: string; children?: React.ReactNode; style?: CSSProperties; className?: string; as?: React.ElementType }) {
  return <Tag className={className} style={{ viewTransitionName: name, ...style } as CSSProperties}>{children}</Tag>;
}
