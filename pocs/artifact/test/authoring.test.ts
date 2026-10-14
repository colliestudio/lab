// Authoring friction fixes from dogfooding: collect --exclude, more mechanical heuristics, globs in `files` blocks,
// `\@N:` escapes in code bodies, deferred plan nodes as ghosts on the review's map.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDoc } from "../src/parse/doc.ts";
import { linkPlan, loadBundle } from "../src/parse/bundle.ts";
import { mechanicalReason } from "../src/parse/patch.ts";
import { collect, excludeSpec } from "../src/collect.ts";
import { parseArgs } from "../src/args.ts";
import type { Block, FileChange } from "../src/model.ts";

const patch = readFileSync(new URL("./fixtures/retries.review/changes.patch", import.meta.url), "utf8");

test("collect --exclude leaves pathspecs out of the patch", async () => {
  const repo = mkdtempSync(join(tmpdir(), "recap-repo-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  for (const p of ["src/a.ts", "samples/x.review/doc.md", "samples/y.review/sub/changes.patch", "samples/README.md", "docs/n.md"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "x\n");
  }
  git("add", "-A"); git("commit", "-qm", "first");
  const out = join(repo, "out.review");
  const res = collect({ base: "(empty)", repo, out, exclude: ["samples/*.review/**", ":(exclude)docs"] });
  const b = await loadBundle(out);
  assert.deepEqual(b.doc.files.map((f) => f.path), ["samples/README.md", "src/a.ts"]);
  assert.equal(res.files, 2);
  assert.match(readFileSync(join(out, "doc.md"), "utf8"), /--exclude samples\/\*\.review\/\*\*/);
  assert.equal(excludeSpec(":!x"), ":!x");
  assert.deepEqual(parseArgs(["--exclude", "a", "--exclude=b", "-o", "x"]).all.exclude, ["a", "b"]);
});

test("mechanical: nested bundles, recordings, images, fixture JSON", () => {
  const f = (path: string): FileChange => ({ path, change: "added", additions: 1, deletions: 0, binary: false, mechanical: false, hunks: [] });
  assert.equal(mechanicalReason(f("samples/a.review/changes.patch")), "nested bundle");
  assert.equal(mechanicalReason(f("x.plan/doc.md")), "nested bundle");
  assert.equal(mechanicalReason(f("demos/tour.replay")), "recording");
  assert.equal(mechanicalReason(f("docs/shot.PNG")), "image");
  assert.equal(mechanicalReason(f("viewer/screenshots/a.svg")), "image");
  assert.equal(mechanicalReason(f("test/fixtures/retries.json")), "test fixture");
  assert.equal(mechanicalReason(f("src/config.json")), undefined);
  assert.equal(mechanicalReason(f("src/review.ts")), undefined);
});

const doc = (body: string[]) =>
  parseDoc(["---", "kind: review", "title: T", "tldr: One.", "---", "```map", "nodes: [{ id: a, section: a }]", "```",
    "## A {#a}", "", "Summary.", "", ...body].join("\n"), patch);
const blocks = (d: ReturnType<typeof doc>) => d.sections.flatMap((s) => s.blocks);

test("files blocks accept globs (expanded against changes.patch; literal notes win)", () => {
  const all = parseDoc("x", patch).files.map((f) => f.path);
  const retry = all.filter((p) => p.startsWith("internal/delivery/"));
  assert.ok(retry.length > 1);
  const d = doc(["```files", "internal/delivery/**: the worker", `${retry[0]}: entry point`, "nope/**:", "```"]);
  const b = blocks(d).find((x) => x.type === "files") as Extract<Block, { type: "files" }>;
  assert.deepEqual(Object.keys(b.notes).sort(), [...retry].sort());
  assert.equal(b.notes[retry[0]], "entry point");
  assert.equal(b.notes[retry[1]], "the worker");
  assert.ok(d.warnings.some((w) => /glob "nope\/\*\*" matches no file/.test(w)), d.warnings.join("\n"));
  const p = blocks(doc(["```files", "paths: [\"internal/store/*.go\", web/src]", "```"])).find((x) => x.type === "files") as Extract<Block, { type: "files" }>;
  assert.deepEqual(p.paths, ["internal/store/attempts.go", "web/src/pages/FailedDeliveries.tsx", "web/src/routes.ts", "web/src/styles.css"]);
});

test("code bodies: \\@N: is a literal line, @N: a note", () => {
  const d = doc(["```code lang=md", "\\@2: literal", "second", "@2: a note", "```"]);
  const c = blocks(d).find((x) => x.type === "code") as Extract<Block, { type: "code" }>;
  assert.equal(c.code, "@2: literal\nsecond");
  assert.deepEqual(c.notes, [{ line: 2, note: "a note" }]);
});

test("linkPlan: plan work missing from the review's map comes back as ghosts with its edges", () => {
  const plan = parseDoc(["---", "kind: plan", "title: P", "goal: G.", "---", "```map",
    "groups: [{ id: g, label: G }, { id: later, label: Later }]",
    "nodes:",
    "  - { id: a, change: planned, group: g, section: a }",
    "  - { id: b, change: deferred, group: later, section: later }",
    "  - { id: c, change: planned, section: a }",
    "  - { id: ctx, change: unchanged }",
    "edges: [{ from: b, to: a }, { from: c, to: ctx }, { from: a, to: ctx }]",
    "```"].join("\n"));
  const review = parseDoc(["---", "kind: review", "title: R", "tldr: T.", "---", "```map",
    "groups: [{ id: g, label: G }]", "nodes: [{ id: a, change: added, group: g, section: a }]", "```"].join("\n"));
  const l = linkPlan(review, plan, "p.plan");
  assert.deepEqual([l.done, l.notDone, l.deferred], [["a"], ["c"], ["b"]]);
  assert.deepEqual(l.ghosts?.nodes.map((n) => [n.id, n.change, n.section]), [["b", "deferred", undefined], ["c", "planned", undefined]]);
  assert.deepEqual(l.ghosts?.groups.map((g) => g.id), ["later"]);
  assert.deepEqual(l.ghosts?.edges.map((e) => `${e.from}>${e.to}`), ["b>a"]); // c>ctx: ctx isn't drawn on the review
});
