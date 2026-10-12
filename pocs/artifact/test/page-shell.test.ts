import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtifact } from "../artifact/cli/build.ts";
import { check } from "../artifact/cli/check.ts";
import { TEMPLATE_AUDIENCE, TEMPLATE_SUMMARY } from "../artifact/cli/scaffold.ts";
import { acceptRecommended, type Answer } from "../artifact/kit/feedback.ts";

const INDEX = `import { Section, Decision, DecisionIndex, When, Wide, Grid, Card } from "artifact";
export default () => <>
  <DecisionIndex />
  <Section title="One"><p id="p1">Hello world</p><Wide><Grid cols={3}><Card title="a">x</Card><Card title="b">y</Card><Card title="c">z</Card></Grid></Wide></Section>
  <Section title="Two">
    <Decision id="d1" question="Ship it?" options={["Yes", "No"]} recommend={0} />
    <Decision id="d2" question="Which way?" options={["Left", "Right"]} recommend="Right" />
    <Decision id="d3" question="No recommendation" options={["A", "B"]} />
    <When decision="d1" is="b"><Decision id="d4" question="Hidden unless d1 = No" options={["X", "Y"]} recommend={0} /></When>
  </Section>
</>;`;

function make(over: Record<string, unknown> = {}, index = INDEX, data?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "art-page-"));
  const d = join(root, "x.artifact");
  mkdirSync(join(d, "evidence"), { recursive: true });
  if (data) { mkdirSync(join(d, "data")); for (const [k, v] of Object.entries(data)) writeFileSync(join(d, "data", k + ".json"), JSON.stringify(v)); }
  writeFileSync(join(d, "artifact.json"), JSON.stringify({ title: "Page fixture", kind: "status", audience: "tests", summary: "The headline sentence.", created: "2026-10-13", sources: ["https://example.com/a", "notes.md"], shell: "page", ...over }));
  writeFileSync(join(d, "index.tsx"), index);
  return { root, d };
}

async function browser(t: { skip: (m: string) => void }) {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { t.skip("no Chromium available"); return null; }
  const { chromium } = await import("playwright-core");
  return chromium.launch({ executablePath: exe });
}

test("page shell: title, summary, meta line and a centred column; no doc chrome", async (t) => {
  const b = await browser(t); if (!b) return;
  const { root, d } = make();
  try {
    const out = join(root, "x.html");
    writeFileSync(out, (await buildArtifact(d)).html);
    const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await p.goto("file://" + out);
    await p.waitForSelector(".a-content");
    assert.equal(await p.locator(".h-phead h1").textContent(), "Page fixture");
    assert.equal(await p.locator(".h-psummary").textContent(), "The headline sentence.");
    assert.match((await p.locator(".h-pmeta").textContent())!, /status.*2026.*2 sources/);
    for (const sel of [".h-bar", ".h-outline", ".h-head"]) assert.equal(await p.locator(sel).count(), 0, `${sel} is doc chrome`);
    assert.equal(await p.locator(".h-corner").count(), 1, "the faint corner menu stays");
    const col = (await p.locator(".h-main").boundingBox())!;
    assert.ok(col.width <= 770 && col.width >= 600, `text column is ~720-760 px (${col.width})`);
    assert.ok(Math.abs(col.x + col.width / 2 - 640) < 2, "centred");
    const wide = (await p.locator(".a-wide").boundingBox())!;
    assert.ok(wide.width > col.width + 100, `<Wide> breaks out of the column (${wide.width} vs ${col.width})`);
    await p.click(".h-psrc > button");
    assert.equal(await p.locator(".h-psrc-pop").count(), 1, "the sources popover opens");
    await p.keyboard.press("Escape");
    assert.equal(await p.locator(".h-psrc-pop").count(), 0);
  } finally { await b.close(); rmSync(root, { recursive: true, force: true }); }
});

test("page shell: the on-this-page list shows only on wide screens with more than 5 sections", async (t) => {
  const b = await browser(t); if (!b) return;
  const many = `import { Section } from "artifact"; export default () => <>{Array.from({ length: 7 }, (_, i) => <Section key={i} title={"Part " + (i + 1)}><p>text</p></Section>)}</>;`;
  const { root, d } = make({}, many);
  try {
    const out = join(root, "x.html");
    writeFileSync(out, (await buildArtifact(d)).html);
    for (const [w, shown] of [[1700, true], [1100, false]] as const) {
      const p = await (await b.newContext({ viewport: { width: w, height: 800 } })).newPage();
      await p.goto("file://" + out);
      await p.waitForSelector(".a-content");
      assert.equal(await p.locator(".h-ptoc").isVisible(), shown, `${w}px`);
    }
  } finally { await b.close(); rmSync(root, { recursive: true, force: true }); }
});

test("accept all: answers only unanswered visible decisions that have a recommendation, editable after", async (t) => {
  const b = await browser(t); if (!b) return;
  const { root, d } = make();
  try {
    const out = join(root, "x.html");
    writeFileSync(out, (await buildArtifact(d)).html);
    const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await p.goto("file://" + out);
    await p.waitForSelector(".a-decision");
    assert.equal(await p.locator('[data-did="d4"]').count(), 0, "d4 is not visible yet");
    await p.locator('[data-did="d1"] button[role=radio]').nth(1).click(); // d1 = No, against the recommendation: d4 appears
    await p.locator('[data-did="d4"]').waitFor();
    await p.click(".a-dindex-accept");
    const state = async () => Object.fromEntries(await p.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-did]")].map((e) => [e.dataset.did!, [e.classList.contains("answered"), e.querySelector(".picked")?.textContent ?? ""]])));
    const s = await state();
    assert.match(String(s.d1[1]), /No/, "d1 keeps the reader's own answer");
    assert.match(String(s.d2[1]), /Right/, "recommend given by label");
    assert.equal(s.d3[0], false, "no recommendation: left open");
    assert.match(String(s.d4[1]), /X/, "the newly visible decision is answered with its recommendation");
    assert.equal(await p.locator(".a-dindex-accept").count(), 0, "nothing left to accept");
    await p.locator('[data-did="d2"] button[role=radio]').nth(0).click();
    assert.match(String((await state()).d2[1]), /Left/, "accepted answers stay editable");
    // the Feedback drawer has the same action
    await p.evaluate(() => localStorage.clear()); await p.reload();
    await p.waitForSelector(".a-decision");
    await p.keyboard.press("c");
    await p.waitForSelector(".h-panel");
    await p.click(".h-tabs [role=tab]:first-child");
    await p.click(".h-panel >> text=Accept all recommendations");
    await p.waitForFunction(() => /Decisions 2\/3/.test(document.querySelector(".h-tabs [role=tab]")?.textContent ?? ""), null, { timeout: 3000 }); // d1 and d2 answered; d3 has no recommendation
  } finally { await b.close(); rmSync(root, { recursive: true, force: true }); }
});

test("acceptRecommended skips answered, unrecommended and keyless decisions", () => {
  const got: string[] = [];
  const n = acceptRecommended(
    [{ id: "a", recommended: "Yes", recommendedKey: "a" }, { id: "b", recommended: "No", recommendedKey: "b" }, { id: "c" }],
    { b: { choice: "a", label: "Yes", at: "" } as Answer },
    (id) => got.push(id));
  assert.deepEqual([n, got], [1, ["a"]]);
});

test("check flags scaffold leftovers and unused data files", async () => {
  const { root, d } = make({ summary: TEMPLATE_SUMMARY, audience: TEMPLATE_AUDIENCE, sources: [] }, `import { Section } from "artifact"; export default () => <Section title="x"><p>hi</p></Section>;`, { items: [1], used: [2] });
  try {
    const r = await check(d, { types: false });
    assert.ok(r.errors.some((e) => /summary is still the template/.test(e)), r.errors.join("\n"));
    assert.ok(r.errors.some((e) => /audience is still the template/.test(e)));
    assert.ok(r.warnings.some((w) => /no sources/.test(w)));
    assert.ok(r.warnings.some((w) => /unused data: data\/items\.json/.test(w)));
  } finally { rmSync(root, { recursive: true, force: true }); }
  const ok = make({}, `import { Section, useData } from "artifact"; export default () => <Section title="x"><p>{String(useData("used"))}</p></Section>;`, { used: [2] });
  try {
    const r = await check(ok.d, { types: false });
    assert.deepEqual([r.errors, r.warnings.filter((w) => /unused data|no sources|template/.test(w))], [[], []]);
  } finally { rmSync(ok.root, { recursive: true, force: true }); }
});

test("clear answers / clear comments ask for an inline confirm first", async (t) => {
  const b = await browser(t); if (!b) return;
  const { root, d } = make();
  try {
    const out = join(root, "x.html");
    writeFileSync(out, (await buildArtifact(d)).html);
    const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    p.on("dialog", (dlg) => { throw new Error("window dialog used: " + dlg.message()); });
    await p.goto("file://" + out);
    await p.waitForSelector(".a-decision");
    await p.click(".a-dindex-accept");
    await p.keyboard.press("c");
    await p.click(".h-tabs [role=tab]:first-child");
    await p.click(".h-panel >> text=Clear answers");
    assert.match(await p.locator(".h-confirm").textContent() ?? "", /Clear 2 answers\?/);
    await p.click(".h-confirm >> text=Cancel");
    assert.equal(await p.locator(".h-confirm").count(), 0);
    assert.match(await p.locator(".h-tabs [role=tab]").first().textContent() ?? "", /Decisions 2\/3/, "cancel keeps the answers");
    await p.click(".h-panel >> text=Clear answers");
    await p.click(".h-confirm button >> text=Clear");
    await p.waitForFunction(() => /Decisions 0\/3/.test(document.querySelector(".h-tabs [role=tab]")?.textContent ?? ""), null, { timeout: 3000 });
  } finally { await b.close(); rmSync(root, { recursive: true, force: true }); }
});

test("check advises when every Decision sits in the last Section", async () => {
  const batched = `import { Section, Decision } from "artifact"; export default () => <><Section title="A"><p>a</p></Section><Section title="B"><p>b</p></Section><Section title="C"><Decision id="d" question="Q?" options={["x"]} /></Section></>;`;
  const spread = batched.replace('<Section title="A"><p>a</p></Section>', '<Section title="A"><Decision id="e" question="R?" options={["x"]} /></Section>');
  for (const [src, warned] of [[batched, true], [spread, false]] as const) {
    const { root, d } = make({}, src);
    try {
      const r = await check(d, { types: false });
      assert.equal(r.warnings.some((w) => /in the last Section/.test(w)), warned);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
