// Unified diff parser (git diff format): renames, copies, binary, new/deleted files, mode changes.
// Also the mechanical-file heuristics (lockfiles, generated, pure renames, whitespace-only).

import type { FileChange, Hunk } from "../model.ts";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parse a unified diff (one or many files). Never throws; unparseable lines are skipped. */
export function parsePatch(text: string): FileChange[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const files: FileChange[] = [];
  let cur: (FileChange & { _similarity?: number }) | null = null;
  let i = 0;

  const start = (path = "", oldPath?: string) => {
    cur = { path, oldPath, change: "changed", additions: 0, deletions: 0, binary: false, mechanical: false, hunks: [] };
    files.push(cur);
    return cur;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      const [a, b] = splitGitPaths(line.slice("diff --git ".length));
      const f = start(b ?? a ?? "");
      if (a && b && a !== b) f.oldPath = a;
      i++;
      continue;
    }

    // Plain unified diff (no `diff --git` header): a `---` line followed by `+++` starts a file.
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const oldP = stripPrefix(line.slice(4));
      const newP = stripPrefix(lines[i + 1].slice(4));
      const c = cur as FileChange | null; // (assigned inside start(); TS narrows it to null here)
      const f: FileChange = c && c.hunks.length === 0 && !c.binary ? c : start();
      if (newP === null) {
        f.change = "removed";
        f.path = oldP ?? f.path;
      } else {
        f.path = newP;
        if (oldP === null) f.change = "added";
        else if (oldP !== newP) f.oldPath = oldP;
      }
      i += 2;
      continue;
    }

    if (!cur) { i++; continue; }
    const f: FileChange & { _similarity?: number } = cur;

    if (line.startsWith("new file mode")) { f.change = "added"; i++; continue; }
    if (line.startsWith("deleted file mode")) { f.change = "removed"; i++; continue; }
    if (line.startsWith("rename from ") || line.startsWith("copy from ")) { f.oldPath = unquote(line.replace(/^(rename|copy) from /, "")); i++; continue; }
    if (line.startsWith("rename to ") || line.startsWith("copy to ")) { f.path = unquote(line.replace(/^(rename|copy) to /, "")); i++; continue; }
    if (line.startsWith("similarity index ")) { f._similarity = parseInt(line.slice(17), 10); i++; continue; }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      f.binary = true;
      i++;
      // skip the base85 payload of a GIT binary patch
      while (i < lines.length && !lines[i].startsWith("diff --git ")) i++;
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      const h: Hunk = {
        header: line,
        oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4],
        lines: [],
      };
      i++;
      let o = h.oldStart, n = h.newStart, oldLeft = h.oldLines, newLeft = h.newLines;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const l = lines[i];
        if (l.startsWith("\\")) { i++; continue; } // "\ No newline at end of file"
        const t = l[0];
        if (t === "+") { h.lines.push({ t: "+", s: l.slice(1), new: n++ }); newLeft--; f.additions++; }
        else if (t === "-") { h.lines.push({ t: "-", s: l.slice(1), old: o++ }); oldLeft--; f.deletions++; }
        else if (t === " " || l === "") {
          // some tools strip the trailing space of empty context lines
          if (l === "" && i === lines.length - 1) break;
          h.lines.push({ t: " ", s: l.slice(1), old: o++, new: n++ }); oldLeft--; newLeft--;
        } else break;
        i++;
      }
      while (lines[i]?.startsWith("\\")) i++;
      f.hunks.push(h);
      continue;
    }
    i++;
  }

  for (const f of files as (FileChange & { _similarity?: number })[]) {
    delete f._similarity;
    // plain diffs (no git header) may say `--- a/x` for a new file; trust the hunk ranges
    if (f.change === "changed" && f.hunks.length) {
      if (f.hunks.every((h) => h.oldStart === 0 && h.oldLines === 0)) f.change = "added";
      else if (f.hunks.every((h) => h.newStart === 0 && h.newLines === 0)) f.change = "removed";
    }
    f.mechanical = isMechanical(f);
  }
  return files;
}

/**
 * Heuristics: lockfiles, generated / vendored / minified files, nested doc bundles, recordings, images, test fixture
 * JSON, pure renames, whitespace-only changes.
 */
export function isMechanical(f: FileChange): boolean {
  return mechanicalReason(f) !== undefined;
}

export function mechanicalReason(f: FileChange): string | undefined {
  const p = f.path;
  const base = p.split("/").pop() ?? p;
  if (LOCKFILES.has(base)) return "lockfile";
  if (/(^|\/)(dist|build|out|vendor|node_modules|generated|__generated__|gen)\//.test(p)) return "generated";
  if (/\.(min\.(js|css)|map|snap|pb\.go|lock)$/.test(base) || /[._-]generated\.|\.gen\./.test(base)) return "generated";
  if (/(^|\/)[^/]+\.(review|plan)\//.test(p)) return "nested bundle";
  if (/\.replay$/i.test(base)) return "recording";
  if (/\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?)$/i.test(base) || /(^|\/)screenshots?\//i.test(p)) return "image";
  if (/\.json$/i.test(base) && /(^|\/)(fixtures?|__fixtures__|testdata|test-data|__snapshots__|snapshots)\//i.test(p)) return "test fixture";
  if (f.oldPath && f.oldPath !== f.path && f.hunks.length === 0 && !f.binary) return "rename";
  if (f.hunks.length > 0 && f.change === "changed" && f.hunks.every(whitespaceOnly)) return "whitespace";
  return undefined;
}

const LOCKFILES = new Set([
  "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock", "npm-shrinkwrap.json",
  "Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock",
  "flake.lock", "mix.lock", "pubspec.lock", "Podfile.lock",
]);

/** A hunk whose removed and added lines are equal once whitespace is ignored. */
function whitespaceOnly(h: Hunk): boolean {
  const norm = (s: string) => s.replace(/\s+/g, "");
  const del = h.lines.filter((l) => l.t === "-").map((l) => norm(l.s)).filter(Boolean);
  const add = h.lines.filter((l) => l.t === "+").map((l) => norm(l.s)).filter(Boolean);
  return del.join("\n") === add.join("\n");
}

/** `a/foo b/bar` → ["foo", "bar"]; handles quoted paths and paths with spaces when a == b. */
function splitGitPaths(s: string): [string | undefined, string | undefined] {
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)" (.*)$/.exec(s);
    if (m) return [stripPrefix(`"${m[1]}"`) ?? undefined, stripPrefix(m[2]) ?? undefined];
  }
  // a/X b/X with identical halves (works with spaces in the path)
  const half = (s.length - 1) / 2;
  if (Number.isInteger(half) && s[half] === " ") {
    const a = s.slice(0, half), b = s.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return [stripPrefix(a) ?? undefined, stripPrefix(b) ?? undefined];
  }
  const idx = s.indexOf(" b/");
  if (idx >= 0) return [stripPrefix(s.slice(0, idx)) ?? undefined, stripPrefix(s.slice(idx + 1)) ?? undefined];
  const parts = s.split(" ");
  return [stripPrefix(parts[0]) ?? undefined, stripPrefix(parts[1] ?? parts[0]) ?? undefined];
}

/** Strip `a/` `b/` prefixes, quotes and trailing timestamps; `/dev/null` → null. */
function stripPrefix(p: string): string | null {
  let s = unquote(p.split("\t")[0].trim());
  if (s === "/dev/null") return null;
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return s;
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\t/g, "\t").replace(/\\n/g, "\n");
  }
  return s;
}

export function patchStats(files: FileChange[]) {
  return {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}
