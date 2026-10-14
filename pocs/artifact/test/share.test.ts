// Sharing as one file: --code levels, size report, feedback copy/import, Markdown renderer, the export endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Block, Doc, ViewerBoot } from "../src/model.ts";
import { loadBundle } from "../src/parse/index.ts";
import { applyCodeLevel, prFileUrl } from "../src/code-level.ts";
import { buildHtml, sizeReport } from "../src/server/build.ts";
import { startServe } from "../src/server/index.ts";
import { feedbackMarkdown, parseFeedback } from "../src/feedback.ts";
import { renderMarkdown } from "../src/md.ts";

const SAMPLE = new URL("../samples/replay-lab-backend.review", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), "recap-share-"));
const bootOf = (html: string): ViewerBoot => JSON.parse(/window\.__RECAP__=(.*?);(?:new EventSource|<\/script>)/s.exec(html)![1]);
const allBlocks = (d: Doc): Block[] => [...d.overviewBlocks, ...d.sections.flatMap((s) => s.blocks)];
const plain = (s: string) => /^[A-Za-z0-9 _(){}.,=;:]{25,}$/.test(s.trim());

test("build --code: key drops unreferenced hunks from the HTML, none drops all code, full keeps it", async () => {
  const { doc } = await loadBundle(SAMPLE);
  const shown = new Set(allBlocks(doc).flatMap((b) => (b.type === "diff" ? b.hunks.flatMap((h) => h.lines.map((l) => l.s)) : b.type === "code" ? b.code.split("\n") : [])));
  const blockFiles = new Set(allBlocks(doc).flatMap((b) => (b.type === "diff" || b.type === "code") && b.file ? [b.file] : []));
  const hidden = doc.files.filter((f) => !blockFiles.has(f.path)).flatMap((f) => f.hunks.flatMap((h) => h.lines))
    .map((l) => l.s).find((s) => plain(s) && !shown.has(s) && !JSON.stringify(doc.sections).includes(s.trim()));
  assert.ok(hidden, "sample has a line only in an unreferenced hunk");
  const key = [...shown].find((s) => plain(s))!;
  assert.ok(key, "sample has a plain line in a diff block");

  const out: Record<string, string> = {};
  for (const code of ["full", "key", "none"] as const) out[code] = (await buildHtml(SAMPLE, { code })).html;
  assert.ok(out.full.includes(hidden.trim()) && out.full.includes(key.trim()));
  assert.ok(!out.key.includes(hidden.trim()), "key: unreferenced hunk absent");
  assert.ok(out.key.includes(key.trim()), "key: block hunks present");
  assert.ok(!out.none.includes(hidden.trim()) && !out.none.includes(key.trim()), "none: no code at all");
  assert.ok(out.none.length < out.key.length && out.key.length < out.full.length);

  const b = bootOf(out.none).doc;
  assert.equal(b.codeLevel, "none");
  assert.equal(b.files.length, doc.files.length, "file list keeps every changed file");
  assert.ok(b.files.every((f) => !f.hunks.length) && b.files.some((f) => f.omitted && f.additions > 0));
  const d = allBlocks(b).find((x) => x.type === "diff")!;
  assert.ok(d.type === "diff" && d.omitted && d.range && d.range[0] <= d.range[1] && d.hunks.length === 0);
  assert.equal(bootOf(out.full).doc.codeLevel, undefined);
  assert.equal((await buildHtml(SAMPLE)).code, "key", "key is the default");
});

test("code level: PR file links only for GitHub PR urls", () => {
  assert.match(prFileUrl("https://github.com/o/r/pull/12", "src/a.ts")!, /^https:\/\/github\.com\/o\/r\/pull\/12\/files#diff-[0-9a-f]{64}$/);
  assert.equal(prFileUrl("https://gitlab.com/o/r/-/merge_requests/1", "a"), undefined);
  assert.equal(prFileUrl(undefined, "a"), undefined);
});

test("size report: total + biggest parts, warn over 5 MB, refuse over 25 MB, tips", () => {
  const MB = 1024 * 1024;
  const parts = [{ name: "viewer", bytes: 3 * MB }, { name: "code (patch + diff/code blocks)", bytes: 4 * MB }, { name: "demos/a.replay", bytes: 1 * MB }];
  assert.equal(sizeReport(2 * MB, parts, "key").level, "ok");
  const w = sizeReport(8 * MB, parts, "full");
  assert.equal(w.level, "warn");
  assert.ok(w.lines.some((l) => l.includes("--code key")) && w.lines.some((l) => l.includes("viewer")));
  const r = sizeReport(30 * MB, parts, "key");
  assert.equal(r.level, "refuse");
  assert.ok(r.lines.some((l) => l.includes("--force")) && r.lines.some((l) => l.includes("--code none")));
});

test("feedback: copy format round-trips through parse, CLI --import adds comments once", async () => {
  const { doc } = await loadBundle(SAMPLE);
  const sec = doc.sections[1];
  const diff = allBlocks(doc).find((b) => b.type === "diff") as Extract<Block, { type: "diff" }>;
  const line = diff.hunks[0].lines.find((l) => l.t === "+")!.new!;
  const comments = [
    { anchor: { section: sec.id }, body: "Why here?\n\n> my own quote stays", author: "reader" },
    { anchor: { file: diff.file, line }, body: "Off by one?", author: "reader" },
    { anchor: { section: sec.id, block: sec.blocks[0].id }, body: "Nice.", author: "reader" },
  ];
  const md = feedbackMarkdown(doc, comments);
  assert.match(md, new RegExp(`^# Feedback: ${doc.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(md, new RegExp(`head ${doc.meta.head}`));
  assert.match(md, new RegExp(`## 1\\. ${sec.title}`));
  assert.ok(md.includes(`${diff.file}:${line}`));
  assert.ok(/^> \+ /m.test(md), "diff line quoted with its sign");
  const back = parseFeedback(md, doc);
  assert.deepEqual(back.map((c) => c.anchor), comments.map((c) => c.anchor));
  assert.deepEqual(back.map((c) => c.body), comments.map((c) => c.body));
  // heading without anchor line (hand-edited): section found by title
  assert.deepEqual(parseFeedback(`## 1. ${sec.title}\n\nhello`, doc)[0].anchor, { section: sec.id });

  const dir = join(tmp(), "x.review");
  cpSync(SAMPLE, dir, { recursive: true });
  const file = join(dir, "..", "fb.md");
  writeFileSync(file, md);
  const run = (...a: string[]) => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...a], { cwd: ROOT, encoding: "utf8" });
  assert.match(run("comments", dir, "--import", file), /imported 3 comment/);
  assert.match(run("comments", dir, "--import", file), /imported 0 comment\(s\), 3 already there/);
  const saved = JSON.parse(readFileSync(join(dir, "comments.json"), "utf8"));
  assert.equal(saved.length, 3);
  assert.deepEqual(saved[1].anchor, { file: diff.file, line });
  assert.ok(saved.every((c: { id: string; created: string }) => c.id && c.created));
  // stdin
  const viaStdin = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "comments", dir, "--import", "-"],
    { cwd: ROOT, encoding: "utf8", input: md.replace("Off by one?", "Off by two?") });
  assert.match(viaStdin, /imported 1 comment/);
});

test("markdown: whole doc and one section, code level respected", async () => {
  const { doc } = await loadBundle(SAMPLE);
  const md = renderMarkdown(applyCodeLevel(doc, "key"));
  assert.ok(md.startsWith(`# Review: ${doc.title}\n`));
  assert.ok(md.includes(`> ${doc.tldr}`));
  assert.match(md, /\*\*Risk:\*\* low: /);
  assert.match(md, /\*\*Ask:\*\* /);
  assert.match(md, /## Decisions needed\n\n1\. /);
  assert.match(md, /## Map\n\n- Recording \(runner process\)\n {2}- \*\*/);
  assert.match(md, /\n- .+ → .+: /, "edges as A → B: label");
  assert.match(md, /```diff\n@@ /);
  assert.match(md, /▶ recording: .+ \(steps [\d, ]+\) \[demos\//);
  assert.match(md, /\*\*Code:\*\* key changes only/);
  for (const s of doc.sections) assert.ok(md.includes(`## ${s.title}`));

  const none = renderMarkdown(applyCodeLevel(doc, "none"));
  assert.ok(!none.includes("```diff") && none.includes("code not included"));
  assert.match(none, /\*\*`[^`]+`\*\* lines \d+-\d+: _code not included_/);

  const sec = renderMarkdown(doc, { section: doc.sections[0].id });
  assert.ok(sec.startsWith(`_From the review "${doc.title}"_\n\n## ${doc.sections[0].title}`));
  assert.ok(!sec.includes(`## ${doc.sections[1].title}`));
  assert.throws(() => renderMarkdown(doc, { section: "nope" }), /no section/);
});

test("export: serve offers the single file per code level as a download", async () => {
  const s = await startServe(SAMPLE, { log: () => {} });
  try {
    const r = await fetch(s.url + "api/export?code=none");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition")!, /^attachment; filename="demos-capture-the-backend[\w-]*\.review\.html"$/);
    const boot = bootOf(await r.text());
    assert.equal(boot.api, undefined, "the file is standalone (local feedback mode)");
    assert.equal(boot.doc.codeLevel, "none");
    assert.ok(Object.keys(boot.files!).some((p) => p.endsWith(".replay")));
    const def = bootOf(await (await fetch(s.url + "api/export")).text());
    assert.equal(def.doc.codeLevel, "key");
    const full = bootOf(await (await fetch(s.url + "api/export?code=full")).text());
    assert.ok(full.doc.files.some((f) => f.hunks.length > 0));
    assert.equal((await fetch(s.url + "api/export?code=bogus")).status, 400);
  } finally { await s.close(); }
});
