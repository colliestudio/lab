// Helpers for hand-written fixtures: a small unified-diff parser (real line numbers) and block builders.
import type { Block, Change, FileChange, Hunk, Level } from "../../src/model.ts";

const MECH = [/(^|\/)go\.sum$/, /pnpm-lock\.yaml$/, /package-lock\.json$/, /\.gen\.go$/, /(^|\/)generated\//];

export function parsePatch(patch: string): FileChange[] {
  const files: FileChange[] = [];
  let f: FileChange | null = null;
  let h: Hunk | null = null;
  let oldNo = 0, newNo = 0;
  for (const line of patch.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/)!;
      f = { path: m[2], change: "changed", additions: 0, deletions: 0, binary: false, mechanical: false, hunks: [] };
      if (m[1] !== m[2]) f.oldPath = m[1];
      f.mechanical = MECH.some((r) => r.test(f!.path));
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (line.startsWith("new file mode")) { f.change = "added"; continue; }
    if (line.startsWith("deleted file mode")) { f.change = "removed"; continue; }
    if (line.startsWith("rename from ")) { f.oldPath = line.slice(12); continue; }
    if (line.startsWith("similarity index") || line.startsWith("rename to") || line.startsWith("index ")) continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("Binary files")) { f.binary = true; continue; }
    const hm = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hm) {
      oldNo = Number(hm[1]); newNo = Number(hm[2]);
      h = { header: "", oldStart: oldNo, newStart: newNo, oldLines: 0, newLines: 0, lines: [] };
      (h as Hunk & { ctx: string }).ctx = hm[3];
      f.hunks.push(h);
      continue;
    }
    if (!h) continue;
    const t = (line[0] ?? " ") as " " | "+" | "-";
    const s = line.slice(1);
    if (t === "+") { h.lines.push({ t, s, new: newNo++ }); h.newLines++; f.additions++; }
    else if (t === "-") { h.lines.push({ t, s, old: oldNo++ }); h.oldLines++; f.deletions++; }
    else { h.lines.push({ t: " ", s, old: oldNo++, new: newNo++ }); h.oldLines++; h.newLines++; }
  }
  for (const file of files)
    for (const hk of file.hunks) {
      const ctx = (hk as Hunk & { ctx?: string }).ctx ?? "";
      delete (hk as Hunk & { ctx?: string }).ctx;
      hk.header = `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@${ctx}`;
    }
  return files;
}

const DEFAULT_LEVEL: Record<Block["type"], Level> = {
  markdown: 2, callout: 2, flow: 2, demo: 2, "before-after": 2, "data-model": 2, api: 2, steps: 2,
  questions: 0, checklist: 2, files: 3, diff: 3, code: 3,
};

type NoBase<T> = T extends unknown ? Omit<T, "id" | "level"> : never;

export function blocks(sectionId: string, list: (NoBase<Block> & { level?: Level })[]): Block[] {
  return list.map((b, i) => ({ ...b, id: `${sectionId}-${i + 1}`, level: b.level ?? DEFAULT_LEVEL[b.type] } as Block));
}

/** A diff block that picks hunks from a parsed file, with `@line: note` annotations. */
export function diffOf(files: FileChange[], path: string, notes: Record<number, string> = {}, hunks?: number[]) {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error("no file " + path);
  return {
    type: "diff" as const, file: path, change: f.change as Change,
    hunks: hunks ? hunks.map((i) => f.hunks[i - 1]) : [],
    notes: Object.entries(notes).map(([line, note]) => ({ line: Number(line), note })),
  };
}

export const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

export function stats(files: FileChange[]) {
  return {
    files: files.length,
    additions: files.reduce((a, f) => a + f.additions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
  };
}
