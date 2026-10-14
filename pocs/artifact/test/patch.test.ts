import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePatch, patchStats, mechanicalReason } from "../src/parse/patch.ts";

const fixture = readFileSync(new URL("./fixtures/retries.review/changes.patch", import.meta.url), "utf8");

test("git diff: file kinds, renames, binary, stats", () => {
  const files = parsePatch(fixture);
  const by = (p: string) => files.find((f) => f.path === p)!;
  assert.equal(files.length, 16);
  assert.deepEqual(patchStats(files), { files: 16, additions: 251, deletions: 21 });
  assert.equal(by("docs/retries.md").change, "removed");
  assert.equal(by("internal/delivery/retry.go").change, "added");
  assert.equal(by("internal/delivery/worker.go").change, "changed");
  assert.equal(by("internal/delivery/worker.go").hunks.length, 3);
  assert.equal(by("internal/clock/clock.go").oldPath, "internal/util/clock.go");
  assert.equal(by("scripts/run-dev.sh").oldPath, "scripts/dev.sh");
  assert.equal(by("scripts/run-dev.sh").hunks.length, 0);
  assert.equal(by("web/public/retry-icon.png").binary, true);
  assert.equal(by("web/public/retry-icon.png").change, "added");
});

test("hunk line numbers", () => {
  const w = parsePatch(fixture).find((f) => f.path === "internal/delivery/worker.go")!;
  const h = w.hunks[1];
  assert.equal(h.newStart, 38);
  assert.match(h.header, /^@@ -34,12 \+38,28 @@ func/);
  const l42 = h.lines.find((l) => l.new === 42)!;
  assert.equal(l42.t, "+");
  assert.match(l42.s, /StatusTooManyRequests/);
  const removed = h.lines.filter((l) => l.t === "-");
  assert.equal(removed[0].old, 37);
  assert.equal(removed[0].new, undefined);
});

test("mechanical heuristics", () => {
  const files = parsePatch(fixture);
  const reason = (p: string) => mechanicalReason(files.find((f) => f.path === p)!);
  assert.equal(reason("web/pnpm-lock.yaml"), "lockfile");
  assert.equal(reason("scripts/run-dev.sh"), "rename");
  assert.equal(reason("web/src/styles.css"), "whitespace");
  assert.equal(reason("internal/clock/clock.go"), undefined); // rename with an edit is real work
  assert.equal(reason("internal/delivery/worker.go"), undefined);
  const gen = parsePatch("--- a/web/dist/app.min.js\n+++ b/web/dist/app.min.js\n@@ -1 +1 @@\n-a\n+b\n");
  assert.equal(gen[0].mechanical, true);
});

test("plain unified diff, no-newline marker, /dev/null, deleted files", () => {
  const p = [
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    "\\ No newline at end of file",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "--- a/x.txt\t2026-10-01 10:00:00",
    "+++ b/x.txt\t2026-10-02 10:00:00",
    "@@ -1,3 +1,3 @@",
    " a",
    "--- not a header, a removed line starting with dashes",
    "+b",
    "",
  ].join("\n");
  const files = parsePatch(p);
  assert.deepEqual(files.map((f) => [f.path, f.change, f.additions, f.deletions]), [
    ["new.txt", "added", 2, 0],
    ["old.txt", "removed", 0, 1],
    ["x.txt", "changed", 1, 1],
  ]);
  // empty context line with stripped trailing space counts as context
  assert.equal(files[2].hunks[0].lines.length, 3);
});

test("git deleted file, mode-only change, quoted paths", () => {
  const p = [
    "diff --git a/gone.go b/gone.go",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/gone.go",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-package x",
    "-",
    "diff --git a/run.sh b/run.sh",
    "old mode 100644",
    "new mode 100755",
    'diff --git "a/with space.txt" "b/with space.txt"',
    "new file mode 100644",
    "index 0000000..2222222",
    'Binary files /dev/null and "b/with space.txt" differ',
  ].join("\n");
  const files = parsePatch(p);
  assert.deepEqual(files.map((f) => [f.path, f.change, f.binary]), [
    ["gone.go", "removed", false],
    ["run.sh", "changed", false],
    ["with space.txt", "added", true],
  ]);
});
