// Where a board lives on a canvas service: /b/<name> opens it, the list is at /.

/** The board a served page path names: "/b/my%20board/" is "my board". null for any other path. */
export function servedBoardName(pathname: string): string | null {
  const m = /^\/b\/(.+?)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** The page of a board. */
export const boardHref = (name: string) => `/b/${encodeURIComponent(name)}`;

/** The live document of a board on the page's own origin. */
export function boardWsUrl(loc: Pick<Location, 'protocol' | 'host'>, name: string): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws/${encodeURIComponent(name)}`;
}
