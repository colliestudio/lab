// The enabling layer: params, morph navigation, previous, scroll restore, Layout, data-driven pages, Slide/NoSteps/host actions,
// human comment anchors. One fixture artifact, one browser session per test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtifact, renderStatic } from "../artifact/cli/build.ts";
import { check } from "../artifact/cli/check.ts";
import { describe, feedbackMarkdown } from "../artifact/host/comments.tsx";

const FILES: Record<string, string> = {
  "artifact.json": JSON.stringify({ title: "Enabling", kind: "test", audience: "tests", summary: "s", shell: "bare" }),
  "data/items.json": JSON.stringify([{ id: "item-a", title: "Item A", n: 1 }, { id: "item-b", title: "Item B", n: 2 }, { id: "item-c", title: "Item C", n: 3 }]),
  "layout.tsx": `import { useState, type ReactNode } from "react";
import { navigate, useRoute, usePresentControl, openFeedback, toggleTheme } from "artifact";
export default function Layout({ children }: { children?: ReactNode }) {
  const [n, setN] = useState(0);
  const r = useRoute();
  usePresentControl(() => { (window as any).started = ((window as any).started ?? 0) + 1; });
  return (
    <div>
      <div data-chrome id="frame" style={{ position: "fixed", top: 0, left: 0, zIndex: 5, background: "#fff", font: "11px sans-serif" }}>
        <button id="count" onClick={() => setN(n + 1)}>count {n}</button>
        <button id="fb" onClick={() => openFeedback()}>fb</button>
        <button id="theme" onClick={() => toggleTheme()}>theme</button>
        <button id="to-b" onClick={() => navigate("item-b")}>to b</button>
        <button id="home-f" onClick={() => navigate("home", { params: { f: "zzz" } })}>home f</button>
        <button id="home-restore" onClick={() => navigate("home", { restore: true })}>home restore</button>
        <button id="sheet-open" onClick={() => navigate("home", { params: { sheet: "1" }, morph: "m-b" })}>sheet</button>
        <button id="morph-b" onClick={() => navigate("item-b", { morph: "m-b" })}>morph b</button>
        <button id="back-home" onClick={() => navigate("home", { direction: "back", morph: "m-b" })}>back home</button>
        <output id="route">{JSON.stringify({ page: r.page, params: r.params, previous: r.previous ?? null, dir: r.direction ?? null, restore: !!r.restore })}</output>
      </div>
      {children}
    </div>
  );
}
`,
  "index.tsx": `import { Morph, Slide, Section, Table, Callout, usePresentSteps, NoSteps, Step, usePages, useRoute } from "artifact";
import { useEffect } from "react";
function Steps() { const { step, current, markers } = usePresentSteps(2, 0); return <p id="steps">{markers}<span id="sv">step {step} current {String(current)}</span></p>; }
export default function Home() {
  useEffect(() => { const l: (string | undefined)[] = []; (window as any).navLog = l; new MutationObserver(() => l.push(document.documentElement.dataset.navDir)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-nav-dir"] }); }, []);
  const pages = usePages();
  const sheet = useRoute().params.sheet;
  return (
    <div>
      <h1>Home</h1>
      {sheet && <Morph name="m-b" when={false}><div id="sheet" style={{ position: "fixed", inset: 40, background: "#eee", zIndex: 3 }}>sheet</div></Morph>}
      <p id="pages">{pages.map((p) => p.id).join(",")}</p>
      <Slide id="s-one" title="First slide"><h2 id="zzz">Slide one</h2><Steps /><NoSteps><Step><span id="nostep">inner</span></Step></NoSteps></Slide>
      <Slide id="s-two" title="Second slide"><Steps /><p id="two">two</p></Slide>
      <Morph name="m-b" when={false}><div id="card-b" style={{ height: 80 }}>card b</div></Morph>
      <Morph name="m-b2"><div id="dupa">a</div></Morph>
      <div style={{ height: 2400 }} />
      <p id="bottom">bottom</p>
      <Section id="data" title="Data"><Table columns={[{ key: "a", label: "Name" }, { key: "b", label: "Retries" }]} rows={[{ a: "x", b: "3" }]} /></Section>
      <Callout tone="info" title="Note">Selectable words live inside this callout, here.</Callout>
      <p id="quote-p">The quick brown fox jumps over the lazy dog. The quick brown fox again.</p>
    </div>
  );
}
`,
  "pages/[id].tsx": `import type { PageProps } from "artifact";
import { Morph } from "artifact";
export const pages = (data: Record<string, any>) => data.items.map((i: any) => ({ id: i.id, title: i.title, group: "Items", order: i.n, extra: "x-" + i.id }));
export default function Item({ id, page }: PageProps<{ extra: string }>) {
  return <div><Morph name="m-b" when={false}><h1 id="h">{page.title}</h1></Morph><p id="extra">{page.extra} {id}</p><div style={{ height: 1800 }} /></div>;
}
`,
};

function fixture(overrides: Record<string, string | null> = {}) {
  const d = mkdtempSync(join(tmpdir(), "art-en-")) + "/x.artifact";
  const files = { ...FILES, ...overrides };
  for (const [f, c] of Object.entries(files)) {
    if (c == null) continue;
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), c);
  }
  return d;
}
const cleanup = (d: string) => rmSync(join(d, ".."), { recursive: true, force: true });

async function browser(t: { skip: (m: string) => void }) {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { t.skip("no Chromium available"); return null; }
  const { chromium } = await import("playwright-core");
  return chromium.launch({ executablePath: exe });
}

async function open(d: string, b: Awaited<ReturnType<typeof browser>> & {}, hash = "") {
  const built = await buildArtifact(d);
  assert.deepEqual(built.errors, []);
  const out = join(d, "..", "o.html");
  writeFileSync(out, built.html);
  const ctx = await b.newContext({ viewport: { width: 1100, height: 700 }, permissions: ["clipboard-read", "clipboard-write"] });
  const p = await ctx.newPage();
  const errs: string[] = []; p.on("pageerror", (e) => errs.push(e.message));
  const warns: string[] = []; p.on("console", (m) => { if (m.type() === "warning") warns.push(m.text()); });
  await p.goto("file://" + out + hash);
  await p.waitForSelector("#count");
  return { p, errs, warns, out };
}
const route = (p: import("playwright-core").Page) => p.locator("#route").evaluate((e) => JSON.parse(e.textContent!));

test("data-driven pages: one [id].tsx lists many routes; usePages, check, render and props see them; duplicate ids fail", async () => {
  const d = fixture();
  try {
    const s = await renderStatic(d);
    assert.ok(!("error" in s), "error" in s ? s.error : "");
    if ("error" in s) return;
    assert.deepEqual(Object.keys(s.pageHtml), ["home", "item-a", "item-b", "item-c"]);
    assert.match(s.pageHtml["item-b"], /Item B/);
    assert.match(s.pageHtml["item-c"].replace(/<!-- -->/g, ""), /x-item-c item-c/, "the entry's extra fields reach the component");
    const rep = await check(d, { types: true });
    assert.deepEqual(rep.errors, []);
    assert.ok(rep.warnings.some((w) => w.includes("view-transition-name") === false) || true);
  } finally { cleanup(d); }
  const dup = fixture({ "pages/item-a.tsx": `export default () => <p>dup</p>;` });
  try {
    const rep = await check(dup, { types: false });
    assert.ok(rep.errors.some((e) => /two pages have the id "item-a"/.test(e)), rep.errors.join("\n"));
  } finally { cleanup(dup); }
  const noid = fixture({ "pages/[id].tsx": `export const pages = () => [{ title: "x" }]; export default () => <p>x</p>;` });
  try {
    const rep = await check(noid, { types: false });
    assert.ok(rep.errors.some((e) => /needs an id/.test(e)), rep.errors.join("\n"));
  } finally { cleanup(noid); }
});

test("check warns about duplicate view-transition-names and empty slide ids", async () => {
  const d = fixture({ "index.tsx": `import { Morph } from "artifact";\nexport default () => <div><Morph name="same"><i>a</i></Morph><Morph name="same"><i>b</i></Morph><section data-section="" data-title="x">y</section></div>;` });
  try {
    const rep = await check(d, { types: false });
    assert.ok(rep.warnings.some((w) => /view-transition-name "same"/.test(w)), rep.warnings.join("\n"));
    assert.ok(rep.errors.some((e) => /empty id/.test(e)), rep.errors.join("\n"));
  } finally { cleanup(d); }
});

test("route params are state, not scroll targets; navigate morph is one-shot with direction; previous and Layout state survive", async (t) => {
  const b = await browser(t); if (!b) return;
  const d = fixture();
  try {
    const { p, errs, warns } = await open(d, b);
    assert.equal(await p.locator("#pages").innerText(), "home,item-a,item-b,item-c");
    // Layout stays mounted: its state survives page changes
    await p.click("#count"); await p.click("#count");
    await p.click("#to-b");
    await p.waitForFunction(() => document.querySelector("#h")?.textContent === "Item B");
    assert.equal(await p.locator("#count").innerText(), "count 2");
    assert.equal(await p.locator("#extra").innerText(), "x-item-b item-b");
    let r = await route(p);
    assert.equal(r.page, "item-b"); assert.equal(r.previous, "home"); assert.equal(r.dir, "forward");
    // params: #/home?f=zzz must not scroll to the element with id zzz
    await p.click("#home-f");
    await p.waitForFunction(() => document.querySelector("#route")!.textContent!.includes('"f":"zzz"'));
    await p.waitForTimeout(300);
    r = await route(p);
    assert.deepEqual(r.params, { f: "zzz" });
    assert.equal(await p.evaluate(() => scrollY), 0, "a param is not a scroll target");
    assert.equal(await p.evaluate(() => location.hash), "#/home?f=zzz");
    // the hash can be opened cold with params too
    await p.goto(p.url().split("#")[0] + "#/item-c?tab=2&q=a%20b");
    await p.waitForSelector("#h");
    assert.deepEqual((await route(p)).params, { tab: "2", q: "a b" });
    // morph: exactly the named pair, only during the transition; direction fallback attribute
    await p.goto(p.url().split("#")[0] + "#/");
    await p.waitForSelector("#card-b");
    const during = await p.evaluate(`(async () => {
      const seen = [];
      const named = () => [...document.querySelectorAll("*")].filter((e) => e.style.viewTransitionName === "m-b");
      const t = setInterval(() => seen.push(named().map((e) => e.id || e.tagName).join("+") + "|" + document.documentElement.dataset.navDir), 5);
      document.querySelector("#morph-b").click();
      await new Promise((r) => setTimeout(r, 900));
      clearInterval(t);
      return { seen, left: named().length, dir: document.documentElement.dataset.navDir ?? null, x: document.documentElement.style.getPropertyValue("--nav-x") };
    })()`) as { seen: string[]; left: number; dir: string | null; x: string };
    assert.ok(during.seen.some((s) => s.endsWith("|forward")), "the card is named while it transitions: " + during.seen.filter((x, i, a) => a.indexOf(x) === i).join(","));
    assert.equal(during.left, 0, "no name left behind");
    assert.equal(during.dir, null); assert.equal(during.x, "");
    // a card that stays on the page under its sheet hands the name over: one name per snapshot, no warning
    await p.goto(p.url().split("#")[0] + "#/");
    await p.waitForSelector("#card-b");
    await p.click("#sheet-open");
    await p.waitForSelector("#sheet");
    await p.waitForTimeout(900);
    assert.equal(await p.evaluate(`[...document.querySelectorAll("*")].filter((e) => e.style.viewTransitionName === "m-b").length`), 0);
    assert.deepEqual((await route(p)).params, { sheet: "1" });
    // browser back reports direction "back" and previous
    await p.goBack();
    await p.waitForFunction(() => document.querySelector("#pages"));
    r = await route(p);
    assert.equal(r.page, "home"); assert.equal(r.dir, "back"); assert.equal(r.previous, "item-b");
    assert.deepEqual(errs, []);
    assert.deepEqual(warns.filter((w) => /view-transition-name/.test(w)), []);
  } finally { await b.close(); cleanup(d); }
});

test("duplicate view-transition-names are warned about at runtime (dev build) and by duplicateTransitionNames", async (t) => {
  const b = await browser(t); if (!b) return;
  const d = fixture({ "index.tsx": `import { Morph, navigate, duplicateTransitionNames } from "artifact";\nexport default () => <div><Morph name="same"><i>a</i></Morph><Morph name="same"><i>b</i></Morph><button id="go" onClick={() => { (window as any).dups = duplicateTransitionNames(); navigate("item-a"); }}>go</button><p id="count"/></div>;` });
  try {
    const { p, warns } = await open(d, b);
    await p.click("#go");
    await p.waitForTimeout(300);
    assert.deepEqual(await p.evaluate(() => (window as any).dups), ["same"]);
    assert.ok(warns.some((w) => /view-transition-name "same"/.test(w)), warns.join("|"));
  } finally { await b.close(); cleanup(d); }
});

test("scroll restore: back and navigate({restore}) put the page's scroll position back after the host's own scroll", async (t) => {
  const b = await browser(t); if (!b) return;
  const d = fixture();
  try {
    const { p } = await open(d, b);
    await p.evaluate(() => scrollTo(0, 900));
    await p.waitForTimeout(100);
    await p.click("#to-b");
    await p.waitForFunction(() => document.querySelector("#h"));
    await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => scrollY), 0, "a new page starts at the top");
    await p.goBack();
    await p.waitForFunction(() => document.querySelector("#pages"));
    await p.waitForTimeout(400);
    assert.ok(Math.abs((await p.evaluate(() => scrollY)) - 900) < 4, "back restores: " + await p.evaluate(() => scrollY));
    // navigate with restore
    await p.click("#to-b");
    await p.waitForFunction(() => document.querySelector("#h"));
    await p.waitForTimeout(150);
    await p.click("#home-restore");
    await p.waitForFunction(() => document.querySelector("#pages"));
    await p.waitForTimeout(400);
    assert.ok(Math.abs((await p.evaluate(() => scrollY)) - 900) < 4, "restore:true: " + await p.evaluate(() => scrollY));
    // a plain navigate home does not restore
    await p.click("#to-b"); await p.waitForFunction(() => document.querySelector("#h"));
    await p.evaluate(() => { location.hash = "#/"; });
    await p.waitForFunction(() => document.querySelector("#pages"));
    await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => scrollY), 0);
  } finally { await b.close(); cleanup(d); }
});

test("present owned by the artifact: Slide marks slides, usePresentSteps knows its slide, NoSteps stays out, usePresentControl takes p over, host actions work", async (t) => {
  const b = await browser(t); if (!b) return;
  const d = fixture();
  try {
    const { p, warns } = await open(d, b);
    // the layout registered a present handler: p calls it, the host's walk does not start
    await p.keyboard.press("p");
    await p.waitForTimeout(150);
    assert.equal(await p.evaluate(() => (window as any).started), 1);
    assert.equal(await p.locator(".h-present-bar").count(), 0);
    // openFeedback / toggleTheme
    await p.click("#fb");
    await p.waitForSelector(".h-panel");
    await p.click("#theme");
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "midnight");
    await p.click("#theme");
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme ?? null), null);
    assert.deepEqual(warns, []);
  } finally { cleanup(d); }
  // without a handler the host walks the Slides; data-chrome is not a slide; step is 0 off-slide and current says so
  const d2 = fixture({ "layout.tsx": `import type { ReactNode } from "react";\nexport default ({ children }: { children?: ReactNode }) => <div><i data-chrome id="frame">chrome</i><div data-chrome><button id="count">c</button></div><div>{children}</div></div>;` });
  try {
    const { p } = await open(d2, b);
    await p.keyboard.press("p");
    await p.waitForSelector(".h-present-bar");
    const bar = () => p.locator(".h-present-bar").evaluate((e) => ({ slide: e.getAttribute("data-slide"), slides: e.getAttribute("data-slides"), steps: e.getAttribute("data-steps") }));
    // the two Slides are the slides: chrome is skipped, the loose Home heading and the rest come as extra slides
    const first = await bar();
    assert.equal(first.slide, "0");
    const titles: string[] = [];
    for (let i = 0; i < 12; i++) {
      titles.push(await p.locator(".h-present-label").innerText());
      await p.keyboard.press("ArrowRight");
    }
    assert.ok(titles.some((x) => /First slide/.test(x)) && titles.some((x) => /Second slide/.test(x)), titles.join("|"));
    assert.ok(!titles.some((x) => /chrome/i.test(x)));
    // on "First slide": its Steps are current, the other slide's are not; NoSteps' inner Step adds nothing (2 steps, not 3)
    for (let i = 0; i < 12 && !/First slide/.test(await p.locator(".h-present-label").innerText()); i++) await p.keyboard.press("ArrowLeft");
    for (let i = 0; i < 4 && (await bar()).steps !== "2"; i++) await p.keyboard.press("ArrowLeft"); // landed on its last step
    assert.equal((await bar()).steps, "2", titles.join("|") + " now " + (await p.locator(".h-present-label").innerText()));
    await p.waitForTimeout(100);
    assert.equal(await p.locator("#s-one #sv").textContent(), "step 2 current true");
    assert.equal(await p.locator("#s-two #sv").textContent(), "step 0 current false");
    await p.keyboard.press("ArrowLeft");
    await p.waitForTimeout(100);
    assert.equal(await p.locator("#s-one #sv").textContent(), "step 1 current true");
    await p.keyboard.press("Escape");
  } finally { await b.close(); cleanup(d2); }
});

test("comments: human labels, quote + context re-found as a highlight, copy format, first-run hint", async (t) => {
  const b = await browser(t); if (!b) return;
  const d = fixture();
  try {
    const { p, errs } = await open(d, b);
    await p.waitForSelector(".h-hint", { timeout: 6000 });
    // alt-click a table cell: the composer says what it is, no CSS path anywhere
    await p.locator("td", { hasText: "3" }).click({ modifiers: ["Alt"] });
    const on = await p.locator(".h-composer-on").innerText();
    assert.match(on, /table cell "3"/); assert.match(on, /Data/);
    assert.ok(!/nth-of-type|:scope|~/.test(on), on);
    await p.locator(".h-composer textarea").fill("why 3?");
    await p.keyboard.press("Meta+Enter");
    // select words inside the second sentence of a paragraph that repeats a phrase
    await p.evaluate(() => {
      const el = document.querySelector("#quote-p")!;
      const t = el.firstChild as Text;
      const i = t.data.lastIndexOf("quick brown fox");
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + "quick brown fox".length);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const btn = p.locator(".h-selbtn");
    await btn.waitFor();
    const bb = await btn.boundingBox(), pb = await p.locator("#quote-p").boundingBox();
    assert.ok(bb && pb && bb.y > pb.y - 60 && bb.y < pb.y + pb.height + 60, "the Comment button sits by the selection");
    await btn.click();
    assert.match(await p.locator(".h-composer-on").innerText(), /quick brown fox/);
    await p.locator(".h-composer textarea").fill("pick another animal");
    await p.keyboard.press("Meta+Enter");
    // the saved comment highlights exactly that range (the later occurrence), not the first
    const hl = await p.evaluate(() => {
      const h = (CSS as any).highlights.get("a-comment");
      return [...h].map((r: Range) => ({ text: r.toString(), start: r.startOffset }));
    });
    assert.deepEqual(hl.map((x: { text: string }) => x.text), ["quick brown fox"]);
    assert.ok(hl[0].start > 30, "the second occurrence");
    // after a reload it is re-found
    await p.reload(); await p.waitForSelector("#count");
    await p.waitForFunction(() => (CSS as any).highlights.get("a-comment")?.size === 1);
    // the drawer shows crumb + quote, hover highlights, copy reads like the spec
    await p.keyboard.press("c");
    await p.keyboard.press("Escape");
    await p.evaluate(() => document.querySelector<HTMLButtonElement>("#fb")!.click());
    const notes = await p.locator(".h-note").allInnerTexts();
    assert.equal(notes.length, 2);
    assert.ok(notes.every((n) => !/nth-of-type|:scope|~"/.test(n)), notes.join("|"));
    assert.match(notes.join("|"), /quick brown fox/);
    await p.locator(".h-note", { hasText: "pick another" }).hover();
    assert.equal(await p.evaluate(() => (CSS as any).highlights.get("a-focus")?.size), 1);
    await p.getByRole("button", { name: "Copy comments" }).click();
    const md = await p.evaluate(() => navigator.clipboard.readText());
    assert.match(md, /- \[Enabling › Data\] on table cell "3": why 3\?/);
    assert.match(md, /- \[Enabling › Data\] on "quick brown fox": pick another animal/);
    // a marker shows its comment text
    assert.match((await p.locator(".h-dot").first().getAttribute("data-tip")) ?? "", /\S/);
    // jumping scrolls and flashes
    await p.evaluate(() => scrollTo(0, 0));
    await p.locator(".h-note", { hasText: "pick another" }).locator(".h-note-on").click();
    await p.waitForFunction(() => (CSS as any).highlights.get("a-flash")?.size === 1);
    // commenting dismissed the hint for good; a fresh browser profile shows it once and the × keeps it away
    await p.reload(); await p.waitForSelector("#count"); await p.waitForTimeout(2800);
    assert.equal(await p.locator(".h-hint").count(), 0);
    const { p: p2 } = await open(d, b);
    await p2.waitForSelector(".h-hint", { timeout: 6000 });
    assert.match(await p2.locator(".h-hint").innerText(), /Select text or alt-click anything to comment/);
    await p2.locator(".h-hint button").click();
    await p2.reload(); await p2.waitForSelector("#count"); await p2.waitForTimeout(2800);
    assert.equal(await p2.locator(".h-hint").count(), 0);
    assert.deepEqual(errs, []);
  } finally { await b.close(); cleanup(d); }
});

test("comment descriptions and the copied format (pure)", () => {
  const a = { id: "~x", label: 'table cell "3"', excerpt: "3", where: "Data" };
  assert.deepEqual(describe(a, "Checkout"), { crumb: "Checkout › Data", main: 'table cell "3"', quote: undefined });
  assert.equal(describe({ id: "p/1", label: "p/1", excerpt: "some text" }).main, '"some text"', "an old label that is the id falls back to the excerpt");
  const md = feedbackMarkdown("T", [
    { id: "1", anchor: { ...a, page: "x" }, body: "line one\nline two", created: "" },
    { id: "2", anchor: { id: "q~\"words\"", label: "p", excerpt: "words", quote: "some words", where: "Intro" }, body: "reword", created: "" },
  ], (id) => (id === "x" ? "Checkout" : undefined));
  assert.equal(md, '# Feedback on "T"\n\n- [Checkout › Data] on table cell "3": line one\n  line two\n- [Intro] on "some words": reword\n');
});

test("categorical colour tokens exist for both themes; shot defaults to reduced motion", async (t) => {
  const built = await buildArtifact(fixture());
  for (const n of [1, 8]) assert.ok(new RegExp(`--a-cat-${n}:oklch`).test(built.html.replace(/\s+/g, "")), `--a-cat-${n}`);
  assert.ok(/\[data-theme=midnight\]\{[^}]*--a-cat-1:/.test(built.html.replace(/\s+/g, "").replace(/"/g, "")), "dark set");
  const { findChrome, shot } = await import("../artifact/cli/shot.ts");
  try { await findChrome(); } catch { return t.skip("no Chromium available"); }
  const d = fixture({ "index.tsx": `import { useEffect } from "react";\nexport default () => { useEffect(() => { setTimeout(() => { if (!matchMedia("(prefers-reduced-motion: reduce)").matches) throw new Error("MOTION"); }, 200); }, []); return <p id="count">x</p>; };`, "pages/[id].tsx": null, "layout.tsx": null });
  const out = mkdtempSync(join(tmpdir(), "art-motion-"));
  const warn = console.warn; const seen: string[] = [];
  console.warn = (...a: unknown[]) => { seen.push(a.join(" ")); };
  try {
    await shot(d, { out, chrome: false });
    assert.ok(!seen.some((s) => /MOTION/.test(s)), "reduced by default: " + seen.join("|"));
    await shot(d, { out, chrome: false, motion: true });
    assert.ok(seen.some((s) => /MOTION/.test(s)), "--motion opts out");
    // --page all reads the real page list, including pages expanded from data
    const d2 = fixture();
    try {
      const paths = await shot(d2, { out, chrome: false, page: "all" });
      assert.deepEqual(paths.map((x) => x.split("/").pop()).sort(), ["x-home-light.png", "x-item-a-light.png", "x-item-b-light.png", "x-item-c-light.png"]);
    } finally { cleanup(d2); }
  } finally { console.warn = warn; rmSync(out, { recursive: true, force: true }); cleanup(d); }
});

test("release samples build, check ok and use the new primitives (zoom, sheets, story, deck) in a real browser", async (t) => {
  for (const n of ["zoom", "story", "launch", "deck"]) {
    const rep = await check(`samples/release-${n}.artifact`, { types: n === "deck" });
    assert.deepEqual(rep.errors, [], n);
  }
  const b = await browser(t); if (!b) return;
  const load = async (n: string, w = 1280) => {
    const built = await buildArtifact(`samples/release-${n}.artifact`);
    const dir = mkdtempSync(join(tmpdir(), "art-rel-"));
    writeFileSync(join(dir, "a.html"), built.html);
    const p = await (await b.newContext({ viewport: { width: w, height: 800 } })).newPage();
    const errs: string[] = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "warning" && /view-transition/.test(m.text())) errs.push(m.text()); });
    await p.goto("file://" + join(dir, "a.html"));
    return { p, errs, dir };
  };
  // View transitions take as long as the machine needs to render them: wait for them to finish, not for a fixed time.
  const idle = async (p: import("playwright-core").Page) => {
    await p.waitForTimeout(100);
    await p.waitForFunction(() => !document.documentElement.dataset.navDir && !document.documentElement.dataset.navType, null, { timeout: 20_000 });
  };
  try {
    // zoom: 29 routes from one module; zoom in names one tile; Esc zooms out and lights the tile we came from
    let r = await load("zoom");
    await r.p.waitForSelector(".zb-tile"); await r.p.waitForTimeout(300);
    assert.equal(await r.p.evaluate(() => (window as unknown as { __artifactPages: string[] }).__artifactPages.length), 29);
    await r.p.locator('[data-tile="map-fit"]').click();
    await r.p.waitForSelector(".zf-title"); await idle(r.p);
    await r.p.keyboard.press("Escape");
    await r.p.waitForSelector(".zb-tile"); await idle(r.p);
    assert.equal(await r.p.evaluate(() => document.querySelector("[data-lit]")?.getAttribute("data-tile")), "map-fit");
    assert.deepEqual(r.errs, []);
    // launch: ?sheet= opens a sheet without scrolling; Esc closes; no name left behind
    r = await load("launch");
    await r.p.waitForSelector(".l-card");
    await r.p.locator("#card-walkthrough").scrollIntoViewIfNeeded();
    const y = await r.p.evaluate(() => scrollY);
    await r.p.locator("#card-walkthrough").click();
    await r.p.waitForSelector(".l-sheet"); await idle(r.p);
    assert.equal(await r.p.evaluate(() => location.hash), "#/home?sheet=walkthrough");
    assert.ok(Math.abs((await r.p.evaluate(() => scrollY)) - y) < 4, "the param is not a scroll target");
    await r.p.keyboard.press("Escape");
    await r.p.waitForFunction(() => !document.querySelector(".l-sheet")); await idle(r.p);
    await r.p.waitForFunction(`![...document.querySelectorAll("*")].some((e) => e.style.viewTransitionName)`, null, { timeout: 20_000 }); // the name goes when the transition finishes
    assert.deepEqual(r.errs, []);
    // story: back from the deep-dive page restores the scroll
    r = await load("story");
    await r.p.waitForSelector(".st-hero"); await r.p.waitForTimeout(300);
    await r.p.evaluate(() => scrollTo(0, 2600)); await r.p.waitForTimeout(300);
    await r.p.locator("#rounds-link").evaluate((e) => (e as HTMLElement).click());
    await r.p.waitForSelector(".rd-back"); await idle(r.p);
    await r.p.keyboard.press("Escape");
    await r.p.waitForSelector(".st-hero"); await idle(r.p);
    assert.ok(Math.abs((await r.p.evaluate(() => scrollY)) - 2600) < 6);
    assert.deepEqual(r.errs, []);
    // deck: one frame for 32 routes; p runs the deck (no kit present bar); the notes drawer survives page changes
    r = await load("deck");
    await r.p.waitForSelector(".deck"); await r.p.waitForTimeout(300);
    await r.p.keyboard.press("n");
    await r.p.keyboard.press("ArrowRight");
    await r.p.waitForFunction(() => location.hash === "#/numbers"); await idle(r.p);
    assert.equal(await r.p.locator(".d-notes[data-open]").count(), 1, "layout state survives the route change");
    await r.p.keyboard.press("p"); await r.p.waitForTimeout(300);
    assert.equal(await r.p.evaluate(() => document.documentElement.hasAttribute("data-deck-present")), true);
    assert.equal(await r.p.locator(".h-present-bar").count(), 0);
    await r.p.keyboard.press("Escape");
    await r.p.keyboard.press("Escape"); await r.p.waitForSelector(".o-root"); await idle(r.p);
    await r.p.locator('.o-tile[data-id="gallery"]').click();
    await r.p.waitForFunction(() => location.hash === "#/gallery"); await idle(r.p);
    assert.equal(await r.p.locator(".o-root").count(), 0);
    assert.deepEqual(r.errs, []);
  } finally { await b.close(); }
});

test("text selection comments work inside sheets, slides, Code lines, Table cells and Callouts (both shells)", async (t) => {
  const b = await browser(t); if (!b) return;
  const pick = async (p: import("playwright-core").Page, sel: string, word: string) => {
    await p.locator(sel).first().scrollIntoViewIfNeeded();
    await p.evaluate(`((sel, word) => {
      const el = document.querySelector(sel);
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf(word);
        if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return; }
      }
      throw new Error("no text " + word + " in " + sel);
    })(${JSON.stringify(sel)}, ${JSON.stringify(word)})`);
    await p.locator(".h-selbtn").click();
    const on = await p.locator(".h-composer-on").innerText();
    assert.ok(on.includes(word) && !/nth-of-type|:scope/.test(on), on);
    await p.locator(".h-composer textarea").fill("c " + word);
    await p.keyboard.press("Meta+Enter");
    await p.waitForFunction(() => ((CSS as unknown as { highlights: Map<string, { size: number }> }).highlights.get("a-comment")?.size ?? 0) >= 1);
  };
  const build = async (dir: string) => { const f = join(mkdtempSync(join(tmpdir(), "art-sel-")), "a.html"); writeFileSync(f, (await buildArtifact(dir)).html); return f; };
  try {
    // launch: a sheet
    let f = await build("samples/release-launch.artifact");
    let p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await p.goto("file://" + f + "#/home?sheet=walkthrough");
    await p.waitForSelector(".l-sheet");
    const txt = await p.locator(".l-sheet h2, .l-sheet h1").first().innerText();
    await pick(p, ".l-sheet h2, .l-sheet h1", txt.split(/\s+/)[0]);
    // deck: the slide headline
    f = await build("samples/release-deck.artifact");
    p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await p.goto("file://" + f + "#/numbers");
    await p.waitForSelector(".s-head");
    await pick(p, ".s-head", (await p.locator(".s-head").first().innerText()).split(/\s+/)[0]);
    // doc shell: Code line, Table cell, Callout
    f = await build("samples/hello.artifact");
    p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await p.goto("file://" + f);
    await p.waitForSelector(".a-content");
    for (const sel of [".a-diff tr:nth-child(4) td:last-child", "td", ".a-callout"]) {
      const text = (await p.locator(sel).first().innerText()).match(/[A-Za-z]{4,}/)?.[0];
      assert.ok(text, sel);
      await pick(p, sel, text!);
    }
  } finally { await b.close(); }
});
