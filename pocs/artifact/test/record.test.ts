import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { buildArtifact, renderStatic } from "../artifact/cli/build.ts";
import { replayMeta } from "../artifact/cli/evidence.ts";
import { parseSteps, record } from "../artifact/cli/record.ts";

const PAGE = `<!doctype html><title>t</title><h1>Todo</h1>
<input id="t" placeholder="New item"> <input id="pw" type="password" placeholder="Password"> <button id="add">Add</button><ul id="l"></ul>
<script>document.getElementById('add').onclick=()=>{const li=document.createElement('li');li.textContent=document.getElementById('t').value;document.getElementById('l').append(li)}</script>`;

const tmp = () => mkdtempSync(join(tmpdir(), "rec-test-"));
async function chrome(t: { skip(m: string): void }) {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  try { return await findChrome(); } catch { t.skip("no Chromium available"); return undefined; }
}

test("parseSteps reads the mini script and capture-style JSON", () => {
  assert.deepEqual(parseSteps("say:Open the board; click:text=New card; type:#title=Fix login; key:Enter; wait:500; wait:.done; drag:.a->.b"), [
    { say: "Open the board" }, { click: "text=New card" }, { type: ["#title", "Fix login"] }, { key: "Enter" }, { wait: 500 }, { wait: ".done" }, { drag: [".a", ".b"] },
  ]);
  assert.deepEqual(parseSteps("say:Names can hold ; semicolons; scroll:300\n# a comment\nclick:[data-k=x]"), [{ say: "Names can hold ; semicolons" }, { scroll: 300 }, { click: "[data-k=x]" }]);
  assert.deepEqual(parseSteps("type:input[name=q]=a=b"), [{ type: ["input[name=q]", "a=b"] }]);
  assert.deepEqual(parseSteps('[{"say":"hi"},{"click":"#a"},{"type":["#b","c"]}]'), [{ say: "hi" }, { click: "#a" }, { type: ["#b", "c"] }]);
  assert.throws(() => parseSteps("tap:#a"), /unknown step/);
  assert.throws(() => parseSteps("type:#a"), /<selector>=<text>/);
});

test("record: --steps on a local page gives a valid .replay with chapters, console and masked passwords (browser)", async (t) => {
  if (!(await chrome(t))) return;
  const d = tmp();
  try {
    writeFileSync(join(d, "p.html"), PAGE);
    const out = join(d, "evidence/x.replay");
    const r = await record(join(d, "p.html"), { out, fast: true, steps: "say:Add an item; type:#t=Buy milk; type:#pw=hunter2-secret; click:Add; say:Done" });
    assert.deepEqual(r.steps, ["Add an item", "Done"]);
    assert.ok(r.bytes < 60_000 && r.events > 5);
    const files = unzipSync(readFileSync(out));
    assert.deepEqual(Object.keys(files).sort(), ["console.json", "manifest.json", "network.json", "rrweb.json", "steps.json", "storage.json"], "no trace.zip");
    const m = JSON.parse(strFromU8(files["manifest.json"]));
    assert.equal(m.format, "replay/0");
    assert.deepEqual(m.viewport, { width: 1280, height: 800 });
    const ev = JSON.parse(strFromU8(files["rrweb.json"])) as { type: number; timestamp: number }[];
    assert.ok(ev.some((e) => e.type === 2), "a full snapshot");
    assert.ok(ev.every((e, i) => i === 0 || e.timestamp >= ev[i - 1].timestamp));
    const text = strFromU8(files["rrweb.json"]);
    assert.match(text, /Buy milk/);
    assert.doesNotMatch(text, /hunter2-secret/, "password input values are masked");
    assert.equal(JSON.parse(strFromU8(files["steps.json"])).length, 2);
    // build-time metadata the page reads before decoding anything
    const meta = replayMeta(readFileSync(out));
    assert.equal(meta.screen, true);
    assert.deepEqual(meta.steps.map((s) => s.text), ["Add an item", "Done"]);
    assert.ok(meta.steps[0].rel >= 0 && meta.duration > meta.steps[1].rel);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("record: --script drives the page and a failing step names itself; --max keeps what was recorded (browser)", async (t) => {
  if (!(await chrome(t))) return;
  const d = tmp();
  try {
    writeFileSync(join(d, "p.html"), PAGE);
    writeFileSync(join(d, "j.mjs"), `export default async ({ page, say, click, type, pause }) => { await say("From a script"); await type("#t", "scripted"); await click("#add"); await pause(50); };`);
    const r = await record(join(d, "p.html"), { out: join(d, "s.replay"), fast: true, script: join(d, "j.mjs") });
    assert.deepEqual(r.steps, ["From a script"]);
    assert.match(strFromU8(unzipSync(readFileSync(join(d, "s.replay")))["rrweb.json"]), /scripted/);
    await assert.rejects(record(join(d, "p.html"), { out: join(d, "bad.replay"), fast: true, steps: "say:ok; click:#nope-missing" }), /step 2 \(click:"#nope-missing"\) failed/);
    const cut = await record(join(d, "p.html"), { out: join(d, "cut.replay"), steps: "say:slow one; say:slower one", max: 1 });
    assert.equal(cut.truncated, true);
    assert.match(cut.warnings.join(), /--max/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

function replayFixture(extra: string) {
  const d = tmp() + "/r.artifact";
  mkdirSync(join(d, "evidence"), { recursive: true });
  writeFileSync(join(d, "artifact.json"), JSON.stringify({ title: "R", kind: "k", audience: "a", summary: "s", shell: "bare" }));
  writeFileSync(join(d, "index.tsx"), `import { Replay } from "artifact";
export default () => <div><Replay src="evidence/a.replay" caption="Top" />${extra}<Replay src="evidence/a.replay" loop /></div>;`);
  return d;
}

test("Replay: chapters and a stage render server-side; the player waits until the reader scrolls to it (browser)", async (t) => {
  const exe = await chrome(t); if (!exe) return;
  const tmpd = tmp();
  try {
    writeFileSync(join(tmpd, "p.html"), PAGE);
    const rec = join(tmpd, "a.replay");
    await record(join(tmpd, "p.html"), { out: rec, fast: true, steps: "say:First; type:#t=one; click:Add; say:Second; click:Add; say:Third" });
    const d = replayFixture(`<div style={{ height: 3000 }} />`);
    writeFileSync(join(d, "evidence/a.replay"), readFileSync(rec));
    const s = await renderStatic(d);
    assert.ok("html" in s, JSON.stringify(s));
    assert.match(s.html, /data-c="replay"/);
    assert.match(s.html, /aria-label="Chapters"/);
    assert.match(s.html, /First/); assert.match(s.html, /Third/);
    assert.match(s.html, /data-steps-group/, "one present step: the slide shows the first frame, the next step plays");
    const out = join(d, "../a.html");
    writeFileSync(out, (await buildArtifact(d)).html);
    const { chromium } = await import("playwright-core");
    const b = await chromium.launch({ executablePath: exe });
    try {
      const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
      const errs: string[] = [];
      p.on("pageerror", (e) => errs.push(e.message));
      await p.goto("file://" + out);
      await p.waitForSelector(".a-replay-play");
      assert.equal(await p.locator(".a-replay-steps li").count(), 3, "chapters from the steps");
      assert.equal(await p.locator("iframe").count(), 1, "the first recording is decoded, the one 3000px down is not");
      assert.ok((await p.locator(".a-replay-ph").count()) >= 1, "the far one holds its place with a placeholder, no blank box");
      await p.locator(".a-replay-steps button").nth(1).click();
      await p.waitForFunction(() => document.querySelector(".a-replay-steps button.on")?.textContent?.includes("Second") || document.querySelector(".a-replay-steps button.on")?.textContent?.includes("Third"));
      await p.evaluate(() => scrollTo(0, document.body.scrollHeight));
      await p.waitForFunction(() => document.querySelectorAll("iframe").length === 2);
      assert.equal(await p.locator(".rr-controller").count(), 1, "the looping clip has no controller");
      assert.deepEqual(errs, []);
    } finally { await b.close(); }
  } finally { rmSync(tmpd, { recursive: true, force: true }); }
});
