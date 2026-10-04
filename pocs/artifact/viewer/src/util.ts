import type { Change, Doc, FileChange, MapNode, Section } from "../../src/model.ts";

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");

export { globToRe, matchAny } from "../../src/glob.ts";
import { matchAny } from "../../src/glob.ts";

export const LEVELS = [
  { n: 0, name: "Headline" },
  { n: 1, name: "Map" },
  { n: 2, name: "Areas" },
  { n: 3, name: "Code" },
] as const;

export const CHANGE_LABEL: Record<Change, string> = {
  added: "added", changed: "changed", removed: "removed", unchanged: "context", planned: "planned", deferred: "deferred",
};

export const changeLetter = (f: FileChange) =>
  f.oldPath && f.oldPath !== f.path ? "R" : f.change === "added" ? "A" : f.change === "removed" ? "D" : "M";

export const diffId = (path: string) => `diff-${path}`;
export const sectionDomId = (id: string) => `section-${id}`;

const LANG: Record<string, string> = {
  go: "go", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  json: "json", yaml: "yaml", yml: "yaml", md: "markdown", sql: "sql", py: "python", rs: "rust", sh: "bash",
  css: "css", html: "xml", toml: "ini", mod: "go", sum: "plaintext",
};
export const langOf = (path?: string) => (path ? LANG[path.split(".").pop()?.toLowerCase() ?? ""] : undefined);

/** Which section each file belongs to (via map node globs). */
export function fileSections(doc: Doc): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of doc.files) {
    const n = doc.map.nodes.find((n) => n.section && matchAny(f.path, n.files));
    if (n?.section) out.set(f.path, n.section);
  }
  return out;
}

export function nodeForSection(doc: Doc, sectionId: string): MapNode | undefined {
  return doc.map.nodes.find((n) => n.section === sectionId);
}

/** Sections in source order, mechanical ones moved to the end. */
export function orderedSections(doc: Doc): Section[] {
  return [...doc.sections.filter((s) => !s.mechanical), ...doc.sections.filter((s) => s.mechanical)];
}

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function fmtDate(s?: string) {
  if (!s) return "";
  const d = new Date(s);
  return isNaN(+d) ? s : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
