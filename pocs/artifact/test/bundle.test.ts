import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { loadBundle, openFiles, packFiles } from "../src/parse/bundle.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));

test("planLink: review ↔ plan by node id", async () => {
  const b = await loadBundle(join(fixtures, "retries.review"));
  assert.deepEqual(b.doc.planLink, {
    src: "../retries.plan",
    title: "Retry failed webhook deliveries",
    done: ["worker", "retry", "attempts", "api", "ui"],
    notDone: ["alerts"],
    deferred: [],
    unplanned: ["metrics"],
  });
});

test("plan kind from bundle, plan questions at level 0", async () => {
  const b = await loadBundle(join(fixtures, "retries.plan"));
  assert.equal(b.doc.kind, "plan");
  assert.equal(b.doc.questions.length, 2);
  assert.equal(b.doc.planLink, undefined);
});

test("missing plan is a warning", async () => {
  const tmp = join(mkdtempSync(join(tmpdir(), "recap-")), "x.review");
  cpSync(join(fixtures, "retries.review"), tmp, { recursive: true });
  const b = await loadBundle(tmp);
  assert.equal(b.doc.planLink, undefined);
  assert.match(b.doc.warnings.join("\n"), /plan "..\/retries.plan" not found/);
});

test("zip round-trip: same model from dir and zip (also with a top-level folder)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "recap-"));
  const dirB = await loadBundle(join(fixtures, "retries.review"), { linkPlan: false });
  const zip = packFiles(dirB.files);
  writeFileSync(join(tmp, "retries.review"), zip);
  const zipB = await loadBundle(join(tmp, "retries.review"), { linkPlan: false });
  assert.equal(zipB.type, "zip");
  assert.deepEqual(zipB.files.list(), dirB.files.list());
  assert.deepEqual(zipB.doc, dirB.doc);

  const entries: Record<string, Uint8Array> = {};
  for (const p of dirB.files.list()) entries[`retries.review/${p}`] = dirB.files.read(p)!;
  writeFileSync(join(tmp, "nested.review"), zipSync(entries));
  const nested = await loadBundle(join(tmp, "nested.review"), { linkPlan: false });
  assert.deepEqual(nested.doc, dirB.doc);
});

test("dir reader refuses paths outside the bundle", () => {
  const f = openFiles(join(fixtures, "retries.review"));
  assert.equal(f.read("../retries.plan/doc.md"), undefined);
  assert.equal(f.has("doc.md"), true);
});

test("cli pack / unpack in place, model and comments", () => {
  const tmp = mkdtempSync(join(tmpdir(), "recap-"));
  const b = join(tmp, "retries.review");
  cpSync(join(fixtures, "retries.review"), b, { recursive: true });
  cpSync(join(fixtures, "retries.plan"), join(tmp, "retries.plan"), { recursive: true });
  writeFileSync(join(b, "comments.json"), JSON.stringify([
    { id: "c1", anchor: { section: "retry" }, author: "alex", body: "why 8?", created: "2026-10-05T10:00:00Z" },
    { id: "c2", anchor: { block: "worker-diff-1", line: 45 }, author: "alex", body: "ok", created: "2026-10-05T10:01:00Z", resolved: true },
  ]));
  const cli = (...a: string[]) => execFileSync(process.execPath, ["--import", "tsx", join(root, "src/cli.ts"), ...a], { cwd: root, encoding: "utf8" });
  const before = cli("model", b);
  cli("pack", b);
  assert.ok(statSync(b).isFile());
  assert.equal(readFileSync(b).subarray(0, 2).toString(), "PK");
  assert.equal(cli("model", b), before); // planLink resolves from the zip too
  assert.equal(JSON.parse(cli("comments", b, "--open")).length, 1);
  cli("unpack", b);
  assert.ok(statSync(b).isDirectory());
  assert.ok(existsSync(join(b, "changes.patch")));
  assert.equal(cli("model", b), before);
});

test("cli md", () => {
  const cli = (...a: string[]) => execFileSync(process.execPath, ["--import", "tsx", join(root, "src/cli.ts"), ...a], { cwd: root, encoding: "utf8", stdio: "pipe" });
  const md = cli("md", join(fixtures, "retries.review"), "--link", "https://example.com/d/abc");
  assert.match(md, /^### Review: Retry failed webhook deliveries/);
  assert.match(md, /```mermaid\nflowchart LR/);
  assert.match(md, /n_retry\["Retry scheduler"\]:::added/);
  assert.match(md, /\[Open the visual review\]\(https:\/\/example.com\/d\/abc\)/);
});
