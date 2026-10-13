import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtifact } from "../artifact/cli/build.ts";
import { check } from "../artifact/cli/check.ts";
import { main } from "../artifact/cli/main.ts";

const INDEX = `import { useAnswer, copyText, highlight } from "artifact";
function Custom() {
  const [a, set] = useAnswer("keep-1");
  return <div>
    <button id="drop" onClick={() => set({ choice: "drop", label: "Drop it", question: "Keep item 1?" })}>drop</button>
    <span id="val">{a?.label ?? "none"}</span>
    <button id="cp" onClick={() => copyText("hello copy")}>copy</button>
    <pre id="hl" dangerouslySetInnerHTML={{ __html: highlight("const x = 1;", "ts") }} />
  </div>;
}
export default () => <><Custom /><table id="t"><tbody><tr><td>x</td></tr></tbody></table><blockquote id="bq">q</blockquote><pre id="raw">r</pre></>;`;

function make(title: string, shell: string, root = mkdtempSync(join(tmpdir(), "art-r18-"))) {
  const d = join(root, title.replace(/\W/g, "") + ".artifact");
  mkdirSync(join(d, "evidence"), { recursive: true });
  writeFileSync(join(d, "artifact.json"), JSON.stringify({ title, kind: "test", audience: "tests", summary: "s", created: "2026-10-14", shell }));
  writeFileSync(join(d, "index.tsx"), INDEX);
  return { root, d };
}

async function launch(t: { skip: (m: string) => void }) {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { t.skip("no Chromium available"); return null; }
  const { chromium } = await import("playwright-core");
  // insecure.test resolves to the loopback server but is not a secure context (localhost would be)
  return chromium.launch({ executablePath: exe, args: ["--host-resolver-rules=MAP insecure.test 127.0.0.1"] });
}

async function serve(files: Record<string, string>): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const f = files[(req.url ?? "/").slice(1).split("?")[0]];
    if (f == null) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", "text/html"); res.end(f);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, origin: `http://insecure.test:${port}` };
}

test("corner menu: Comment first with its key and a hint; every item shows its key; c-style pick mode", async (t) => {
  const b = await launch(t); if (!b) return;
  const { root, d } = make("Menu fixture", "bare");
  try {
    const out = join(root, "m.html"); writeFileSync(out, (await buildArtifact(d)).html);
    const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await p.goto("file://" + out); await p.waitForSelector(".a-content");
    await p.click(".h-corner-btn");
    const items = await p.locator(".h-corner-menu [role=menuitem]").evaluateAll((els) => els.map((e) => ({ text: e.textContent!.trim(), key: e.querySelector("kbd")?.textContent ?? null })));
    assert.match(items[0].text, /^Comment/); assert.equal(items[0].key, "c");
    assert.match((await p.locator(".h-corner-hint").textContent())!, /Click anything, or select text/);
    for (const i of items) assert.ok(i.key, `${i.text} shows a shortcut key`);
    await p.click(".h-corner-menu [role=menuitem]");
    assert.equal(await p.evaluate(() => "commenting" in document.documentElement.dataset), true, "pick mode on");
    await p.waitForSelector(".h-panel");
    // the keys in the menu work
    await p.keyboard.press("Escape");
    await p.keyboard.press("t");
    assert.ok(await p.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("artifact-theme:Menu fixture"))), "theme key is per artifact");
  } finally { await b.close(); rmSync(root, { recursive: true, force: true }); }
});

test("copy over plain http: no navigator.clipboard, textarea fallback, then a select-all dialog", async (t) => {
  const b = await launch(t); if (!b) return;
  const { root, d } = make("Copy fixture", "bare");
  const { server, origin } = await serve({ "c.html": (await buildArtifact(d)).html });
  try {
    const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await p.goto(origin + "/c.html"); await p.waitForSelector(".a-content");
    assert.equal(await p.evaluate(() => window.isSecureContext), false);
    assert.equal(await p.evaluate(() => navigator.clipboard === undefined), true);
    const spy = () => p.evaluate(() => {
      const w = window as unknown as { __copied: string[]; __fail: boolean };
      w.__copied = []; w.__fail = false;
      const orig = document.execCommand.bind(document);
      document.execCommand = (c: string, ...r: [boolean?, string?]) => {
        if (c !== "copy") return orig(c, ...r);
        w.__copied.push((document.activeElement as HTMLTextAreaElement).value); return !w.__fail;
      };
    });
    await spy();
    // an artifact's own button
    await p.click("#cp");
    assert.deepEqual(await p.evaluate(() => (window as unknown as { __copied: string[] }).__copied), ["hello copy"]);
    assert.equal(await p.locator("[data-copy-dialog]").count(), 0);
    // the host's drawer copy buttons
    await p.evaluate(() => localStorage.setItem("artifact-comments:Copy fixture|2026-10-14", JSON.stringify([{ id: "c1", anchor: { id: "t", label: "Table", excerpt: "x", where: "" }, body: "a note", created: "2026-10-14T00:00:00Z" }])));
    await p.reload(); await p.waitForSelector(".a-content"); await spy();
    await p.keyboard.press("f"); await p.waitForSelector(".h-panel");
    await p.click("text=/^Copy (all|comments)/");
    const got = await p.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
    assert.ok(got.length === 1 && /a note/.test(got[0]), `host copy used the fallback (${JSON.stringify(got)})`);
    // execCommand refused: select-all dialog
    await p.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = true; });
    await p.click("#cp");
    await p.waitForSelector("[data-copy-dialog] textarea");
    assert.equal(await p.evaluate(() => { const a = document.activeElement as HTMLTextAreaElement; return a.value.slice(a.selectionStart, a.selectionEnd); }), "hello copy");
    await p.keyboard.press("Escape");
    assert.equal(await p.locator("[data-copy-dialog]").count(), 0);
  } finally { server.close(); await b.close(); rmSync(root, { recursive: true, force: true }); }
});

test("useAnswer: custom control stores into the kit's answers (drawer, persisted, per artifact); highlight exported", async (t) => {
  const b = await launch(t); if (!b) return;
  const a1 = make("Answer one", "bare"), a2 = make("Answer two", "bare");
  const { server, origin } = await serve({ "1.html": (await buildArtifact(a1.d)).html, "2.html": (await buildArtifact(a2.d)).html });
  try {
    const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await p.goto(origin + "/1.html"); await p.waitForSelector("#drop");
    assert.match((await p.locator("#hl .hljs-keyword").first().textContent())!, /const/, "highlight() returns coloured html");
    assert.equal(await p.textContent("#val"), "none");
    await p.click("#drop");
    assert.equal(await p.textContent("#val"), "Drop it");
    await p.keyboard.press("f"); await p.waitForSelector(".h-panel");
    assert.match((await p.locator(".h-decisions").first().textContent())!, /Keep item 1\?[\s\S]*Drop it/);
    await p.reload(); await p.waitForSelector("#drop");
    assert.equal(await p.textContent("#val"), "Drop it", "persisted");
    const keys = await p.evaluate(() => Object.keys(localStorage));
    assert.ok(keys.some((k) => k === "artifact-answers:Answer one|2026-10-14"), keys.join());
    await p.goto(origin + "/2.html"); await p.waitForSelector("#drop");
    assert.equal(await p.textContent("#val"), "none", "a second artifact on the same origin does not see it");
  } finally { server.close(); await b.close(); rmSync(a1.root, { recursive: true, force: true }); rmSync(a2.root, { recursive: true, force: true }); }
});

test("bare shell leaves raw table/pre/blockquote unstyled; page shell keeps the reader styles", async (t) => {
  const b = await launch(t); if (!b) return;
  const bare = make("Bare css", "bare"), page = make("Page css", "page");
  try {
    const style = async (d: string) => {
      const out = join(d, "..", "s.html"); writeFileSync(out, (await buildArtifact(d)).html);
      const p = await (await b.newContext()).newPage();
      await p.goto("file://" + out); await p.waitForSelector("#bq");
      return p.evaluate(() => ({
        bq: getComputedStyle(document.getElementById("bq")!).borderLeftWidth,
        pre: getComputedStyle(document.getElementById("raw")!).backgroundColor,
        table: getComputedStyle(document.getElementById("t")!).borderCollapse,
      }));
    };
    assert.deepEqual(await style(bare.d), { bq: "0px", pre: "rgba(0, 0, 0, 0)", table: "separate" });
    const pg = await style(page.d);
    assert.equal(pg.bq, "3px"); assert.equal(pg.table, "collapse"); assert.notEqual(pg.pre, "rgba(0, 0, 0, 0)");
  } finally { await b.close(); rmSync(bare.root, { recursive: true, force: true }); rmSync(page.root, { recursive: true, force: true }); }
});

test("check: importing data/x.json (also from a subfolder) counts as using it", async () => {
  const root = mkdtempSync(join(tmpdir(), "art-r18-"));
  try {
    const d = join(root, "x.artifact");
    mkdirSync(join(d, "data"), { recursive: true }); mkdirSync(join(d, "pages"), { recursive: true });
    writeFileSync(join(d, "data", "a.json"), "[1]"); writeFileSync(join(d, "data", "b.json"), "[2]"); writeFileSync(join(d, "data", "c.json"), "[3]");
    writeFileSync(join(d, "artifact.json"), JSON.stringify({ title: "Imp", kind: "test", audience: "tests", summary: "s", sources: ["x"], shell: "bare" }));
    writeFileSync(join(d, "index.tsx"), `import a from "./data/a.json";\nexport default () => <p>{a.length}</p>;`);
    writeFileSync(join(d, "pages", "p.tsx"), `import b from "../data/b.json";\nexport default () => <p>{b.length}</p>;`);
    const r = await check(d, { types: false });
    const unused = r.warnings.filter((w) => w.startsWith("unused data"));
    assert.deepEqual(unused.map((w) => w.match(/data\/(\w+)\.json/)![1]), ["c"], r.warnings.join("\n"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shot --width puts the width in file names; chrome-path prints the Chromium", async (t) => {
  const { findChrome, shot } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { return t.skip("no Chromium available"); }
  const lines: string[] = []; const log = console.log; console.log = (s: string) => { lines.push(s); };
  try { assert.equal(await main(["chrome-path"]), 0); } finally { console.log = log; }
  assert.equal(lines[0], exe);
  const { root, d } = make("Shot width", "bare");
  try {
    const paths = await shot(d, { width: 700, out: join(root, "shots") });
    assert.match(paths[0], /-w700-light\.png$/);
    assert.deepEqual(readdirSync(join(root, "shots")).filter((f) => f.endsWith(".png")), paths.map((p) => p.split("/").pop()));
    const plain = await shot(d, { out: join(root, "shots2") });
    assert.doesNotMatch(plain[0], /-w\d+/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
