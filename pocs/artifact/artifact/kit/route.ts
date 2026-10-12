// Hash routes for multi-page artifacts: "#/journey-2" and "#/journey-2/section-id". Anything else ("#section-id") is an in-page anchor.
export interface Route { page: string; section?: string }

export const HOME = "home";

export function parseHash(hash: string): Route | null {
  if (!hash.startsWith("#/")) return null;
  const [page, ...rest] = decodeURIComponent(hash.slice(2)).split("/");
  return { page: page || HOME, section: rest.join("/") || undefined };
}

/** The href for a page (and a section on it): home alone is "#/". */
export function hrefFor(page: string, section?: string): string {
  if (page === HOME && !section) return "#/";
  return `#/${encodeURIComponent(page)}${section ? `/${encodeURIComponent(section)}` : ""}`;
}

/** "journey-2#section" → {page, section}; "#section" → {page: current, section}. */
export function parseTo(to: string, current: string): Route {
  const [p, s] = to.split("#");
  return { page: p || current, section: s || undefined };
}
