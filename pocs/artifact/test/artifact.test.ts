import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { buildArtifact, renderStatic } from "../artifact/cli/build.ts";
import { slimReplay, neededFiles } from "../artifact/cli/evidence.ts";
import { check } from "../artifact/cli/check.ts";
import { dev } from "../artifact/cli/dev.ts";
import { scaffold } from "../artifact/cli/scaffold.ts";
import { main } from "../artifact/cli/main.ts";
import { approxMeasure, layoutMap, mapMetrics } from "../artifact/kit/map-layout.ts";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const keep = 1;
-const oldLineAlpha = 2;
+const newLineAlpha = 3;
 export {};
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-const secondFileOnlyOld = 1;
+const secondFileOnlyNew = 2;
 export {};
`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const replay = () => Buffer.from(zipSync({
  "manifest.json": strToU8(JSON.stringify({ name: "r" })), "steps.json": strToU8(JSON.stringify([{ t: 1, text: "step one" }])),
  "rrweb.json": strToU8("[]"), "trace.zip": strToU8("TRACE-PAYLOAD".repeat(50)),
}));

function fixture(index: string, extra: (d: string) => void = () => {}) {
  const d = mkdtempSync(join(tmpdir(), "art-test-")) + "/x.artifact";
  mkdirSync(join(d, "evidence"), { recursive: true }); mkdirSync(join(d, "data"));
  writeFileSync(join(d, "artifact.json"), JSON.stringify({ title: "Fixture", kind: "test", audience: "tests", summary: "s" }));
  writeFileSync(join(d, "data/prs.json"), JSON.stringify([{ title: "UNIQUE-DATA-STRING" }]));
  writeFileSync(join(d, "evidence/c.patch"), PATCH);
  writeFileSync(join(d, "evidence/shot.png"), PNG);
  writeFileSync(join(d, "evidence/a.replay"), replay());
  writeFileSync(join(d, "evidence/unused.png"), PNG);
  writeFileSync(join(d, "index.tsx"), index);
  extra(d);
  return d;
}
const cleanup = (d: string) => rmSync(join(d, ".."), { recursive: true, force: true });

const INDEX = `import { Section, Diff, Img, Replay, useData } from "artifact";
import prs from "./data/prs.json";
export default function A() {
  const fromHook = useData<{ title: string }[]>("prs");
  return <Section title="One"><p>{prs[0].title}{fromHook.length}</p>
    <Diff patch="evidence/c.patch" file="src/a.ts" /><Img src="evidence/shot.png" /><Replay src="evidence/a.replay" /></Section>;
}`;

test("build inlines parsed evidence and data, with no raw patch in the output", async () => {
  const d = fixture(INDEX);
  try {
    const r = await buildArtifact(d);
    assert.deepEqual(r.errors, []);
    const h = r.html;
    assert.match(h, /UNIQUE-DATA-STRING/);
    assert.match(h, /newLineAlpha/, "the requested file's lines are inlined, parsed");
    assert.doesNotMatch(h, /index 111\.\.222|\+\+\+ b\/src\/a\.ts|@@ -1,3 \+1,3 @@/, "raw patch text is not in the output");
    assert.doesNotMatch(h, /secondFileOnlyNew/, "files the Diff doesn't ask for are pruned");
    assert.match(h, /data:image\/png;base64,/);
    assert.deepEqual(r.collected.unreferenced, ["evidence/unused.png"]);
    assert.equal(r.collected.missing.length, 0);
    assert.equal((h.match(/<\/script>/g) ?? []).length, 1);
    assert.ok(h.startsWith("<!doctype html>") && h.includes('<div id="root">'));
    assert.ok(r.bytes < 600_000, `base page stays small (${r.bytes})`);
  } finally { cleanup(d); }
});

test("a Diff without file= inlines every file of the patch", async () => {
  const d = fixture(INDEX.replace(' file="src/a.ts"', ""));
  try { assert.match((await buildArtifact(d)).html, /secondFileOnlyNew/); } finally { cleanup(d); }
});

test("direct imports of evidence: png as data URI, patch parsed", async () => {
  const d = fixture(`import { Section, Diff } from "artifact";
import shot from "./evidence/shot.png";
import patch from "./evidence/c.patch";
export default () => <Section title="I"><img src={shot} /><Diff patch={patch} /></Section>;`);
  try {
    const r = await buildArtifact(d);
    assert.deepEqual(r.errors, []);
    assert.match(r.html, /data:image\/png;base64/);
    assert.doesNotMatch(r.html, /index 111\.\.222/);
    assert.deepEqual(r.collected.missing, []);
  } finally { cleanup(d); }
});

test("missing evidence is reported", async () => {
  const d = fixture(`import { Img } from "artifact"; export default () => <Img src="evidence/nope.png" />;`);
  try {
    const r = await buildArtifact(d);
    assert.deepEqual(r.collected.missing, ["evidence/nope.png"]);
    const rep = await check(d, { types: false });
    assert.ok(rep.errors.some((e) => e.includes("evidence/nope.png")));
  } finally { cleanup(d); }
});

test("a bundle error is reported, not thrown", async () => {
  const d = fixture(`export default () => <div>{</div>;`);
  try {
    const r = await buildArtifact(d);
    assert.ok(r.errors.length > 0);
    assert.equal(r.html, "");
  } finally { cleanup(d); }
});

test("slimReplay drops trace.zip and keeps the streams", () => {
  const files = unzipSync(Buffer.from(slimReplay(replay()), "base64"));
  assert.deepEqual(Object.keys(files).sort(), ["manifest.json", "rrweb.json", "steps.json"]);
});

test("neededFiles narrows only when every use names its files", () => {
  assert.deepEqual(neededFiles(`<Diff patch="evidence/c.patch" file="a.ts" />`, "evidence/c.patch"), ["a.ts"]);
  assert.equal(neededFiles(`<Diff patch="evidence/c.patch" />`, "evidence/c.patch"), null);
  assert.equal(neededFiles(`<Diff patch="evidence/c.patch" file="a.ts" /><Foo x="evidence/c.patch"/>`, "evidence/c.patch"), null);
  assert.deepEqual(neededFiles(`<Diff notes={{1: () => <b/>}} patch="evidence/c.patch" file="a.ts" />`, "evidence/c.patch"), ["a.ts"]);
});

test("check passes on a good artifact and renders it server-side", async () => {
  const d = fixture(INDEX);
  try {
    const rep = await check(d);
    assert.deepEqual(rep.errors, []);
    const s = await renderStatic(d);
    assert.ok("html" in s && s.html.includes("UNIQUE-DATA-STRING"), JSON.stringify(s).slice(0, 300));
  } finally { cleanup(d); }
});

test("check flags type errors, runtime errors and duplicate section ids", async () => {
  let d = fixture(`import { Section } from "artifact"; export default () => <Section title={5 as unknown as number}>{(1 as string)}</Section>;`);
  try { assert.ok((await check(d)).errors.some((e) => /TS\d+/.test(e))); } finally { cleanup(d); }
  d = fixture(`export default function A() { const x = undefined as unknown as { a: string[] }; return <div>{x.a.map((s) => s)}</div>; }`);
  try { assert.ok((await check(d, { types: false })).errors.some((e) => e.includes("render error"))); } finally { cleanup(d); }
  d = fixture(`import { Section } from "artifact"; export default () => <><Section title="A" /><Section title="A" /></>;`);
  try { assert.ok((await check(d, { types: false })).errors.some((e) => e.includes("duplicate Section id"))); } finally { cleanup(d); }
});

test("cli: new → check → build", async () => {
  const root = mkdtempSync(join(tmpdir(), "art-cli-"));
  try {
    const log = console.log; console.log = () => {};
    try {
      assert.equal(await main(["new", join(root, "demo"), "--kind", "explainer"]), 0);
      const dir = join(root, "demo.artifact");
      assert.equal(JSON.parse(readFileSync(join(dir, "artifact.json"), "utf8")).kind, "explainer");
      assert.equal(await main(["check", dir]), 0);
      assert.equal(await main(["build", dir, "-o", join(root, "out/demo.html")]), 0);
    } finally { console.log = log; }
    const html = readFileSync(join(root, "out/demo.html"), "utf8");
    assert.match(html, /<title>Demo<\/title>/);
    assert.throws(() => scaffold(join(root, "demo")), /not empty/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cli: build without -o and unknown commands fail", async () => {
  const err = console.error, log = console.log; console.error = () => {}; console.log = () => {};
  try {
    assert.equal(await main(["build", "x.artifact"]), 2);
    assert.equal(await main(["bogus", "x"]), 2);
  } finally { console.error = err; console.log = log; }
});

test("dev serves on loopback, refuses other hosts, rebuilds on change", async () => {
  const d = fixture(INDEX);
  const log = console.log; console.log = () => {};
  try {
    await assert.rejects(dev(d, 0, "0.0.0.0"), /loopback/);
    const s = await dev(d, 0);
    try {
      const html = await (await fetch(`http://127.0.0.1:${s.port}/`)).text();
      assert.match(html, /UNIQUE-DATA-STRING/);
      assert.match(html, /EventSource/);
      writeFileSync(join(d, "data/prs.json"), JSON.stringify([{ title: "CHANGED-DATA" }]));
      let again = "";
      for (let i = 0; i < 50 && !again.includes("CHANGED-DATA"); i++) { await new Promise((r) => setTimeout(r, 100)); again = await (await fetch(`http://127.0.0.1:${s.port}/`)).text(); }
      assert.match(again, /CHANGED-DATA/);
    } finally { await s.close(); }
  } finally { console.log = log; cleanup(d); }
});

test("map layout (kit): no edge outside, no label on a node", async () => {
  const map = {
    groups: [{ id: "g", label: "Group" }],
    nodes: [{ id: "a", label: "Agent", group: "g" }, { id: "b", label: "Build" }, { id: "c", label: "HTML" }, { id: "d", label: "Host chrome with a long name" }],
    edges: [{ from: "a", to: "b", label: "writes" }, { from: "b", to: "c" }, { from: "c", to: "d", label: "opens" }, { from: "d", to: "a", label: "feedback" }],
  };
  for (const dir of ["RIGHT", "DOWN"] as const) {
    const m = mapMetrics(await layoutMap(map, dir, approxMeasure));
    assert.deepEqual(m.outside, []);
    assert.equal(m.labelHitsNode, 0);
  }
  assert.ok(!existsSync("/nonexistent"));
});

test("index.mdx: Markdown with kit components and evidence", async () => {
  const d = fixture("");
  rmSync(join(d, "index.tsx"));
  writeFileSync(join(d, "index.mdx"), `import { Section, Callout, Diff } from "artifact";

<Section title="Notes">

Some **markdown** with a list:

- one
- two

<Callout tone="warn">watch out</Callout>

<Diff patch="evidence/c.patch" file="src/a.ts" />

</Section>
`);
  try {
    const r = await buildArtifact(d);
    assert.deepEqual(r.errors.map((e) => e.text), []);
    assert.match(r.html, /newLineAlpha/);
    const s = await renderStatic(d);
    assert.ok("html" in s && /<strong>markdown<\/strong>/.test(s.html) && s.html.includes("watch out"), JSON.stringify(s).slice(0, 300));
  } finally { cleanup(d); }
});

import { symlinkSync } from "node:fs";

test("evidence cannot escape evidence/: .. in code, .. in data, symlink out", async () => {
  const d = fixture(`import { Code } from "artifact"; export default () => <Code file="evidence/../../secret.txt" />;`, (dir) => {
    writeFileSync(join(dir, "../secret.txt"), "TOP-SECRET-OUTSIDE");
    symlinkSync(join(dir, "../secret.txt"), join(dir, "evidence/link.txt"));
  });
  try {
    let r = await buildArtifact(d);
    assert.doesNotMatch(r.html, /TOP-SECRET-OUTSIDE|VE9QLVNFQ1JFVC1PVVRTSURF/);
    assert.deepEqual(r.collected.unsafe, ["evidence/../../secret.txt"]);
    assert.ok((await check(d, { types: false })).errors.some((e) => e.includes("leaves evidence/")));
    // via a data file: whole-string value
    writeFileSync(join(d, "data/d.json"), JSON.stringify({ f: "evidence/../../secret.txt" }));
    writeFileSync(join(d, "index.tsx"), `export default () => <p>x</p>;`);
    r = await buildArtifact(d);
    assert.doesNotMatch(r.html, /TOP-SECRET-OUTSIDE/);
    assert.deepEqual(r.collected.unsafe, ["evidence/../../secret.txt"]);
    // via a symlink inside evidence/
    writeFileSync(join(d, "data/d.json"), "{}");
    writeFileSync(join(d, "index.tsx"), `import { Code } from "artifact"; export default () => <Code file="evidence/link.txt" />;`);
    r = await buildArtifact(d);
    assert.doesNotMatch(r.html, /TOP-SECRET-OUTSIDE/);
    assert.deepEqual(r.collected.unsafe, ["evidence/link.txt"]);
  } finally { cleanup(d); }
});

test("paths mentioned in data or prose are not references", async () => {
  const d = fixture(`// see evidence/in-a-comment-nope.png\nexport default () => <p>{"vault/work/evidence/also-nope.png"} samples/x.artifact/evidence/after-v2.svg</p>;`, (dir) => {
    writeFileSync(join(dir, "data/d.json"), JSON.stringify({ files: ["samples/hello.artifact/evidence/after-v2.svg"], note: "see evidence/foo for more" }));
  });
  try {
    const r = await buildArtifact(d);
    assert.deepEqual(r.collected.missing, []);
    assert.deepEqual(r.collected.unsafe, []);
  } finally { cleanup(d); }
});

test("a whole-string evidence path in data is a reference", async () => {
  const d = fixture(`import { Img, useData } from "artifact"; export default () => <Img src={useData<{ img: string }>("d").img} />;`, (dir) => {
    writeFileSync(join(dir, "data/d.json"), JSON.stringify({ img: "evidence/shot.png" }));
  });
  try {
    const r = await buildArtifact(d);
    assert.deepEqual(Object.keys(r.collected.registry.evidence), ["evidence/shot.png"]);
  } finally { cleanup(d); }
});

test("check: a missing data file is a real error; browser-only ReferenceErrors are not", async () => {
  let d = fixture(`import { useData } from "artifact"; export default () => <p>{String(useData("documents"))}</p>;`);
  try { assert.ok((await check(d, { types: false })).errors.some((e) => e.includes("render error") && e.includes("data/documents.json"))); } finally { cleanup(d); }
  d = fixture(`export default () => <p>{String(window.innerWidth)}</p>;`);
  try { assert.deepEqual((await check(d, { types: false })).errors, []); } finally { cleanup(d); }
  // a directory named like a browser global must not hide errors
  const root = mkdtempSync(join(tmpdir(), "art-doc-"));
  try {
    const nested = join(root, "document-self-window.artifact");
    mkdirSync(join(nested, "data"), { recursive: true });
    writeFileSync(join(nested, "artifact.json"), JSON.stringify({ title: "T", kind: "k", audience: "a", summary: "s" }));
    writeFileSync(join(nested, "index.tsx"), `export default function A() { throw new Error("boom"); }`);
    assert.ok((await check(nested, { types: false })).errors.some((e) => e.includes("boom")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dev: rejects a foreign Host header, accepts localhost", async () => {
  const d = fixture(INDEX);
  const log = console.log; console.log = () => {};
  try {
    const s = await dev(d, 0);
    try {
      const { request } = await import("node:http");
      const get = (host: string) => new Promise<number>((ok, bad) => {
        const q = request({ host: "127.0.0.1", port: s.port, path: "/", headers: { host } }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
        q.on("error", bad); q.end();
      });
      assert.equal(await get("evil.example.com"), 403);
      assert.equal(await get(`evil.example.com:${s.port}`), 403);
      assert.equal(await get(`localhost:${s.port}`), 200);
      assert.equal(await get(`mini.internal:${s.port}`), 200);
      assert.equal(await get(`[::1]:${s.port}`), 200);
    } finally { await s.close(); }
  } finally { console.log = log; cleanup(d); }
});

test("patch pruning reads file= only at the tag's own level", () => {
  const src = `<Diff patch="evidence/a.patch" notes={{3: "see file='other.ts'"}} file="real.ts" />`;
  assert.deepEqual(neededFiles(src, "evidence/a.patch"), ["real.ts"]);
  const src2 = `<Diff notes={{3: "patch='evidence/a.patch'"}} patch="evidence/b.patch" file="x.ts" />`;
  assert.equal(neededFiles(src2, "evidence/a.patch"), null);
  assert.deepEqual(neededFiles(`<Diff patch="evidence/a.patch" file={["a.ts", "b.ts"]} />`, "evidence/a.patch"), ["a.ts", "b.ts"]);
  assert.equal(neededFiles(`<Diff patch="evidence/a.patch" file={pick} />`, "evidence/a.patch"), null);
});

test("check does not typecheck source files under evidence/", async () => {
  const d = fixture(`export default () => <p>x</p>;`, (dir) => {
    writeFileSync(join(dir, "evidence/broken.ts"), `import x from "not-a-module"; export const y: number = "no";`);
  });
  try { assert.deepEqual((await check(d)).errors, []); } finally { cleanup(d); }
});

test("highlightLines keeps every line on JSX and falls back to plain when it can't", async () => {
  const { highlightLines } = await import("../artifact/kit/highlight.ts");
  const src = `function D() {\n  return (\n    <Dialog>\n      <Trigger render={<Button tone="x" />} />\n      <Panel footer={\n        <>\n          <Close render={<B />} />\n        </>\n      }>\n        <Text>a &amp; b &lt; c</Text>\n      </Panel>\n    </Dialog>\n  );\n}`.split("\n");
  for (const lang of ["typescript", "tsx", "javascript", undefined]) {
    const out = highlightLines(src, lang);
    assert.equal(out.length, src.length);
    out.forEach((h, i) => assert.equal(h.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"'), src[i]));
  }
});

test("shot saves PNGs of the page and a present slide", async (t) => {
  const { shot, findChrome } = await import("../artifact/cli/shot.ts");
  try { await findChrome(); } catch { return t.skip("no Chromium available"); }
  const d = fixture(`import { Section, Map } from "artifact"; export default () => <><Section title="A"><p>a</p></Section><Section title="B"><Map nodes={Array.from({length: 14}, (_, i) => ({ id: "n" + i, label: "A fairly long node label " + i }))} edges={Array.from({length: 13}, (_, i) => ({ from: "n" + i, to: "n" + (i + 1) }))} direction="right" /></Section></>;`);
  try {
    const out = join(d, "../shots");
    const paths = await shot(d, { out, themes: ["dark"], present: "1,3" });
    assert.equal(paths.length, 3);
    for (const p of paths) assert.ok(readFileSync(p).subarray(1, 4).toString() === "PNG", p);
  } finally { cleanup(d); }
});

test("niceTicks gives round values and ageOf counts from the gather time", async () => {
  const { niceTicks } = await import("../artifact/kit/util.ts");
  assert.deepEqual(niceTicks(200.5).ticks, [0, 50, 100, 150, 200, 250]);
  assert.deepEqual(niceTicks(7).ticks, [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(0).ticks, [0, 1]);
  const { ageOf } = await import("../artifact/kit/util.ts");
  assert.equal(ageOf("2026-10-10T10:00:00Z", "2026-10-12T10:00:00Z").text, "2 d ago");
  assert.equal(ageOf("2026-10-12T09:40:00Z", "2026-10-12T10:00:00Z").text, "20 min ago");
});

test("hello sample: all components render server-side and Decision ids are real ids", async () => {
  const s = await renderStatic("samples/hello.artifact");
  assert.ok("html" in s, JSON.stringify(s));
  assert.match(s.html, /id="d-ship"/);
  assert.match(s.html, /data-c="scorecard"/);
  assert.match(s.html, /conflicts/);
});

test("tiles gallery, stats and image helpers render", async () => {
  const d = fixture(`import { Gallery, Stats, Img, imageSrc, Section } from "artifact";
export default () => <Section title="G"><Stats items={[{ value: 3, label: "things", href: "#x" }]} />
<Gallery items={[{ label: "one", thumb: "evidence/shot.png", status: "done", summary: "S1", detail: <p>DETAIL-ONE</p> }, { label: "two", summary: "S2", detail: <p>DETAIL-TWO</p> }]} />
<Img src="evidence/shot.png" thumb /><Img src="evidence/shot.png" fit="cover" height={80} /><i>{imageSrc("evidence/shot.png").slice(0, 10)}</i></Section>;`);
  try {
    const s = await renderStatic(d);
    assert.ok("html" in s, JSON.stringify(s));
    assert.match(s.html, /data-c="stats"/);
    assert.match(s.html, /class="a-tile"/);
    assert.match(s.html, /DETAIL-ONE/);
    assert.doesNotMatch(s.html, /DETAIL-TWO/, "only the selected tile's detail is open");
    assert.match(s.html, /data:image\/png/);
  } finally { cleanup(d); }
});

test("timeline lanes share rows by `when`", async () => {
  const d = fixture(`import { Timeline } from "artifact";
export default () => <Timeline items={[{ when: "Mon", lane: "you", title: "A" }, { when: "Mon", lane: "agent", title: "B" }, { when: "Tue", lane: "you", title: "C" }, { when: "Tue", lane: "lead", title: "D" }]} />;`);
  try {
    const s = await renderStatic(d);
    assert.ok("html" in s, JSON.stringify(s));
    assert.equal((s.html.match(/a-tl-whencell/g) ?? []).length, 2, "4 events, 2 times: 2 rows");
    assert.ok(/grid-template-columns:max-content repeat\(3,/.test(s.html));
  } finally { cleanup(d); }
});

test("artifact.json header is accepted; a leftover depth key is ignored", async () => {
  const d = fixture(`export default () => <p>x</p>;`);
  writeFileSync(join(d, "artifact.json"), JSON.stringify({ title: "T", kind: "k", audience: "a", summary: "s", depth: 2, header: "full" }));
  try {
    const r = await buildArtifact(d);
    assert.equal((r.collected.registry.meta as { depth?: number }).depth, 2, "kept as data, never used");
    assert.equal(r.collected.registry.meta.header, "full");
  } finally { cleanup(d); }
});

import { execFileSync } from "node:child_process";
import { parseBoard, ghPrs, gitLog, gatherCmd } from "../artifact/cli/gather.ts";

test("gather: board text, gh PRs (stubbed gh), git log", () => {
  const b = parseBoard(`To Do:\n  [HIGH] TASK-3 - Do the thing (ac: 1/2)\n  TASK-4 - Other\n\nIn Progress:\n  TASK-5 - Busy\n\nDone:\n  TASK-1 - Old\n  TASK-2 - Older\n`);
  assert.deepEqual(b.todo.map((t) => [t.id, t.priority, t.ac]), [["task-3", "HIGH", [1, 2]], ["task-4", null, undefined]]);
  assert.equal(b.doing[0].title, "Busy");
  assert.equal(b.doneCount, 2);

  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return args.includes("merged") ? `[{"number":1},{"number":2}]` : JSON.stringify([
      { number: 7, title: "T", isDraft: false, reviewDecision: "CHANGES_REQUESTED", baseRefName: "main", headRefName: "x", updatedAt: "2026-10-10T00:00:00Z", mergeable: "CONFLICTING", url: "https://h/7", statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }], author: { login: "me" } },
      { number: 8, title: "D", isDraft: true, reviewDecision: "", baseRefName: "main", headRefName: "y", updatedAt: "2026-10-11T00:00:00Z", mergeable: "MERGEABLE", url: "https://h/8", statusCheckRollup: [] },
    ]);
  };
  const r = ghPrs(["o/a"], { since: "2026-10-11T00:00:00Z", exec });
  assert.deepEqual(r.prs.map((p) => [p.n, p.state, p.review, p.checks, p.conflict]), [[7, "open", "changes", "fail", true], [8, "draft", undefined, undefined, false]]);
  assert.equal(r.merged["o/a"], 2);
  assert.ok(calls.every((c) => c[0] === "gh"));

  const root = mkdtempSync(join(tmpdir(), "art-git-"));
  try {
    const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
    g("init", "-q"); writeFileSync(join(root, "f"), "1"); g("add", "."); g("commit", "-q", "-m", "first"); writeFileSync(join(root, "f"), "2"); g("commit", "-qam", "second");
    const l = gitLog(root);
    assert.deepEqual(l.commits.map((c) => c.subject), ["second", "first"]);
    const art = join(root, "x.artifact");
    const log = console.log; console.log = () => {};
    try { assert.equal(gatherCmd("git-log", art, { repo: root }), 0); } finally { console.log = log; }
    assert.equal(JSON.parse(readFileSync(join(art, "data/git-log.json"), "utf8")).commits.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture saves a jpg of one element and honours steps", async (t) => {
  const { capture, findChrome } = await import("../artifact/cli/shot.ts");
  try { await findChrome(); } catch { return t.skip("no Chromium available"); }
  const root = mkdtempSync(join(tmpdir(), "art-cap-"));
  try {
    writeFileSync(join(root, "p.html"), `<button id=b onclick="document.getElementById('o').textContent='clicked'">go</button><div id=o style="width:200px;height:60px;background:#cde">x</div>`);
    writeFileSync(join(root, "steps.json"), JSON.stringify([{ click: "#b" }, { wait: 50 }]));
    const out = await capture(join(root, "p.html"), { out: join(root, "evidence/o.jpg"), selector: "#o", steps: join(root, "steps.json") });
    const bytes = readFileSync(out);
    assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { advise, unpublishedCommits } from "../artifact/cli/advice.ts";
import { gitBranches } from "../artifact/cli/gather.ts";

test("check advice: summary repeat, long page, big table, empty slide", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ name: "row " + i }));
  const d = fixture(`import { Callout, Section, Step, Table, More } from "artifact";
export default () => <>
  <Callout>The kit builds artifacts as one HTML file from index tsx and components</Callout>
  <Section id="a" title="Steps only"><Step><p>hidden at step zero</p></Step></Section>
  <Section id="b" title="Big"><Table columns={["name"]} rows={${JSON.stringify(rows)}} /></Section>
  <Section id="c" title="Fine"><More label="all rows"><Table columns={["name"]} rows={${JSON.stringify(rows)}} /></More></Section>
</>;`);
  writeFileSync(join(d, "artifact.json"), JSON.stringify({ title: "T", kind: "k", audience: "a", summary: "The kit builds artifacts as one HTML file from index tsx and components." }));
  try {
    const rep = await check(d, { types: false });
    assert.deepEqual(rep.errors, []);
    const w = rep.warnings.join("\n");
    assert.match(w, /first Callout repeats the summary/);
    assert.match(w, /slide "Steps only" is empty at step 0/);
    assert.equal((w.match(/a table with 25 rows/g) ?? []).length, 1, "only the table outside More");
    const long = advise(`<div class="a-content">${"<p>" + "word ".repeat(2600) + "</p>"}</div>`, {});
    assert.match(long.warnings.join(), /long page/);
    assert.deepEqual(advise(`<div class="a-content">${"<p>" + "word ".repeat(2600) + "</p>"}</div>`, {}).warnings.length, 1);
  } finally { cleanup(d); }
});

test("check advice: commits missing from every remote branch (stubbed git)", () => {
  const exec = (_c: string, args: string[]) => { if (args.includes("aaaaaaa")) return "  origin/main\n"; return ""; };
  const bad = unpublishedCommits(`<Source label="c" kind="commit" href="https://x/commit/bbbbbbb" /><Source kind="commit" label="aaaaaaa" />`, { sources: [{ label: "ccccccc", kind: "commit" }] }, "/r", exec);
  assert.deepEqual(bad.sort(), ["bbbbbbb", "ccccccc"]);
});

test("gather git-log --branches counts unique commits against a base", () => {
  const root = mkdtempSync(join(tmpdir(), "art-br-"));
  try {
    const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
    g("init", "-q", "-b", "main"); writeFileSync(join(root, "f"), "1"); g("add", "."); g("commit", "-q", "-m", "base");
    for (const [b, n] of [["idea/a", 2], ["idea/b", 1], ["other/c", 3]] as const) {
      g("checkout", "-q", "-b", b, "main");
      for (let i = 0; i < n; i++) { writeFileSync(join(root, "f"), b + i); g("commit", "-qam", `${b} ${i}`); }
    }
    const r = gitBranches(root, "idea/*", "main");
    assert.deepEqual(r.branches.map((x) => [x.branch, x.ahead]).sort(), [["idea/a", 2], ["idea/b", 1]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("images are eager (inlined data URIs gain nothing from lazy) and as-of is shown in one zone", async () => {
  const d = fixture(`import { Img } from "artifact"; export default () => <Img src="evidence/shot.png" />;`);
  try {
    const s = await renderStatic(d);
    assert.ok("html" in s);
    assert.doesNotMatch(s.html, /loading="lazy"/);
    const { fmtAsOf } = await import("../artifact/kit/util.ts");
    assert.equal(fmtAsOf("2026-10-12T13:18:00Z"), "12 Oct 2026, 13:18 UTC");
    assert.match(fmtAsOf("2026-10-12T13:18:00Z", "Asia/Bangkok"), /20:18/);
  } finally { cleanup(d); }
});

test("inline script escaping keeps regex literals with the u flag valid (JSX highlighting)", async () => {
  const { page } = await import("../artifact/cli/build.ts");
  const html = page("t", "a{}", `globalThis.__r = [/<!--/u.test("<!--"), "</script>".length, "<!--".length].join();`);
  assert.equal(html.match(/<\/script>/g)?.length, 1, "only the closing tag");
  assert.doesNotMatch(html, /<!--/);
  const js = html.slice(html.indexOf('<script id="a-js">') + 18, html.lastIndexOf("</script>"));
  new Function(js)();
  assert.equal((globalThis as unknown as { __r: string }).__r, "true,9,4");
});

test("JSX evidence is highlighted in the built page (browser)", async (t) => {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { return t.skip("no Chromium available"); }
  const { chromium } = await import("playwright-core");
  const d = fixture(`import { Code } from "artifact"; export default () => <Code file="evidence/x.tsx" />;`, (dir) => {
    writeFileSync(join(dir, "evidence/x.tsx"), `export const A = () => (\n  <>\n    <Dialog render={<Button tone="critical" />}>\n      <Text>hi &amp; bye</Text>\n    </Dialog>\n  </>\n);\n`);
  });
  const out = join(d, "../a.html");
  try {
    writeFileSync(out, (await buildArtifact(d)).html);
    const b = await chromium.launch({ executablePath: exe });
    try {
      const p = await b.newPage();
      await p.goto("file://" + out);
      await p.waitForSelector(".a-ln");
      assert.ok(await p.locator('.a-ln [class*="hljs-"]').count() > 5, "tokens are coloured");
      assert.equal(await p.locator(".a-ln").count(), 7);
    } finally { await b.close(); }
  } finally { cleanup(d); }
});

import { trim } from "../artifact/cli/gather.ts";
import { smallMaps } from "../artifact/cli/advice.ts";

test("Status/Gallery take a custom label with a tone; Time uses the artifact's zone; long code gets a wrap toggle", async () => {
  const d = fixture(`import { Status, Gallery, Time, Code, Section } from "artifact";
export default () => <Section title="S"><Status s={{ label: "fix first", tone: "warn" }} />
<Gallery items={[{ label: "a", summary: "x", status: { label: "gated", tone: "critical" }, detail: <p>d</p> }]} />
<Time iso="2026-10-12T13:18:00Z" /><Code code={"x".repeat(160)} /></Section>;`);
  writeFileSync(join(d, "artifact.json"), JSON.stringify({ title: "T", kind: "k", audience: "a", summary: "s", timeZone: "Asia/Bangkok" }));
  try {
    const s = await renderStatic(d);
    assert.ok("html" in s, JSON.stringify(s));
    assert.match(s.html, /tone-warn[^>]*><i><\/i>fix first/);
    assert.match(s.html, /tone-critical[^>]*><i><\/i>gated/);
    assert.match(s.html, /12 Oct 2026, 20:18/);
    assert.match(s.html, /a-code-wrap/);
  } finally { cleanup(d); }
});

test("gather --fields / --count trim output", () => {
  const data = { prs: [{ n: 1, title: "t", href: "h" }, { n: 2, title: "u", href: "i" }], merged: { a: 3 }, todo: [{ id: "x", title: "y" }], names: ["a", "b"] };
  assert.deepEqual(trim(data, { fields: ["n"] }), { prs: [{ n: 1 }, { n: 2 }], merged: { a: 3 }, todo: [{}], names: ["a", "b"] });
  assert.deepEqual(trim(data, { count: true }), { prs: 2, merged: { a: 3 }, todo: 1, names: 2 });
});

test("check warns when a map fits too small, and the render records maps", async () => {
  const nodes = Array.from({ length: 16 }, (_, i) => ({ id: "n" + i, label: "A reasonably long node label " + i }));
  const edges = Array.from({ length: 15 }, (_, i) => ({ from: "n" + i, to: "n" + (i + 1) }));
  const d = fixture(`import { Map } from "artifact"; export default () => <Map nodes={${JSON.stringify(nodes)}} edges={${JSON.stringify(edges)}} direction="right" />;`);
  try {
    const s = await renderStatic(d);
    assert.ok("maps" in s && s.maps.length === 1);
    assert.match((await smallMaps(s.maps)).join(), /Map #1 \(16 nodes\) fits at about \d+%/);
    assert.deepEqual(await smallMaps([{ nodes: nodes.slice(0, 3), edges: edges.slice(0, 2), groups: [] }]), []);
    assert.ok((await check(d, { types: false })).warnings.some((w) => w.includes("Map #1")));
  } finally { cleanup(d); }
});

test("shot --present all captures every step, not just the first", async (t) => {
  const { shot, findChrome } = await import("../artifact/cli/shot.ts");
  try { await findChrome(); } catch { return t.skip("no Chromium available"); }
  const d = fixture(`import { Section, Step } from "artifact"; export default () => <Section title="A"><Step><p>one</p></Step><Step><p>two</p></Step></Section>;`);
  try {
    const paths = await shot(d, { out: join(d, "../shots"), themes: ["light"], present: "all" });
    const names = paths.map((p) => p.split("/").pop());
    assert.ok(names.some((n) => n!.endsWith("present-2.png")) && names.some((n) => n!.endsWith("present-2-s1.png")) && names.some((n) => n!.endsWith("present-2-s2.png")), names.join());
  } finally { cleanup(d); }
});

test("template-literal evidence paths are globs over evidence/", async () => {
  const d = fixture(`import { Img } from "artifact";
const ids = ["a", "b"];
export default () => <>{ids.map((id) => <Img key={id} src={\`evidence/demo-\${id}.png\`} />)}</>;`, (dir) => {
    writeFileSync(join(dir, "evidence/demo-a.png"), PNG); writeFileSync(join(dir, "evidence/demo-b.png"), PNG);
  });
  try {
    const r = await buildArtifact(d);
    assert.deepEqual(r.collected.missing, []);
    assert.deepEqual(Object.keys(r.collected.registry.evidence).sort(), ["evidence/demo-a.png", "evidence/demo-b.png"]);
    assert.ok(r.collected.unreferenced.includes("evidence/shot.png"), "files the glob does not match stay out");
    const bad = fixture(`export default () => <p>{\`evidence/nothing-\${1}.png\`}</p>;`);
    try { assert.equal((await buildArtifact(bad)).collected.missing.length, 1); } finally { cleanup(bad); }
  } finally { cleanup(d); }
});

test("timeline bucket, group and compact reduce swimlane rows", async () => {
  const d = fixture(`import { Timeline } from "artifact";
const ev = [
  { when: "2026-10-12T20:14:00Z", lane: "a", title: "A1" }, { when: "2026-10-12T20:19:00Z", lane: "b", title: "B1" },
  { when: "2026-10-12T20:41:00Z", lane: "a", title: "A2" }, { when: "2026-10-12T21:05:00Z", lane: "c", title: "C1" },
];
export default () => <><Timeline items={ev} /><Timeline items={ev} bucket="hour" /><Timeline items={ev} compact />
<Timeline items={[{ when: "x", group: "G", lane: "a", title: "g1" }, { when: "y", group: "G", lane: "b", title: "g2" }]} /></>;`);
  try {
    const s = await renderStatic(d);
    assert.ok("html" in s, JSON.stringify(s));
    const tl = s.html.split('data-c="timeline"').slice(1).map((x) => (x.match(/a-tl-whencell/g) ?? []).length);
    assert.deepEqual(tl, [4, 2, 2, 1], "plain 4 rows, hourly 2, compact merges a/b then a collides, group names one row");
  } finally { cleanup(d); }
});

test("present mode keeps the full width on wide pages, and captures hide the host bar", async (t) => {
  const { shot, capture, findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { return t.skip("no Chromium available"); }
  const { chromium } = await import("playwright-core");
  const d = fixture(`import { Section, Step } from "artifact"; export default () => <><Section title="One"><p>some text</p><Step><p>step</p></Step></Section><Section title="Two"><p>more</p></Section></>;`);
  writeFileSync(join(d, "artifact.json"), JSON.stringify({ title: "Wide", kind: "k", audience: "a", summary: "s", width: "wide" }));
  const out = join(d, "../w.html");
  try {
    writeFileSync(out, (await buildArtifact(d)).html);
    const b = await chromium.launch({ executablePath: exe });
    try {
      const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
      await p.goto("file://" + out);
      await p.waitForSelector(".a-content");
      await p.keyboard.press("p");
      await p.waitForSelector(".h-present-bar");
      await p.keyboard.press("ArrowRight");
      const w = await p.locator(".a-content").evaluate((e) => e.clientWidth);
      assert.ok(w > 900, `present content is ${w}px wide`);
      assert.match(await p.locator(".h-present-label").innerText(), /^2\/3/);
    } finally { await b.close(); }
    const paths = await shot(d, { out: join(d, "../shots"), themes: ["light"], present: "all" });
    assert.ok(paths.length >= 4, paths.join());
    const png = await capture(out, { out: join(d, "../cap.png"), selector: ".a-content" });
    assert.ok(readFileSync(png).length > 100);
  } finally { cleanup(d); }
});

import { layoutSegments, posOf, niceTimeTicks, stackLevels, tickLabel } from "../artifact/kit/timescale.ts";
import { groupCycle } from "../artifact/kit/map-layout.ts";

test("time axis maths: segments with their own scale, breaks, ticks, label levels", () => {
  const day = 86400e3, t0 = Date.parse("2026-09-01T00:00:00Z"), t1 = t0 + 42 * day, h0 = t1, h1 = t1 + 36 * 3600e3;
  const segs = layoutSegments([{ from: t0, to: t1 }, { from: h0 + 1, to: h1, weight: 2 }]);
  assert.ok(segs[0].x1 < segs[1].x0, "a gap between the segments is the break");
  assert.equal(Math.round(posOf(segs, t0)), 0);
  assert.equal(Math.round(posOf(segs, h1)), 100);
  assert.ok(posOf(segs, h0 + 18 * 3600e3) > posOf(segs, t1 - day), "the dense span is stretched");
  assert.ok(niceTimeTicks(t0, t1).length <= 6 && niceTimeTicks(h0, h1).length >= 3);
  assert.equal(tickLabel(Date.parse("2026-10-12T13:00:00Z"), 3600e3), "13:00");
  assert.equal(tickLabel(Date.parse("2026-10-12T13:00:00Z"), 30 * day), "12 Oct");
  assert.deepEqual(stackLevels([{ x: 0, w: 10 }, { x: 5, w: 10 }, { x: 12, w: 5 }, { x: 40, w: 5 }]), [0, 1, 0, 0]);
});

test("TimeAxis, usePresentSteps, Chart tone, Code notes by text render", async () => {
  const d = fixture(`import { TimeAxis, Chart, Code, Section } from "artifact";
export default () => <Section title="T"><TimeAxis segments={[{ from: "2026-09-01T00:00:00Z", to: "2026-10-12T00:00:00Z", label: "weeks" }, { from: "2026-10-12T00:00:01Z", to: "2026-10-13T12:00:00Z", weight: 2, label: "hours" }]}
  bands={[{ from: "2026-09-10T00:00:00Z", to: "2026-10-12T08:00:00Z", label: "gap exists", tone: "warn" }]}
  events={[{ at: "2026-09-01T00:00:00Z", label: "PR 1 merged", lane: "code" }, { at: "2026-10-12T10:00:00Z", label: "orders stuck", lane: "impact", tone: "critical" }, { at: "2026-10-12T10:00:00Z", to: "2026-10-13T00:00:00Z", label: "window", lane: "impact" }]} />
<Chart data={[{ label: "a", value: 3, tone: "critical" }, { label: "b", value: 5 }]} />
<Code code={"one\\ntwo needle\\nthree"} notes={{ needle: "found by text" }} /></Section>;`);
  try {
    const s = await renderStatic(d);
    assert.ok("html" in s, JSON.stringify(s));
    assert.match(s.html, /gap exists/); assert.match(s.html, /a-ta-break/); assert.match(s.html, /PR 1 merged/);
    assert.match(s.html, /fill="var\(--collie-color-critical-solid\)"/);
    assert.match(s.html, /a-note[^>]*>found by text/);
    assert.equal(groupCycle({ groups: [{ id: "g", label: "G" }, { id: "h", label: "H" }], nodes: [{ id: "a", label: "A", group: "g" }, { id: "b", label: "B", group: "h" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] }), true);
    assert.equal(groupCycle({ groups: [], nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] }), false);
  } finally { cleanup(d); }
});

test("findChrome scans a playwright cache for chromium-* / headless shell builds; --help prints usage", async () => {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  const base = mkdtempSync(join(tmpdir(), "art-pw-"));
  mkdirSync(join(base, "chromium_headless_shell-9001/chrome-headless-shell-linux64"), { recursive: true });
  writeFileSync(join(base, "chromium_headless_shell-9001/chrome-headless-shell-linux64/chrome-headless-shell"), "");
  mkdirSync(join(base, "chromium-9000/chrome-linux"), { recursive: true });
  writeFileSync(join(base, "chromium-9000/chrome-linux/chrome"), "");
  const keep = { b: process.env.PLAYWRIGHT_BROWSERS_PATH, c: process.env.ARTIFACT_CHROME };
  process.env.PLAYWRIGHT_BROWSERS_PATH = base; delete process.env.ARTIFACT_CHROME;
  const log = console.log; let usage = ""; console.log = (x: string) => { usage += x; };
  try {
    assert.match(await findChrome(), /chromium_headless_shell-9001\/.*chrome-headless-shell$/);
    assert.equal(await main(["shot", "--help"]), 0);
    assert.match(usage, /--split/);
  } finally {
    console.log = log;
    if (keep.b === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = keep.b;
    if (keep.c) process.env.ARTIFACT_CHROME = keep.c;
    rmSync(base, { recursive: true, force: true });
  }
});

test("usePresentSteps registers steps; shot --split cuts the page into viewport-sized PNGs", async (t) => {
  const { shot, findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { return t.skip("no Chromium available"); }
  const { chromium } = await import("playwright-core");
  const d = fixture(`import { Section, usePresentSteps } from "artifact";
function Walk() { const { step, markers } = usePresentSteps(3); return <div id="walk">{markers}<b id="n">step {step}</b></div>; }
export default () => <><Section title="One"><Walk /></Section><Section title="Two"><div style={{ height: 2400 }}>tall</div></Section></>;`);
  const out = join(d, "../s.html");
  try {
    writeFileSync(out, (await buildArtifact(d)).html);
    const b = await chromium.launch({ executablePath: exe });
    try {
      const p = await b.newPage();
      await p.goto("file://" + out);
      await p.waitForSelector("#n");
      assert.equal(await p.locator("#n").innerText(), "step 3", "outside present mode everything is shown");
      await p.keyboard.press("p"); await p.waitForSelector(".h-present-bar");
      await p.keyboard.press("ArrowRight");
      await p.waitForFunction(() => document.getElementById("n")?.textContent === "step 0");
      await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowRight");
      await p.waitForFunction(() => document.getElementById("n")?.textContent === "step 2");
    } finally { await b.close(); }
    const paths = await shot(d, { out: join(d, "../sp"), themes: ["light"], split: true, height: 800, chrome: false });
    assert.ok(paths.length >= 3 && paths.every((q) => /-p\d+\.png$/.test(q)), paths.join());
  } finally { cleanup(d); }
});

test("Download saves the same single HTML file; settings can turn it off; the bar has no Detail control", async (t) => {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { return t.skip("no Chromium available"); }
  const { chromium } = await import("playwright-core");
  const mk = (index: string, metaExtra: object = {}) => {
    const d = fixture(index);
    writeFileSync(join(d, "artifact.json"), JSON.stringify({ title: "My Great Page", kind: "k", audience: "a", summary: "s", ...metaExtra }));
    return d;
  };
  const first = mk(`import { Section } from "artifact"; export default () => <Section title="A"><p>top</p></Section>;`);
  const plain = mk(`export default () => <div><p>no sections</p></div>;`, { host: { download: false } });
  const b = await chromium.launch({ executablePath: exe });
  try {
    const out = join(first, "../d.html");
    const built = (await buildArtifact(first)).html;
    writeFileSync(out, built);
    const ctx = await b.newContext({ acceptDownloads: true });
    const p = await ctx.newPage();
    await p.goto("file://" + out);
    await p.waitForSelector(".a-content");
    const [dl] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: "Download" }).click()]);
    assert.equal(dl.suggestedFilename(), "my-great-page.html");
    assert.equal(readFileSync(await dl.path(), "utf8"), built, "byte-identical to the built file (rebuilt from its own style/script text under file://)");
    assert.equal(await p.locator(".h-seg").count(), 0, "no Detail control");
    await p.keyboard.press("2");
    assert.equal(await p.locator(".h-toast").count(), 0, "the 1-4 keys do nothing");
    const out2 = join(plain, "../p.html");
    writeFileSync(out2, (await buildArtifact(plain)).html);
    const p2 = await ctx.newPage();
    await p2.goto("file://" + out2);
    await p2.waitForSelector(".a-content");
    assert.equal(await p2.getByRole("button", { name: "Download" }).count(), 0);
    await p2.keyboard.press("?");
    assert.ok(await p2.locator(".h-pop").isVisible());
    assert.doesNotMatch(await p2.locator(".h-pop").innerText(), /Detail/);
  } finally { await b.close(); cleanup(first); cleanup(plain); }
});

test("time axis: midnight ticks show the date; break gets a label; usePresentSteps reports active", async () => {
  assert.equal(tickLabel(Date.parse("2026-10-13T00:00:00Z"), 3600e3 * 36), "13 Oct");
  assert.equal(tickLabel(Date.parse("2026-10-12T12:00:00Z"), 3600e3 * 36), "12:00");
  const d = fixture(`import { TimeAxis, usePresentSteps, Section } from "artifact";
function W() { const { active, step, markers } = usePresentSteps(2); return <i>{markers}{String(active)}-{step}</i>; }
export default () => <Section title="T"><TimeAxis title="Heading" lead="How to read" segments={[{ from: "2026-09-01T00:00:00Z", to: "2026-10-12T00:00:00Z", label: "weeks" }, { from: "2026-10-12T00:00:01Z", to: "2026-10-13T12:00:00Z", label: "36 hours" }]} events={[{ at: "2026-09-02T00:00:00Z", label: "a", lane: "code" }]} /><W /></Section>;`);
  try {
    const s = await renderStatic(d);
    assert.ok("html" in s, JSON.stringify(s));
    const h = s.html.replace(/<!-- -->/g, "");
    assert.match(h, /a-ta-breaklab[^>]*>zoomed in: 36 hours/);
    assert.match(h, /Heading/); assert.match(h, /a-ta-gutter-name[^>]*>code/);
    assert.match(h, /false-2/);
  } finally { cleanup(d); }
});

test("comments: one drawer with add / list / copy / clear, behind a store interface", async (t) => {
  const { localCommentStore } = await import("../artifact/host/comments.tsx");
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) };
  const st = localCommentStore("t");
  st.add({ id: "a", anchor: { id: "x", label: "x", excerpt: "e" }, body: "one", created: "now" });
  st.add({ id: "b", anchor: { id: "y", label: "y", excerpt: "e" }, body: "two", created: "now" });
  st.remove("a");
  assert.deepEqual(st.list().map((c) => c.id), ["b"]);
  st.clear();
  assert.deepEqual(st.list(), []);
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;

  const { findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { return t.skip("no Chromium available"); }
  const { chromium } = await import("playwright-core");
  const d = fixture(`import { Section, Stages } from "artifact"; export default () => <Section title="A"><p id="p1">Hello world</p><Stages stages={[{title:"v1"},{title:"v2"}]} rows={[{label:"r", cells:["a",{text:"b",tone:"warn"}]}]} /></Section>;`);
  const out = join(d, "../c.html");
  try {
    writeFileSync(out, (await buildArtifact(d)).html);
    const b = await chromium.launch({ executablePath: exe });
    try {
      const ctx = await b.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
      const p = await ctx.newPage();
      await p.goto("file://" + out);
      await p.waitForSelector(".a-content");
      assert.equal(await p.getByRole("button", { name: /^(Comment|Notes|Copy feedback)$/ }).count(), 0, "no separate comment buttons in the bar");
      await p.keyboard.press("c");
      assert.ok(await p.locator(".h-panel").isVisible(), "c opens the drawer");
      await p.locator(".a-content p").first().click();
      await p.locator(".h-composer textarea").fill("Looks off");
      await p.keyboard.press("Meta+Enter");
      assert.equal(await p.locator(".h-bar").getByRole("button", { name: /Feedback.*1 note/ }).count(), 1);
      await p.getByRole("button", { name: "Copy comments" }).click();
      assert.match(await p.evaluate(() => navigator.clipboard.readText()), /Looks off/);
      await p.getByRole("button", { name: "Clear all" }).click();
      await p.getByRole("button", { name: "Click again to clear" }).click();
      assert.equal(await p.locator(".h-note").count(), 0);
      assert.ok(await p.locator('[data-c="stages"]').isVisible());
    } finally { await b.close(); }
  } finally { cleanup(d); }
});

import { matchesAnswer, decisionsMarkdown, type Answer } from "../artifact/kit/feedback.ts";

test("decision answers: matching and the Markdown an agent can apply", () => {
  const a: Answer = { choice: "a", label: "Yes, ship now", rec: true, note: "after lunch", at: "t" };
  assert.ok(matchesAnswer(a, "a") && matchesAnswer(a, "yes, ship now") && matchesAnswer(a, ["x", "a"]));
  assert.ok(!matchesAnswer(a, "b") && !matchesAnswer(undefined, "a") && !matchesAnswer(a, undefined));
  const md = decisionsMarkdown("Page", [
    { id: "d1", question: "Ship?", recommended: "Yes, ship now", answer: a },
    { id: "d2", question: "Which\n demo?", recommended: "X", answer: { choice: "b", label: "Y", at: "t" } },
    { id: "d3", question: "Own?", answer: { choice: "other", label: "mine", custom: "my own plan", at: "t" } },
    { id: "d4", question: "Unsure?", answer: { choice: "unsure", label: "not sure / discuss", note: "call me", at: "t" } },
    { id: "d5", question: "Later?" },
  ]);
  assert.match(md, /- \*\*d1\*\* — Ship\?\n {2}- answer: Yes, ship now \[a\] \(the recommended option\)\n {2}- note: after lunch/);
  assert.match(md, /answer: Y \[b\] \(differs from the recommendation: X\)/);
  assert.match(md, /answer: own answer: my own plan/);
  assert.match(md, /answer: not sure \/ discuss\n {2}- note: call me/);
  assert.match(md, /d5\*\* — Later\?\n {2}- answer: \(not decided\)/);
  assert.match(md, /Which demo\?/);
});

test("Decision and When render statically (no host): plain option list, unanswered branch shows", async () => {
  const d = fixture(`import { Decision, When, Section } from "artifact";
export default () => <Section title="D"><Decision id="d1" question="Pick?" options={["One", "Two"]} recommend={1} />
<When decision="d1" is="a"><p>BRANCH-A</p></When><When decision="d1" unanswered><p>UNANSWERED</p></When></Section>;`);
  try {
    const s = await renderStatic(d);
    assert.ok("html" in s, JSON.stringify(s));
    assert.match(s.html, /id="d1"/); assert.match(s.html, /UNANSWERED/); assert.doesNotMatch(s.html, /BRANCH-A/);
    assert.doesNotMatch(s.html, /role="radio"/);
  } finally { cleanup(d); }
});

test("answerable decisions: branch, progress, summary, copy, present summary slide", async (t) => {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { return t.skip("no Chromium available"); }
  const { chromium } = await import("playwright-core");
  const d = fixture(`import { Decision, When, Section } from "artifact";
export default () => <><Section title="One"><Decision id="d1" question="Ship now?" recommend={0} options={["Yes", "No"]} />
<When decision="d1" is="a"><Decision id="d2" question="Which first?" options={["Alpha", "Beta"]} recommend="Beta" /><When decision="d2" is="beta"><p>BETA-BRANCH</p></When></When>
<When decision="d1" is="b"><p>NO-BRANCH</p></When></Section>
<Section title="Two"><p>other</p></Section></>;`);
  const out = join(d, "../dec.html");
  try {
    writeFileSync(out, (await buildArtifact(d)).html);
    const b = await chromium.launch({ executablePath: exe });
    try {
      const ctx = await b.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
      const p = await ctx.newPage();
      await p.goto("file://" + out);
      await p.waitForSelector(".a-decision");
      assert.equal(await p.locator('[data-c="decision"]').count(), 1, "the follow-up is hidden until d1 is answered");
      assert.match(await p.locator(".h-bar").innerText(), /Feedback/);
      await p.locator("#d1 button[role=radio]").first().click();            // d1 = Yes (recommended)
      assert.equal(await p.locator('[data-c="decision"]').count(), 2, "answering d1 reveals d2");
      assert.match(await p.locator(".h-bar").innerText(), /1\/2 decided/);
      await p.locator('[data-did="d2"] button[role=radio]').nth(1).click();   // d2 = Beta (recommended)
      assert.ok(await p.getByText("BETA-BRANCH").isVisible(), "two levels deep");
      await p.locator('[data-did="d2"]').getByRole("button", { name: "Add note" }).click();
      await p.locator('[data-did="d2"] textarea').fill("sounds right");
      await p.locator('[data-did="d2"] textarea').blur();
      await p.locator(".h-bar").getByRole("button", { name: /Feedback/ }).click();
      assert.ok(await p.locator(".h-panel .h-decisions li").first().isVisible());
      await p.getByRole("button", { name: "Copy decisions" }).click();
      let md = await p.evaluate(() => navigator.clipboard.readText());
      assert.match(md, /\*\*d1\*\* — Ship now\?\n {2}- answer: Yes \[a\] \(the recommended option\)/);
      assert.match(md, /\*\*d2\*\* — Which first\?\n {2}- answer: Beta \[b\] \(the recommended option\)\n {2}- note: sounds right/);
      // a different answer to d1 closes the branch: d2 leaves the page and the summary
      await p.locator('[data-did="d1"]').getByRole("button", { name: "Write your own…" }).click();
      await p.locator('[data-did="d1"] input').fill("Yes but Friday");
      await p.keyboard.press("Enter");
      assert.equal(await p.locator('[data-c="decision"]').count(), 1);
      await p.getByRole("button", { name: "Copy decisions" }).click();
      md = await p.evaluate(() => navigator.clipboard.readText());
      assert.match(md, /\*\*d1\*\* — Ship now\?\n {2}- answer: own answer: Yes but Friday/);
      assert.doesNotMatch(md, /d2/);
      await p.reload(); await p.waitForSelector(".a-decision");
      assert.equal(await p.locator('[data-c="decision"]').count(), 1, "answers persist (localStorage)");
      await p.locator("#d1 button[role=radio]").first().click();
      assert.equal(await p.locator('[data-c="decision"]').count(), 2, "back to Yes: d2 returns with its earlier answer");
      // present: answer while presenting, then the generated Summary slide
      await p.keyboard.press("p"); await p.waitForSelector(".h-present-bar");
      await p.keyboard.press("ArrowRight");
      await p.locator('[data-did="d2"] button[role=radio]').first().focus();
      await p.keyboard.press("Enter");                                          // answers, does not step
      assert.match(await p.locator(".h-present-label").innerText(), /^2\//);
      await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowRight");
      assert.match(await p.locator(".h-present-label").innerText(), /Summary$/);
      assert.ok(await p.locator(".h-summary-slide").isVisible());
      assert.match(await p.locator(".h-summary-slide").innerText(), /Alpha/);
    } finally { await b.close(); }
  } finally { cleanup(d); }
});

test("folding: heading click folds a section, Fold all / Unfold all in the ? panel, More discloses, collapsed blocks are stubs, present shows everything", async (t) => {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { return t.skip("no Chromium available"); }
  const { chromium } = await import("playwright-core");
  const d = fixture(`import { Section, More, Code, Table } from "artifact";
export default () => <><Section title="One" lead="lead one"><p id="p1">BODY-ONE</p><Section title="Inner"><p>INNER-BODY</p></Section>
<More label="Method"><p>HIDDEN-DETAIL</p></More>
<Code code="a b" collapsed /><Table columns={["name"]} rows={[{ name: "ROW" }]} collapsed /></Section><Section title="Two"><p>BODY-TWO</p></Section></>;`);
  const out = join(d, "../fold.html");
  try {
    const built = await buildArtifact(d);
    assert.deepEqual(built.errors.map((e) => e.text), []);
    writeFileSync(out, built.html);
    const b = await chromium.launch({ executablePath: exe });
    try {
      const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
      await p.goto("file://" + out);
      await p.waitForSelector(".a-content");
      assert.ok(await p.locator("#p1").isVisible());
      assert.equal(await p.locator(".h-seg").count(), 0);
      await p.locator('h2.a-h:has-text("One")').first().click();
      assert.ok(!(await p.locator("#p1").isVisible()), "heading click folds the section");
      assert.ok(await p.getByText("lead one").isVisible(), "the lead stays");
      await p.locator('h2.a-h:has-text("One")').first().click();
      assert.ok(await p.locator("#p1").isVisible(), "and unfolds it");
      // More: closed until clicked
      assert.ok(!(await p.getByText("HIDDEN-DETAIL").isVisible()));
      await p.getByText("Method").click();
      assert.ok(await p.getByText("HIDDEN-DETAIL").isVisible());
      // collapsed heavy blocks: stubs, open on click; the long table stays open without `collapsed`
      assert.match(await p.locator(".a-heavy-stub").first().innerText(), /^▸ Code:/);
      assert.ok(!(await p.getByText("ROW", { exact: true }).isVisible()));
      await p.locator(".a-heavy-stub").nth(1).click();
      assert.ok(await p.getByText("ROW", { exact: true }).isVisible());
      // Fold all / Unfold all live only in the ? panel
      assert.equal(await p.locator(".h-bar").getByRole("button", { name: /fold all/i }).count(), 0);
      await p.keyboard.press("?");
      await p.getByRole("button", { name: "Fold all", exact: true }).click();
      assert.ok(!(await p.locator("#p1").isVisible()) && !(await p.getByText("BODY-TWO").isVisible()));
      await p.getByRole("button", { name: "Unfold all" }).click();
      assert.ok(await p.getByText("BODY-TWO").isVisible());
      // present mode shows everything even when folded
      await p.getByRole("button", { name: "Fold all", exact: true }).click();
      await p.keyboard.press("Escape");
      await p.keyboard.press("p"); await p.waitForSelector(".h-present-bar");
      await p.keyboard.press("ArrowRight");
      assert.ok(await p.locator("#p1").isVisible(), "present ignores folds");
    } finally { await b.close(); }
  } finally { cleanup(d); }
});

test("Walkthrough: scenarios, steps, state rail, keyboard; present stays in sync; plain buttons let the slide step; no negative svg width", async (t) => {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { return t.skip("no Chromium available"); }
  const { chromium } = await import("playwright-core");
  const d = fixture(`import { Section, Walkthrough, More, Map } from "artifact";
export default () => <><Section title="Walk"><Walkthrough states={["A", "B", "C"]} scenarios={[
  { label: "Bug", steps: [{ title: "First", state: "A", body: "BODY-1" }, { title: "Second", state: "B", body: "BODY-2", tone: "bad" }, { title: "Third", state: "C", body: "BODY-3" }] },
  { label: "Fix", steps: [{ title: "Only", state: "A", body: "FIX-BODY" }, { title: "Done", state: "C", body: "FIX-DONE" }] }]}
  visual={(s) => <b className="vis">VISUAL {s.state}</b>} /></Section>
<Section title="Hidden map"><More label="map"><Map nodes={[{ id: "a", label: "A" }, { id: "b", label: "B" }]} edges={[{ from: "a", to: "b" }]} /></More></Section></>;`);
  const out = join(d, "../walk.html");
  try {
    writeFileSync(out, (await buildArtifact(d)).html);
    const b = await chromium.launch({ executablePath: exe });
    try {
      const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
      const errs: string[] = [];
      p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
      p.on("pageerror", (e) => errs.push(e.message));
      await p.goto("file://" + out);
      await p.waitForSelector(".a-walk");
      await p.waitForTimeout(600);
      assert.deepEqual(errs.filter((e) => /negative|width/i.test(e)), [], "no negative svg width from a hidden map");
      assert.match(await p.locator(".a-walk-body h4").innerText(), /^1\. First/);
      assert.ok(await p.getByText("VISUAL A").isVisible());
      await p.locator(".a-walk").focus();
      await p.keyboard.press("ArrowDown");
      assert.match(await p.locator(".a-walk-body h4").innerText(), /^2\. Second/);
      assert.equal(await p.locator(".a-walk-pill.now").innerText(), "B");
      assert.ok(await p.locator(".a-walk-pill.now.bad").count() === 1);
      await p.keyboard.press("ArrowRight");
      assert.ok(await p.getByText("FIX-DONE").isVisible(), "← → switch scenarios, keeping the step position");
      await p.getByRole("tab", { name: "Bug" }).click();
      // present: each step is a present step; clicking a step keeps the counter in sync
      await p.keyboard.press("Escape");
      await p.keyboard.press("p"); await p.waitForSelector(".h-present-bar");
      await p.keyboard.press("ArrowRight");               // slide 2 = the walk
      await p.locator(".a-walk-steps li").nth(2).locator("button").click();
      assert.equal(await p.locator(".h-present-bar").getAttribute("data-step"), "2", "a click moved the slide's step counter");
      await p.keyboard.press("ArrowLeft");
      assert.equal(await p.locator(".h-present-bar").getAttribute("data-step"), "1");
      await p.waitForFunction(() => /^2\. Second/.test(document.querySelector(".a-walk-body h4")?.textContent ?? ""));
      // a plain button inside a slide does not swallow Space: the click blurs it, so Space steps
      await p.locator(".a-walk-tabs button").nth(1).click();
      await p.keyboard.press("Space");
      assert.equal(await p.locator(".h-present-bar").getAttribute("data-step"), "2");
    } finally { await b.close(); }
  } finally { cleanup(d); }
});
