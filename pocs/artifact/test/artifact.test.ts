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
    const paths = await shot(d, { out, themes: ["dark"], present: "0,2" });
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

test("artifact.json depth and header are accepted", async () => {
  const d = fixture(`export default () => <p>x</p>;`);
  writeFileSync(join(d, "artifact.json"), JSON.stringify({ title: "T", kind: "k", audience: "a", summary: "s", depth: 2, header: "full" }));
  try {
    const r = await buildArtifact(d);
    assert.equal(r.collected.registry.meta.depth, 2);
    assert.equal(r.collected.registry.meta.header, "full");
  } finally { cleanup(d); }
});
