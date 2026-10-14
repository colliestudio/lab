import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtifact } from "../artifact/cli/build.ts";
import { localCommentStore } from "../artifact/host/comments.tsx";

const TITLE = "Drawer fixture", CREATED = "2026-10-13";
const INDEX = `import { Section, Decision } from "artifact";
export default () => <>
  <Section title="One"><p id="p1">Hello world</p>{Array.from({ length: 40 }, (_, i) => <p key={i}>filler paragraph {i} to make the page long enough to scroll</p>)}</Section>
  <Section title="Two"><Decision id="d1" question="Ship it?" options={["Yes", "No"]} recommend={0} /></Section>
</>;`;

async function build(shell: "bare" | "doc") {
  const root = mkdtempSync(join(tmpdir(), "art-drawer-"));
  const d = join(root, "x.artifact");
  mkdirSync(join(d, "evidence"), { recursive: true });
  writeFileSync(join(d, "artifact.json"), JSON.stringify({ title: TITLE, kind: "test", audience: "tests", summary: "s", created: CREATED, shell }));
  writeFileSync(join(d, "index.tsx"), INDEX);
  const out = join(root, "x.html");
  writeFileSync(out, (await buildArtifact(d)).html);
  return { root, out };
}

const seed = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: "c" + i, anchor: { id: "p1", label: "Paragraph", excerpt: "Hello", where: "One" },
  body: `Comment number ${i} ` + "lorem ipsum dolor sit amet ".repeat(4), created: "2026-10-13T00:00:00Z",
}));
const KEY = `artifact-comments:${TITLE}|${CREATED}`;

for (const shell of ["doc", "bare"] as const) {
  test(`feedback drawer (${shell} shell): a long list scrolls inside the drawer, header stays, page does not move`, async (t) => {
    const { findChrome } = await import("../artifact/cli/shot.ts");
    let exe: string;
    try { exe = await findChrome(); } catch { return t.skip("no Chromium available"); }
    const { chromium } = await import("playwright-core");
    const { root, out } = await build(shell);
    try {
      const b = await chromium.launch({ executablePath: exe });
      try {
        for (const [w, h] of [[1280, 800], [400, 700]] as const) {
          const p = await (await b.newContext({ viewport: { width: w, height: h } })).newPage();
          await p.goto("file://" + out);
          await p.evaluate(([k, l]) => localStorage.setItem(k, JSON.stringify(l)), [KEY, seed(30)] as const);
          await p.reload();
          await p.waitForSelector(".a-content");
          await p.keyboard.press("c");
          await p.waitForSelector(".h-panel-body");
          const m = () => p.evaluate(() => {
            const body = document.querySelector(".h-panel-body")!, panel = document.querySelector(".h-panel")!;
            return { sh: body.scrollHeight, ch: body.clientHeight, st: body.scrollTop, y: scrollY, panelH: panel.getBoundingClientRect().height, headTop: document.querySelector(".h-panel-head")!.getBoundingClientRect().top, vh: innerHeight };
          });
          const a = await m();
          assert.ok(a.sh > a.ch, `${w}px: list overflows its box (${a.sh} > ${a.ch})`);
          assert.ok(a.panelH <= a.vh + 1, `${w}px: the drawer fits the screen (${a.panelH} <= ${a.vh})`);
          const box = (await p.locator(".h-panel-body").boundingBox())!;
          await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await p.mouse.wheel(0, 500);
          await p.waitForTimeout(250);
          const wheel = await m();
          assert.ok(wheel.st > 0, `${w}px: wheel scrolls the list`);
          assert.equal(wheel.y, a.y, `${w}px: the page behind did not scroll`);
          await p.mouse.wheel(0, 99999);
          await p.waitForTimeout(250);
          const end = await m();
          assert.equal(end.y, a.y, `${w}px: no scroll chaining at the end of the list`);
          assert.equal(end.headTop, a.headTop, `${w}px: the header stays`);
          await p.locator(".h-panel-body").focus();
          await p.keyboard.press("Home");
          await p.keyboard.press("PageDown");
          await p.waitForTimeout(250);
          assert.ok((await m()).st > 0, `${w}px: keyboard scrolls the list`);
          if (w === 1280) {
            await p.keyboard.press("Escape");
            await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await p.keyboard.press("p");
            await p.waitForSelector(".h-present-bar");
            const pr = await m();
            assert.ok(pr.sh > pr.ch && pr.panelH <= pr.vh + 1, "present mode: the drawer still scrolls inside the screen");
          }
          await p.close();
        }
      } finally { await b.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("feedback drawer: edit a comment and a decision note in place, persisted, copied with the edits", async (t) => {
  const { findChrome } = await import("../artifact/cli/shot.ts");
  let exe: string;
  try { exe = await findChrome(); } catch { return t.skip("no Chromium available"); }
  const { chromium } = await import("playwright-core");
  const { root, out } = await build("doc");
  try {
    const b = await chromium.launch({ executablePath: exe });
    try {
      const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] });
      const p = await ctx.newPage();
      await p.goto("file://" + out);
      await p.evaluate(([k, l]) => localStorage.setItem(k, JSON.stringify(l)), [KEY, seed(2)] as const);
      await p.reload();
      await p.waitForSelector(".a-content");
      await p.keyboard.press("c");
      const first = p.locator(".h-note").first();
      assert.equal(await first.locator(".h-edited").count(), 0, "not edited yet");
      await first.getByRole("button", { name: "Edit" }).click();
      await first.locator("textarea").fill("Reworded comment");
      await p.keyboard.press("Meta+Enter");
      assert.match(await first.innerText(), /Reworded comment/);
      assert.equal(await first.locator(".h-edited").innerText(), "edited");
      assert.equal(await p.locator(".h-note").count(), 2, "edit keeps the comment (and its place)");
      // cancel leaves it alone
      await first.getByRole("button", { name: "Edit" }).click();
      await first.locator("textarea").fill("never saved");
      await p.keyboard.press("Escape");
      assert.match(await first.innerText(), /Reworded comment/);
      await p.getByRole("button", { name: "Copy comments" }).click();
      const md = await p.evaluate(() => navigator.clipboard.readText());
      assert.match(md, /Reworded comment/); assert.doesNotMatch(md, /Comment number 0/); assert.match(md, /Comment number 1/);
      await p.reload();
      await p.waitForSelector(".a-content");
      await p.keyboard.press("c");
      assert.match(await p.locator(".h-note").first().innerText(), /Reworded comment/);
      assert.equal(await p.locator(".h-note").first().locator(".h-edited").count(), 1, "edited survives a reload");

      await p.keyboard.press("Escape"); // leave comment mode so clicks reach the page
      // decision: answer on the page, then change the note from the drawer
      await p.locator('[data-did="d1"]').getByRole("radio", { name: /^Yes/ }).click();
      await p.getByRole("tab", { name: /Decisions/ }).click();
      const row = p.locator(".h-panel .h-decisions li").first();
      await row.getByRole("button", { name: "Add note" }).click();
      await row.locator("textarea").fill("ship after lunch");
      await p.keyboard.press("Meta+Enter");
      assert.match(await row.innerText(), /Note: ship after lunch/);
      await row.getByRole("button", { name: "Edit note" }).click();
      await row.locator("textarea").fill("ship Monday");
      await row.getByRole("button", { name: /^Save/ }).click();
      assert.match(await row.innerText(), /Note: ship Monday/);
      assert.equal(await row.locator(".h-edited").innerText(), "edited");
      await p.getByRole("button", { name: "Copy decisions" }).click();
      const dmd = await p.evaluate(() => navigator.clipboard.readText());
      assert.match(dmd, /note: ship Monday/); assert.doesNotMatch(dmd, /lunch/);
      await p.reload();
      await p.waitForSelector(".a-content");
      await p.keyboard.press("c");
      await p.getByRole("tab", { name: /Decisions/ }).click();
      assert.match(await p.locator(".h-panel .h-decisions li").first().innerText(), /Note: ship Monday/);
      // changing the choice on the page marks the answer edited too
      await p.keyboard.press("Escape");
      await p.locator('[data-did="d1"]').getByRole("radio", { name: /^No/ }).click();
      assert.match(await p.locator(".h-panel .h-decisions li").first().innerText(), /No[\s\S]*Note: ship Monday/);
    } finally { await b.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stores: update changes a comment in place, updateAnswer patches an answer", () => {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) };
  try {
    const st = localCommentStore("u");
    const a = { id: "a", anchor: { id: "x", label: "x", excerpt: "e" }, body: "one", created: "t0" };
    st.add(a); st.add({ ...a, id: "b", body: "two" });
    st.update("a", { body: "uno", edited: "t1" });
    assert.deepEqual(st.list().map((c) => [c.id, c.body, c.edited]), [["a", "uno", "t1"], ["b", "two", undefined]]);
    st.update("zzz", { body: "x" });
    assert.equal(st.list().length, 2);
    st.setAnswer("d", { choice: "a", label: "Yes", at: "t0" });
    st.updateAnswer("d", { note: "n", edited: "t1" });
    st.updateAnswer("nope", { note: "n" });
    assert.deepEqual(st.answers(), { d: { choice: "a", label: "Yes", at: "t0", note: "n", edited: "t1" } });
  } finally { delete (globalThis as unknown as { localStorage?: unknown }).localStorage; }
});
