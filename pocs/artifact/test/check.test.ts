import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "../src/parse/bundle.ts";
import { checkBundle } from "../src/check.ts";
import { collect } from "../src/collect.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

test("fixtures pass check", async () => {
  for (const name of ["retries.review", "retries.plan"]) {
    const r = checkBundle(await loadBundle(join(fixtures, name)));
    assert.deepEqual(r, { errors: [], warnings: [] }, name);
  }
});

test("check fails on the old 0-3 level numbering and out-of-range levels", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "recap-")), "lvl.review");
  mkdirSync(dir);
  writeFileSync(join(dir, "doc.md"), [
    "---", "kind: review", "title: Levels", "tldr: One.", "risk: low", "ask: none", "---",
    "```map", "nodes: [{ id: a, change: added, section: a }]", "```",
    "## A {#a}", "", "Summary.", "",
    "```callout level=0", "Old headline numbering.", "```",
    "```callout level=5", "Too deep.", "```",
    "```callout level=4", "Fine.", "```",
  ].join("\n"));
  const b = await loadBundle(dir);
  const e = checkBundle(b).errors.join("\n");
  assert.match(e, /callout: level=0 is not a level; levels are 1-4/);
  assert.match(e, /callout: level must be 1-4, got "5"/);
  assert.deepEqual(b.doc.sections[0].blocks.filter((x) => x.type === "callout").map((x) => x.level), [3, 3, 4]);
});

test("check flags broken links, missing files and budgets", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "recap-")), "bad.review");
  mkdirSync(dir);
  const nodes = Array.from({ length: 13 }, (_, i) => `  - { id: n${i}, change: added, section: s${i} }`).join("\n");
  const big = Array.from({ length: 160 }, (_, i) => `+line ${i}`).join("\n");
  writeFileSync(join(dir, "doc.md"), [
    "---", "kind: review", "title: Bad", "tldr: One. Two.", "risk: low", "ask: none", "---",
    "```map", "nodes:", nodes, "edges: [{ from: n0, to: ghost }]", "```",
    "## S0 {#s0}", "", "Summary.", "",
    "```diff file=nope.go", "```",
    "```demo", "src: demos/missing.replay", "```",
    "```diff file=big.txt", "@@ -0,0 +1,160 @@", big, "```",
    "## Orphan", "", "Summary with ![shot](assets/none.png).",
  ].join("\n"));
  const r = checkBundle(await loadBundle(dir));
  const e = r.errors.join("\n"), w = r.warnings.join("\n");
  assert.match(e, /section "s1" does not exist/);
  assert.match(e, /unknown node "ghost"/);
  assert.match(e, /diff does not resolve \(file "nope.go"\)/);
  assert.match(e, /demo file "demos\/missing.replay" not in bundle/);
  assert.match(w, /map has 13 nodes/);
  assert.match(w, /diff is 161 lines/);
  assert.match(w, /tldr should be one sentence/);
  assert.match(w, /section "orphan" is not linked/);
  assert.match(w, /image "assets\/none.png" not in bundle/);
});

test("collect: patch + scaffold that check rejects until written", async () => {
  const repo = mkdtempSync(join(tmpdir(), "recap-repo-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, "src/api"), { recursive: true });
  mkdirSync(join(repo, "src/db"), { recursive: true });
  writeFileSync(join(repo, "src/api/a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  git("add", "-A"); git("commit", "-qm", "base");
  git("checkout", "-qb", "feat");
  writeFileSync(join(repo, "src/api/a.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "src/db/schema.sql"), "create table t (id int);\n");
  writeFileSync(join(repo, "README.md"), "hi\n");
  writeFileSync(join(repo, "package-lock.json"), "{ }\n");
  git("add", "-A"); git("commit", "-qm", "feat");

  const out = join(repo, "out.review");
  const res = collect({ base: "main", repo, out });
  assert.equal(res.files, 4);
  const b = await loadBundle(out);
  assert.deepEqual(b.doc.warnings, []);
  assert.deepEqual(b.doc.map.nodes.map((n) => [n.id, n.change, n.kind]).sort(), [
    ["mechanical", "changed", "config"], ["root", "added", "doc"], ["src-api", "changed", "api"], ["src-db", "added", "db"],
  ]);
  assert.equal(b.doc.sections.at(-1)!.id, "mechanical");
  const r = checkBundle(b);
  assert.ok(r.errors.length > 0 && r.errors.every((e) => e.startsWith("TODO left")), r.errors.join("\n"));
  // re-running keeps the hand-written doc.md
  assert.equal(collect({ base: "main", repo, out }).docKept, true);
});
