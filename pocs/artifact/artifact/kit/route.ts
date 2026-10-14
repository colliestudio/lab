// Hash routes for multi-page artifacts: "#/journey-2", "#/journey-2/section-id" and "#/journey-2?tab=a&f=x".
// The section is a scroll target; params are free-form state the host never scrolls to. Anything else ("#section-id") is an in-page anchor.
export type Params = Record<string, string>;
export interface Route { page: string; section?: string; params: Params }

export const HOME = "home";

export function parseHash(hash: string): Route | null {
  if (!hash.startsWith("#/")) return null;
  const [path, query = ""] = splitQuery(hash.slice(2));
  const [page, ...rest] = decodeURIComponent(path).split("/");
  const params: Params = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { page: page || HOME, section: rest.join("/") || undefined, params };
}
const splitQuery = (s: string): [string, string?] => { const i = s.indexOf("?"); return i < 0 ? [s] : [s.slice(0, i), s.slice(i + 1)]; };

/** The href for a page (and a section and params on it): home alone is "#/". Params with an undefined value are left out. */
export function hrefFor(page: string, section?: string, params?: Record<string, string | undefined>): string {
  const q = new URLSearchParams(Object.entries(params ?? {}).filter((e): e is [string, string] => e[1] != null)).toString();
  if (page === HOME && !section && !q) return "#/";
  return `#/${encodeURIComponent(page)}${section ? `/${encodeURIComponent(section)}` : ""}${q ? `?${q}` : ""}`;
}

/** "journey-2#section" → {page, section}; "#section" → {page: current, section}. */
export function parseTo(to: string, current: string): { page: string; section?: string } {
  const [p, s] = to.split("#");
  return { page: p || current, section: s || undefined };
}
