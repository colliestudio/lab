// Format additions from authoring the samples: strict YAML keys, lines= slices, code from the patch,
// overview blocks, deferred plan nodes, goal, collect --root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDoc, QUOTE_HINT } from "../src/parse/doc.ts";
import { linkPlan, loadBundle } from "../src/parse/bundle.ts";
import { checkBundle } from "../src/check.ts";
import { collect } from "../src/collect.ts";
import type { Block, Doc } from "../src/model.ts";

const patch = readFileSync(new URL("./fixtures/retries.review/changes.patch", import.meta.url), "utf8");
const doc = (body: string[], fm = ["kind: review", "title: T", "tldr: One."]) =>
  parseDoc(["---", ...fm, "---", "```map", "nodes: [{ id: a, section: a }]", "```", ...body].join("\n"), patch);
const blocks = (d: Doc) => d.sections.flatMap((s) => s.blocks);

test("unknown YAML keys and split list items are flagged with a quoting hint", () => {
  const d = parseDoc([
    "---", "title: T", "tldr: One.", "colour: red", "---",
    "```map",
    "nodes:",
    "  - { id: p, label: Player (tabs, waterfall), section: a }",
    "edges:",
    "  - { from: p, to: p, label: a, b }",
    "```",
    "## A {#a}", "", "Summary.", "",
    "```checklist", "- run it: then look", "- plain", "```",
    "```questions", "- { q: Which?, options: [x, y], recommend: x, because: reasons }", "```",
    "```data-model", "entities:", "  - { name: E, fields: [{ name: id, type: int, nullable: no }] }", "```",
    "```diff file=internal/delivery/retry.go hunk=1", "```",
  ].join("\n"), patch);
  const w = d.warnings;
  const hinted = w.filter((m) => m.endsWith(QUOTE_HINT));
  assert.ok(hinted.some((m) => m.startsWith('map node "p": unknown key "waterfall)"')), w.join("\n"));
  assert.ok(hinted.some((m) => m.startsWith('map edge p→p: unknown key "b"')));
  assert.ok(hinted.some((m) => /checklist: item 1 is not a string/.test(m)));
  assert.ok(hinted.some((m) => /question "Which\?": unknown key "because"/.test(m)));
  assert.ok(hinted.some((m) => /field "E.id": unknown key "nullable"/.test(m)));
  assert.ok(w.includes('frontmatter: unrecognized key "colour"'));
  assert.ok(w.some((m) => /diff: unknown attribute "hunk"/.test(m)));
  const cl = blocks(d).find((b) => b.type === "checklist");
  assert.deepEqual(cl?.type === "checklist" && cl.items, ["run it: then look", "plain"]);
});

test("check fails on unknown keys, warns on the rest", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "recap-")), "x.review");
  mkdirSync(dir);
  writeFileSync(join(dir, "changes.patch"), "");
  writeFileSync(join(dir, "doc.md"), [
    "---", "title: T", "tldr: One.", "risk: low", "ask: ok", "extra: 1", "---",
    "```map", "nodes: [{ id: a, label: A (x, y), section: a }]", "```",
    "## A {#a}", "", "Summary.",
  ].join("\n"));
  const r = checkBundle(await loadBundle(dir));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /map node "a": unknown key "y\)".*quote it/);
  assert.ok(r.warnings.includes('frontmatter: unrecognized key "extra"'));
});

test("diff lines=: slices hunks to a new-side range, keeps real numbers, combines with hunks=", () => {
  const d = doc([
    "## A {#a}", "", "Summary.", "",
    "```diff file=internal/delivery/worker.go lines=41-42", "@42: the retry condition", "```",
    "```diff file=internal/delivery/worker.go hunks=2,3 lines=38-39,80-200", "```",
    "```diff file=internal/delivery/retry.go lines=10-12", "```",
    "```diff file=internal/delivery/worker.go hunks=1 lines=60-70", "```",
  ]);
  const [one, two, added, none] = blocks(d) as Extract<Block, { type: "diff" }>[];
  assert.equal(one.hunks.length, 1);
  const h = one.hunks[0];
  assert.equal(h.header, "@@ -37,3 +41,2 @@ func (w *Worker) Run(ctx context.Context) error {");
  assert.deepEqual([h.oldStart, h.oldLines, h.newStart, h.newLines], [37, 3, 41, 2]);
  assert.deepEqual(h.lines.map((l) => l.t).join(""), "---++"); // the replaced lines stay with their replacement
  assert.deepEqual(one.notes, [{ line: 42, note: "the retry condition" }]);
  assert.deepEqual(two.hunks.map((x) => [x.newStart, x.newLines]), [[38, 2], [80, 6]]);
  assert.deepEqual(added.hunks.map((x) => [x.oldStart, x.oldLines, x.newStart, x.newLines]), [[0, 0, 10, 3]]);
  assert.deepEqual(added.hunks[0].lines.map((l) => l.new), [10, 11, 12]);
  assert.equal(none.hunks.length, 0);
  assert.ok(d.warnings.some((w) => /lines 60-70 match no line/.test(w)));
  assert.ok(!d.warnings.some((w) => /note @42/.test(w)));
});

test("raw diff bodies take @line notes too", () => {
  const d = doc(["## A {#a}", "", "Summary.", "", "```diff file=x.go", "@@ -1,1 +1,2 @@", " a", "+b", "@2: why b", "```"]);
  const b = blocks(d)[0];
  assert.ok(b.type === "diff" && b.hunks[0].lines.length === 2);
  assert.deepEqual(b.type === "diff" && b.notes, [{ line: 2, note: "why b" }]);
});

test("code: start=, @line notes, fill from changes.patch with lines=", () => {
  const d = doc([
    "## A {#a}", "", "Summary.", "",
    "```code lang=ts start=10", "const a = 1;", "const b = 2;", "@11: b matters", "@20: out of range", "```",
    "```code file=internal/delivery/retry.go lines=10-12", "@11: note on a patch line", "```",
    "```code file=internal/delivery/retry.go", "```",
    "```code file=internal/delivery/worker.go lines=20-45", "```",
  ]);
  const [sketch, slice, whole, gap] = blocks(d) as Extract<Block, { type: "code" }>[];
  assert.equal(sketch.start, 10);
  assert.equal(sketch.code, "const a = 1;\nconst b = 2;");
  assert.deepEqual(sketch.notes, [{ line: 11, note: "b matters" }, { line: 20, note: "out of range" }]);
  assert.ok(d.warnings.some((w) => /note @20 is outside lines 10-11/.test(w)));
  const retry = patch.split("\n").slice(patch.split("\n").indexOf("+++ b/internal/delivery/retry.go") + 2).map((l) => l.slice(1));
  assert.equal(slice.start, 10);
  assert.equal(slice.lang, "go");
  assert.equal(slice.code, retry.slice(9, 12).join("\n"));
  assert.deepEqual(slice.notes, [{ line: 11, note: "note on a patch line" }]);
  assert.equal(whole.start, 1);
  assert.equal(whole.code.split("\n").length, 31);
  // worker.go is a changed file: only the hunks' new side is known, so the fill stops at the first gap
  assert.equal(gap.start, 20);
  assert.equal(gap.code.split("\n").length, 9); // 20-28, then the gap before hunk 2
  assert.ok(d.warnings.some((w) => /line \d+ of "internal\/delivery\/worker.go" is not in changes.patch/.test(w)));
});

test("overview: blocks between the map and the first section, questions collected from anywhere", () => {
  const d = doc([
    "Overview text.", "",
    "```flow", "flowchart LR", "  a --> b", "```",
    "More text.", "",
    "```questions", "- { q: Ship it?, recommend: yes }", "```",
    "```callout tone=warn", "Careful.", "```",
    "## A {#a}", "", "Summary.", "",
    "```questions", "- q: And this?", "```",
  ]);
  assert.deepEqual(d.overviewBlocks.map((b) => `${b.id}:${b.level}`), [
    "overview-markdown-1:2", "overview-flow-1:3", "overview-markdown-2:2", "overview-questions-1:1", "overview-callout-1:3",
  ]);
  assert.equal(d.overview, "Overview text.\n\nMore text.");
  assert.deepEqual(d.questions.map((q) => q.q), ["Ship it?", "And this?"]);
  assert.ok(!d.warnings.some((w) => /ignored/.test(w)), d.warnings.join("\n"));
  const lvl4 = doc(["```diff file=internal/delivery/retry.go", "```", "## A {#a}", "", "Summary."]);
  assert.ok(lvl4.warnings.some((w) => /diff block in the overview is level 4/.test(w)));
});

test("plans: goal frontmatter, deferred nodes; planLink keeps deferred apart from not done", () => {
  const plan = parseDoc([
    "---", "kind: plan", "title: P", "goal: Get it done.", "---",
    "```map", "nodes:",
    "  - { id: a, section: a }", "  - { id: b, section: a }", "  - { id: later, change: deferred, section: a }",
    "  - { id: also-later, change: deferred }", "  - { id: ctx, change: unchanged }",
    "```", "## A {#a}", "", "Summary.",
  ].join("\n"));
  assert.equal(plan.goal, "Get it done.");
  assert.equal(plan.tldr, "Get it done.");
  assert.equal(plan.map.nodes.find((n) => n.id === "later")!.change, "deferred");
  const review = parseDoc([
    "---", "title: R", "tldr: Did it.", "---",
    "```map", "nodes:",
    "  - { id: a, change: added }", "  - { id: also-later, change: added }", "  - { id: b, change: deferred }", "  - { id: x, change: deferred }",
    "```",
  ].join("\n"));
  const { ghosts, ...link } = linkPlan(review, plan, "p.plan");
  assert.deepEqual(link, {
    src: "p.plan", title: "P", done: ["a", "also-later"], notDone: [], deferred: ["b", "later"], unplanned: [],
  });
  assert.deepEqual(ghosts?.nodes.map((n) => n.id), ["later"]);
  const both = parseDoc(["---", "title: P", "tldr: T.", "goal: G.", "---"].join("\n"));
  assert.deepEqual([both.tldr, both.goal], ["T.", "G."]);
});

test("collect --root: the whole repo against the empty tree", async () => {
  const repo = mkdtempSync(join(tmpdir(), "recap-repo-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, "src/api"), { recursive: true });
  writeFileSync(join(repo, "src/api/a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", "-A"); git("commit", "-qm", "first");
  const out = join(repo, "out.review");
  const res = collect({ base: "(empty)", repo, out });
  assert.equal(res.files, 2);
  const b = await loadBundle(out);
  assert.equal(b.doc.meta.base, "(empty)");
  assert.ok(b.doc.files.every((f) => f.change === "added"));
  assert.deepEqual(b.doc.warnings, []);
});
