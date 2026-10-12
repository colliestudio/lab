// Path globs shared by the parser (`files` blocks) and the viewer (map node `files`).
// `*` = one path segment's worth, `**` = any depth, `?` = one char; a bare directory matches everything under it.

export function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(/.*)?$`);
}

export const isGlob = (s: string) => /[*?]/.test(s);

export const matchAny = (path: string, globs: string[] | undefined) =>
  !!globs?.some((g) => globToRe(g).test(path));
