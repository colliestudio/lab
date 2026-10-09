import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDoc, parseAttrs } from "../src/parse/doc.ts";
import type { Block } from "../src/model.ts";

const dir = new URL("./fixtures/retries.review/", import.meta.url);
const md = readFileSync(new URL("doc.md", dir), "utf8");
const patch = readFileSync(new URL("changes.patch", dir), "utf8");
const doc = parseDoc(md, patch);
const block = (id: string) => doc.sections.flatMap((s) => s.blocks).find((b) => b.id === id) as Block;

test("frontmatter → headline", () => {
  assert.equal(doc.format, "collie-doc/0");
  assert.equal(doc.kind, "review");
  assert.equal(doc.title, "Retry failed webhook deliveries");
  assert.deepEqual(doc.risk, { level: "medium", why: "Changes the delivery worker's ack path; a bug here drops or duplicates events." });
  assert.equal(doc.meta.plan, "../retries.plan");
  assert.equal(doc.meta.date, "2026-10-05");
  assert.deepEqual(doc.stats, { files: 16, additions: 251, deletions: 21 });
  assert.deepEqual(doc.warnings, []);
});

test("map, overview, sections", () => {
  assert.equal(doc.map.nodes.length, 9);
  assert.equal(doc.map.groups[0].label, "Delivery worker");
  assert.equal(doc.map.nodes.find((n) => n.id === "mechanical")!.label, "Lockfile, renames, formatting");
  assert.deepEqual(doc.map.nodes.find((n) => n.id === "retry")!.files, ["internal/delivery/retry*.go"]);
  assert.match(doc.overview, /^Before this change/);
  assert.doesNotMatch(doc.overview, /^# /m);
  assert.deepEqual(doc.sections.map((s) => s.id), ["worker", "retry", "attempts", "metrics", "api", "ui", "mechanical"]);
  assert.equal(doc.sections.at(-1)!.mechanical, true);
  const worker = doc.sections[0];
  assert.match(worker.summary, /^The worker no longer acks/);
  assert.equal(worker.blocks[0].type, "flow"); // summary paragraph is not a block
});

test("blocks: ids, levels, attrs, YAML bodies", () => {
  const flow = block("worker-flow-1");
  assert.equal(flow.type === "flow" && flow.caption, "One delivery attempt, after this change");
  assert.equal(flow.level, 3);
  const callout = block("worker-callout-1");
  assert.equal(callout.type === "callout" && callout.tone, "risk");
  const q = block("retry-questions-1");
  assert.equal(q.level, 1);
  assert.equal(doc.questions.length, 1);
  assert.equal(doc.questions[0].recommend, "8 (~2h of retries)");
  const dm = block("attempts-data-model-1");
  assert.ok(dm.type === "data-model");
  assert.equal(dm.entities[0].fields.length, 6);
  assert.equal(dm.entities[1].fields.find((f) => f.name === "last_status")!.change, "added");
  const api = block("api-api-1");
  assert.ok(api.type === "api");
  assert.deepEqual(api.endpoints.map((e) => `${e.method} ${e.path} ${e.change}`), [
    "GET /deliveries changed", "GET /deliveries/{id}/attempts added", "POST /deliveries/{id}/replay added",
  ]);
  const code = block("retry-code-1");
  assert.ok(code.type === "code" && code.lang === "go" && code.file === "internal/delivery/retry.go" && code.level === 4);
  const steps = block("ui-steps-1");
  assert.ok(steps.type === "steps" && steps.steps[0].status === "todo");
  const cl = block("ui-checklist-1");
  assert.ok(cl.type === "checklist" && cl.items.length === 4);
  const files = block("mechanical-files-1");
  assert.ok(files.type === "files" && files.level === 4 && files.notes["scripts/run-dev.sh"].startsWith("renamed"));
});

test("diff blocks: file reference, hunks=, annotations, inline", () => {
  const ref = block("worker-diff-1");
  assert.ok(ref.type === "diff");
  assert.equal(ref.file, "internal/delivery/worker.go");
  assert.equal(ref.hunks.length, 1);
  assert.equal(ref.hunks[0].newStart, 38);
  assert.deepEqual(ref.notes.map((n) => n.line), [42, 45, 49, 61]);
  const whole = block("retry-diff-1");
  assert.ok(whole.type === "diff" && whole.change === "added" && whole.hunks.length === 1);
  const inline = block("attempts-diff-1");
  assert.ok(inline.type === "diff");
  assert.equal(inline.file, "internal/store/migrations/0012_delivery_attempts.down.sql");
  assert.equal(inline.change, "added");
  assert.deepEqual(inline.notes, [{ line: 1, note: "Drops the column first; safe to run with the worker stopped." }]);
  const bare = block("ui-diff-1");
  assert.ok(bare.type === "diff" && bare.file === "web/src/routes.ts" && bare.hunks[0].lines.filter((l) => l.t === "+").length === 2);
});

test("info-string attrs", () => {
  assert.deepEqual(parseAttrs(` file=a/b.go hunks=1,3 caption="Hello \\"x\\" world" flag k='v w'`), {
    file: "a/b.go", hunks: "1,3", caption: 'Hello "x" world', flag: "true", k: "v w",
  });
});

test("soft problems become warnings, never throws", () => {
  const d = parseDoc([
    "---", "title: [unclosed", "---",
    "intro",
    "```callout tone=loud", "x", "```",
    "## A {#a}",
    "```map", "nodes: [{ id: a, change: weird }]", "```",
    "```diff file=missing.go", "```",
    "```data-model", "entities: [", "```",
    "```code level=9", "x", "```",
    "## A", "",
    "```checklist", "- open fence",
  ].join("\n"));
  const w = d.warnings.join("\n");
  for (const re of [/frontmatter: invalid YAML/, /before the first section/, /map block should come before/, /unknown change "weird"/,
    /missing\.go" not found/, /data-model: invalid YAML/, /level must be 1-4/, /unclosed code fence/, /no title/]) {
    assert.match(w, re);
  }
  assert.deepEqual(d.sections.map((s) => s.id), ["a", "a-2"]);
});

test("defaults: kind from opts, plan nodes default planned, h1 as title, ids from id= and slug", () => {
  const d = parseDoc([
    "# My plan", "",
    "```map", "nodes: [{ id: x, section: do-the-thing }]", "```",
    "## Do the thing!", "", "Summary here.", "", "Body.", "",
    "```callout id=key-risk tone=warn", "careful", "```",
    "```files", "```",
  ].join("\n"), undefined, { kind: "plan" });
  assert.equal(d.kind, "plan");
  assert.equal(d.title, "My plan");
  assert.equal(d.map.nodes[0].change, "planned");
  assert.equal(d.sections[0].id, "do-the-thing");
  assert.equal(d.sections[0].summary, "Summary here.");
  assert.deepEqual(d.sections[0].blocks.map((b) => b.id), ["do-the-thing-markdown-1", "key-risk", "do-the-thing-files-1"]);
  assert.equal(d.stats, undefined);
  assert.deepEqual(d.files, []);
});
