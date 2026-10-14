import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildArtifact } from "../artifact/cli/build.ts";
import { ghPr, parsePrRef, summarizeChecks } from "../artifact/cli/gather.ts";
import { countBySeverity, reviewMarkdown, type ReviewComment } from "../artifact/kit/review-model.ts";
import { makeGhUrl, linkify, sha256 } from "../artifact/kit/gh.ts";
import { createHash } from "node:crypto";
import type { Answer } from "../artifact/kit/feedback.ts";

const SAMPLE = resolve(import.meta.dirname, "../samples/pr-review.artifact");
const cs: ReviewComment[] = [
  { id: "a", file: "src/x.ts", line: 4, severity: "blocking", body: "Null deref." },
  { id: "b", file: "src/x.ts", range: [8, 10], severity: "nit", body: "Rename.", suggestion: "const y = 1;" },
  { id: "c", file: "src/z.ts", line: 2, severity: "praise", body: "Nice." },
  { id: "d", file: "src/z.ts", line: 3, severity: "question", body: "Why?" },
];
const ans = (choice: string, custom?: string): Answer => ({ choice, label: choice, custom, at: "x" });

test("reviewMarkdown: kept and edited comments only, by file, with suggestion and verdict", () => {
  const md = reviewMarkdown({ title: "T", verdict: "Request changes", summary: "Sum.", comments: cs, answers: { "rc:a": ans("keep"), "rc:b": ans("edit", "Better name."), "rc:c": ans("drop") } });
  assert.match(md, /^## Review: T\n\n\*\*Verdict:\*\* Request changes\n\nSum\./);
  assert.match(md, /### `src\/x.ts`/); assert.doesNotMatch(md, /src\/z.ts/, "dropped and undecided comments are left out");
  assert.match(md, /\*\*L4\*\* \(blocking\) Null deref\./);
  assert.match(md, /\*\*L8-10\*\* \(nit\) Better name\./); assert.doesNotMatch(md, /Rename\./, "edited text replaces the original");
  assert.match(md, /```suggestion\n {2}const y = 1;\n {2}```/);
  assert.match(md, /2 comments: 1 blocking, 1 nit/);
});

test("countBySeverity ignores dropped comments when answers are given", () => {
  assert.deepEqual(countBySeverity(cs), { blocking: 1, "should-fix": 0, question: 1, nit: 1, praise: 1 });
  assert.equal(countBySeverity(cs, { "rc:a": ans("drop") }).blocking, 0);
});

test("gather gh-pr: parses refs and builds data + patch from read-only gh calls", () => {
  assert.deepEqual(parsePrRef("acme/api#12"), { repo: "acme/api", n: 12 });
  assert.deepEqual(parsePrRef("https://github.com/acme/api/pull/7/files"), { repo: "acme/api", n: 7 });
  assert.throws(() => parsePrRef("nope"));
  const calls: string[][] = [];
  const exec = (_c: string, a: string[]) => {
    calls.push(a);
    if (a[0] === "pr" && a[1] === "view") return JSON.stringify({ title: "Fix", body: "Why", author: { login: "bob" }, state: "OPEN", baseRefName: "main", headRefName: "fix", url: "https://github.com/acme/api/pull/12", isDraft: true, headRefOid: "h".repeat(40), baseRefOid: "b".repeat(40), changedFiles: 1, statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "lint", status: "COMPLETED", conclusion: "FAILURE" }, { context: "x", state: "PENDING" }], additions: 3, deletions: 1, files: [{ path: "a.ts", additions: 3, deletions: 1 }], commits: [{ oid: "abcdef123456", messageHeadline: "fix it" }], reviews: [{ author: { login: "eve" }, state: "COMMENTED", body: "" }] });
    if (a[0] === "api" && a[1] === "user") return "bob\n";
    if (a[0] === "api") return JSON.stringify([{ id: 9, html_url: "https://github.com/acme/api/pull/12#discussion_r9", user: { login: "eve" }, path: "a.ts", line: 2, body: "hmm", created_at: "t" }]);
    if (a[0] === "pr" && a[1] === "diff") return "diff --git a/a.ts b/a.ts\n";
    throw new Error("unexpected " + a.join(" "));
  };
  const { data, patch } = ghPr("acme/api#12", exec);
  assert.equal(data.title, "Fix"); assert.equal(data.viewerIsAuthor, true); assert.equal(data.commits[0].sha, "abcdef1");
  assert.deepEqual(data.comments, [{ id: "9", author: "eve", path: "a.ts", line: 2, body: "hmm", at: "t", url: "https://github.com/acme/api/pull/12#discussion_r9" }]);
  assert.equal(data.url, "https://github.com/acme/api/pull/12"); assert.equal(data.draft, true); assert.equal(data.headSha, "h".repeat(40)); assert.equal(data.baseSha, "b".repeat(40));
  assert.equal(data.changedFiles, 1); assert.equal(data.commitCount, 1); assert.equal(data.commits[0].oid, "abcdef123456");
  assert.deepEqual(data.checks, { state: "fail", passed: 1, failed: 1, pending: 1, total: 3, failing: ["lint"] });
  assert.match(patch, /^diff --git/);
  for (const a of calls) assert.ok(["view", "diff", "user"].includes(a[1]) || a[1].startsWith("repos/"), "read-only calls only: " + a.join(" "));
});

async function launch(t: { skip: (m: string) => void }) {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { t.skip("no Chromium available"); return null; }
  const { chromium } = await import("playwright-core");
  return chromium.launch({ executablePath: exe });
}

test("guided review sample: Verdict, Layers, LayerTag, ReviewDiff margin, Keep/Edit/Drop, CopyReview", async (t) => {
  const b = await launch(t); if (!b) return;
  const root = mkdtempSync(join(tmpdir(), "art-rv-"));
  try {
    const out = join(root, "r.html"); writeFileSync(out, (await buildArtifact(SAMPLE)).html);
    const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await p.goto("file://" + out); await p.waitForSelector(".rv-layers");
    // Verdict: a Decision with the recommendation and severity counts
    assert.match((await p.locator(".rv-verdict").textContent())!, /Approve with comments[\s\S]*recommended/);
    assert.match((await p.locator(".rv-verdict .rv-counts").textContent())!, /1 should-fix.*2 question.*1 nit.*1 praise/);
    // Layers: states and dimming; LayerTag
    assert.deepEqual(await p.locator(".rv-layer").evaluateAll((l) => l.map((e) => (e as HTMLElement).dataset.state)), ["changed", "changed", "changed", "changed", "changed", "affected"]);
    assert.ok(Number(await p.locator(".rv-layer.affected").evaluate((e) => getComputedStyle(e).opacity)) < 1);
    assert.equal((await p.locator(".rv-layertag").first().textContent())!.trim(), "Layer 1 of 6: Drawer UI");
    await p.locator(".rv-layer-btn").first().click();
    await p.waitForFunction(() => document.getElementById("walk-drawer")!.getBoundingClientRect().top < 400, null, { timeout: 5000 }); // click jumps to the layer's anchor

    // ReviewComments on the home page: Keep / Edit / Drop, persisted as kit answers
    const card = (id: string) => p.locator(".rv-comments .rv-card", { hasText: id });
    await card("comments.tsx:149").getByRole("button", { name: "Keep" }).click();
    await card("host.css:57").getByRole("button", { name: "Drop" }).click();
    await card("comments.tsx:163").getByRole("button", { name: "Edit" }).click();
    await p.fill(".rv-edit textarea", "Edited nit text.");
    await p.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal(await card("host.css:57").getAttribute("data-status"), "drop");
    const stored = await p.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("artifact-answers:")).map(([, v]) => JSON.parse(v)));
    assert.deepEqual(Object.keys(stored[0]).filter((k) => k.startsWith("rc:")).sort(), ["rc:c1", "rc:c2", "rc:c4"]);
    // verdict and preview
    await p.locator(".a-decision button", { hasText: "Request changes" }).click();
    await p.getByRole("button", { name: "Preview" }).click();
    const md = (await p.locator(".rv-preview").textContent())!;
    assert.match(md, /\*\*Verdict:\*\* Request changes/); assert.match(md, /Edited nit text\./); assert.match(md, /comments\.tsx`/);
    assert.doesNotMatch(md, /root-cause|align-self: start/, "dropped comment left out"); assert.doesNotMatch(md, /fixed 250 ms/, "undecided comment left out");

    // ReviewDiff on its page: margin aligned to the line, gutter dot, toggle, inline cards when narrow
    await p.goto("file://" + out + "#/diff"); await p.waitForSelector(".rv-diff");
    assert.ok(await p.locator(".rv-files .rv-fbtn").count() >= 5, "file list");
    const row = p.locator("tr[data-line='149']").first();
    const cardBox = (await p.locator(".rv-margin .rv-card", { hasText: "comments.tsx:149" }).boundingBox())!;
    const rowBox = (await row.boundingBox())!;
    assert.ok(Math.abs(cardBox.y - rowBox.y) < 3, `margin card aligns to its line (${cardBox.y} vs ${rowBox.y})`);
    assert.ok(cardBox.x > rowBox.x + rowBox.width * 0.6, "card is in the right-hand margin");
    assert.equal(await row.locator(".rv-dot").count(), 1, "gutter dot");
    // edits made on the home page show here too (shared answers)
    assert.equal(await p.locator(".rv-card", { hasText: "host.css:57" }).first().getAttribute("data-status"), "drop");
    await p.getByRole("button", { name: /Hide comments/ }).click();
    assert.equal(await p.locator(".rv-margin .rv-card").first().isVisible(), false);
    assert.equal(await p.locator(".rv-dot").first().isVisible(), false);
    await p.getByRole("button", { name: /Show comments/ }).click();
    await p.setViewportSize({ width: 700, height: 900 });
    assert.equal(await p.locator("td.rv-margin").first().isVisible(), false, "no margin when narrow");
    const inline = p.locator("tr.rv-inline .rv-card", { hasText: "comments.tsx:149" });
    assert.equal(await inline.isVisible(), true, "cards inline below the line when narrow");
  } finally { await b.close(); rmSync(root, { recursive: true, force: true }); }
});

const pr = { repo: "acme/api", n: 12, headSha: "h1", baseSha: "b1", head: "fix", base: "main", files: [{ path: "src/a.ts" }, { path: "src/old name.ts", oldPath: "src/older.ts" }] };

test("makeGhUrl: file at head or base with line anchors, commit, pr, issue, diff anchor", () => {
  const g = makeGhUrl(pr);
  assert.equal(g.file("src/a.ts"), "https://github.com/acme/api/blob/h1/src/a.ts");
  assert.equal(g.file("src/a.ts", 7), "https://github.com/acme/api/blob/h1/src/a.ts#L7");
  assert.equal(g.file("src/a.ts", [7, 9], { side: "base" }), "https://github.com/acme/api/blob/b1/src/a.ts#L7-L9");
  assert.equal(g.file("src/old name.ts", 1), "https://github.com/acme/api/blob/h1/src/old%20name.ts#L1");
  assert.equal(g.commit("abc1234"), "https://github.com/acme/api/commit/abc1234");
  assert.equal(g.pr(), "https://github.com/acme/api/pull/12"); assert.equal(g.pr(3), "https://github.com/acme/api/pull/3"); assert.equal(g.issue(5), "https://github.com/acme/api/issues/5");
  assert.equal(g.diff("src/a.ts", 4), `https://github.com/acme/api/pull/12/files#diff-${createHash("sha256").update("src/a.ts").digest("hex")}R4`);
  assert.match(g.diff("src/a.ts", 4, { side: "base" }), /L4$/);
  assert.equal(g.comment(9), "https://github.com/acme/api/pull/12#discussion_r9");
  assert.equal(makeGhUrl({ repo: "a/b", n: 1 }).file("x.ts"), "https://github.com/a/b/blob/HEAD/x.ts");
});

test("sha256 matches node's, including long and multibyte paths", () => {
  for (const s of ["", "abc", "src/a.ts", "é/ü—x.ts", "p/".repeat(80)]) assert.equal(sha256(s), createHash("sha256").update(s).digest("hex"));
});

test("linkify: #123, owner/repo#123, urls, backticked file:line and sha; nothing inside plain words", () => {
  const parts = linkify("See #12 and acme/other#7, https://x.dev/a?b=1. Look at `src/a.ts:12-14`, `a.ts`, `abc1234`, `nope()`. fee#3 and C#", pr);
  const links = parts.filter((p) => p.t !== "text").map((p) => [p.s, (p as { href?: string }).href]);
  assert.deepEqual(links, [
    ["#12", "https://github.com/acme/api/issues/12"], ["acme/other#7", "https://github.com/acme/other/issues/7"], ["https://x.dev/a?b=1", "https://x.dev/a?b=1"],
    ["src/a.ts:12-14", "https://github.com/acme/api/blob/h1/src/a.ts#L12-L14"], ["a.ts", "https://github.com/acme/api/blob/h1/src/a.ts"], ["abc1234", "https://github.com/acme/api/commit/abc1234"], ["nope()", undefined],
  ]);
  assert.match(parts.map((p) => p.s).join(""), /trailing|\. Look/, "text kept");
  assert.equal(parts.map((p) => (p.t === "code" ? "`" + p.s + "`" : p.s)).join(""), "See #12 and acme/other#7, https://x.dev/a?b=1. Look at `src/a.ts:12-14`, `a.ts`, `abc1234`, `nope()`. fee#3 and C#");
  assert.deepEqual(linkify("#5 here"), [{ t: "text", s: "#5 here" }], "no pr: bare #n stays text");
});

test("summarizeChecks", () => {
  assert.equal(summarizeChecks(undefined).state, "none");
  assert.equal(summarizeChecks([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]).state, "pass");
  assert.equal(summarizeChecks([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }]).state, "pending");
});

test("guided review links: PR header, file and line links, card <-> diff jumps, existing comment, source link", async (t) => {
  const b = await launch(t); if (!b) return;
  const root = mkdtempSync(join(tmpdir(), "art-rvl-"));
  try {
    const out = join(root, "r.html"); writeFileSync(out, (await buildArtifact(SAMPLE)).html);
    const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await p.goto("file://" + out); await p.waitForSelector(".rv-pr");
    // first thing on the page after the shell title; links open in a new tab
    const hdr = p.locator(".rv-pr");
    assert.equal(await hdr.locator("h2 a").getAttribute("href"), "https://github.com/example/recap-lab/pull/16");
    assert.equal(await hdr.locator("h2 a").getAttribute("target"), "_blank");
    assert.match((await hdr.textContent())!, /example\/recap-lab#16[\s\S]*@builder[\s\S]*main.*task-5-artifact-kit[\s\S]*\+266.*−20 in 5 files[\s\S]*1 commit[\s\S]*checks failing/);
    assert.equal(await hdr.getByRole("link", { name: /Files changed/ }).getAttribute("href"), "https://github.com/example/recap-lab/pull/16/files");
    assert.match((await hdr.textContent())!, /Recommend: approve with comments · 1 should-fix/);
    assert.equal(await p.locator(".a-section").first().getAttribute("data-title"), "Why this PR exists", "the header is above every section");
    const verdictTop = await p.locator("#verdict-section").evaluate((e) => e.getBoundingClientRect().top + scrollY);
    const reviewTop = await p.locator("[data-section]", { hasText: "Your review" }).last().evaluate((e) => e.getBoundingClientRect().top + scrollY);
    assert.ok(verdictTop < reviewTop && verdictTop > 3000, "the full Verdict sits just above Your review");
    await hdr.locator("summary", { hasText: "1 commit" }).click();
    assert.match((await hdr.locator(".rv-commits a").first().getAttribute("href"))!, /\/commit\/cdfb5290f2495132/);
    // autolinks in text and the existing comment
    assert.equal(await p.locator("a", { hasText: "example/recap-lab#9" }).first().getAttribute("href"), "https://github.com/example/recap-lab/issues/9");
    assert.equal(await p.locator(".rv-existing a", { hasText: "open thread" }).getAttribute("href"), "https://github.com/example/recap-lab/pull/16#discussion_r9001");
    // Code with source: base commit
    assert.match((await p.locator("a.rv-gh", { hasText: "view on GitHub" }).getAttribute("href"))!, /blob\/560e13512ed1[^/]*\/artifact\/host\/host.css#L56$/);
    // card: line on GitHub, repeat-of links to the original, jump into the diff
    const card = p.locator(".rv-comments .rv-card", { hasText: "comments.tsx:149" });
    assert.match((await card.locator(".rv-where a").getAttribute("href"))!, /blob\/cdfb5290f2495132[^/]*\/artifact\/host\/comments.tsx#L149$/);
    assert.equal(await p.locator(".rv-comments .rv-card", { hasText: "feedback-drawer.test.ts:61" }).locator("a", { hasText: "repeat of @alex" }).getAttribute("href"), "https://github.com/example/recap-lab/pull/16#discussion_r9001");
    await card.getByRole("button", { name: "in the diff" }).click();
    await p.waitForSelector("#rd-c1");
    assert.equal(await p.evaluate(() => location.hash), "#/diff");
    // diff: header and line links, and back to the card
    const file = p.locator("details.rv-file", { hasText: "artifact/host/comments.tsx" }).first();
    assert.match((await file.locator("summary a.rv-gh").getAttribute("href"))!, /blob\/cdfb5290f2495132[^/]*\/artifact\/host\/comments.tsx$/);
    assert.match((await file.locator("tr[data-line='149'] td.n a").last().getAttribute("href"))!, /comments.tsx#L149$/);
    assert.match((await file.locator("tr.del td.n a").first().getAttribute("href"))!, /blob\/560e13512ed1[^/]*\/artifact\/host\/comments.tsx#L\d+$/, "old-side numbers link at the base commit");
    await p.locator("#rd-c1").getByRole("button", { name: "decide" }).click();
    await p.waitForSelector("#rc-c1");
    assert.equal(await p.evaluate(() => location.hash), "#/");
  } finally { await b.close(); rmSync(root, { recursive: true, force: true }); }
});
