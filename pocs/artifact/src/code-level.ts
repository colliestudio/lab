// `recap build --code none|key|full`: strips code from the model before it is inlined, so it is absent from the HTML.
//   full  every hunk of changes.patch (doc.files) plus the blocks
//   key   only what diff/code blocks show (they carry their own hunks/code); doc.files keep paths and counts
//   none  no code at all: diff/code blocks keep file, notes and their line range
import { createHash } from "node:crypto";
import type { Block, CodeLevel, Doc, Hunk, Section } from "./model.ts";

export const CODE_LEVELS: readonly CodeLevel[] = ["none", "key", "full"];

export function parseCodeLevel(v: string | undefined, fallback: CodeLevel = "key"): CodeLevel {
  if (v === undefined || v === "true") return fallback;
  if (!(CODE_LEVELS as readonly string[]).includes(v)) throw new Error(`--code must be one of ${CODE_LEVELS.join(", ")}`);
  return v as CodeLevel;
}

/** GitHub's per-file anchor on a PR's files tab: `#diff-<sha256(path)>`. */
export function prFileUrl(pr: string | undefined, path: string): string | undefined {
  const m = pr && /^(https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+)/.exec(pr);
  return m ? `${m[1]}/files#diff-${createHash("sha256").update(path).digest("hex")}` : undefined;
}

/** A copy of `doc` with code stripped to `level` (`doc` itself for full, or when there is no code to strip). */
export function applyCodeLevel(doc: Doc, level: CodeLevel): Doc {
  if (level === "full") return doc;
  const files = doc.files.map((f) => (f.hunks.length
    ? { ...f, hunks: [], omitted: true, ...(prFileUrl(doc.meta.pr, f.path) ? { url: prFileUrl(doc.meta.pr, f.path) } : {}) }
    : f));
  let stripped = files.some((f, i) => f !== doc.files[i]);
  const block = (b: Block): Block => {
    if (level !== "none" || (b.type !== "diff" && b.type !== "code")) return b;
    stripped = true;
    return stripBlock(b);
  };
  const section = (s: Section): Section => ({ ...s, blocks: s.blocks.map(block) });
  const overviewBlocks = (doc.overviewBlocks ?? []).map(block), sections = doc.sections.map(section);
  if (!stripped) return doc;   // nothing to strip (e.g. a plan without a patch): no badge
  return {
    ...doc, files, codeLevel: level,
    overviewBlocks, sections,
  };
}

function stripBlock(b: Block): Block {
  if (b.type === "diff") {
    const range = newRange(b.hunks);
    return { ...b, hunks: [], omitted: true, ...(range ? { range } : {}) };
  }
  if (b.type === "code") {
    const n = b.code.replace(/\n$/, "").split("\n").length;
    const first = b.start ?? 1;
    return { ...b, code: "", omitted: true, ...(b.code ? { range: [first, first + n - 1] as [number, number] } : {}) };
  }
  return b;
}

function newRange(hunks: Hunk[]): [number, number] | undefined {
  const nums = hunks.flatMap((h) => h.lines.flatMap((l) => (l.new !== undefined ? [l.new] : [])));
  if (!nums.length) {
    const starts = hunks.filter((h) => h.newLines > 0);
    if (!starts.length) return undefined;
    return [Math.min(...starts.map((h) => h.newStart)), Math.max(...starts.map((h) => h.newStart + h.newLines - 1))];
  }
  return [Math.min(...nums), Math.max(...nums)];
}

export const CODE_LEVEL_LABEL: Record<CodeLevel, string> = {
  full: "all changes", key: "key changes only", none: "not included",
};
