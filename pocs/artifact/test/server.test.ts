import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import type { Comment, ViewerBoot } from "../src/model.ts";
import { buildHtml, publish, startHosted, startServe } from "../src/server/index.ts";
import { zipBundle } from "../src/server/publish.ts";

const FIXTURE = new URL("./fixtures/sample.review", import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), "recap-test-"));
const copyFixture = () => { const d = join(tmp(), "sample.review"); cpSync(FIXTURE, d, { recursive: true }); return d; };
const bootOf = (html: string): ViewerBoot => JSON.parse(/window\.__RECAP__=(.*?);(?:new EventSource|<\/script>)/s.exec(html)![1]);
const postComment = (url: string, body: object) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("serve: viewer boot, doc, files, comments, path safety", async () => {
  const dir = copyFixture();
  const s = await startServe(dir, { log: () => {} });
  try {
    const html = await (await fetch(s.url)).text();
    const boot = bootOf(html);
    assert.equal(boot.api, "/api");
    assert.equal(boot.doc.title, "Todo app sign-in and export");
    assert.match(html, /EventSource/);

    const doc = await (await fetch(s.url + "api/doc")).json();
    assert.equal(doc.sections[0].id, "signin");

    const png = await fetch(s.url + "api/files/assets/shot.png");
    assert.equal(png.status, 200);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.equal((await png.arrayBuffer()).byteLength, 70);
    assert.equal((await fetch(s.url + "api/files/demos/todo.replay")).headers.get("content-type"), "application/zip");
    assert.equal((await fetch(s.url + "api/files/%2e%2e%2f%2e%2e%2fetc%2fpasswd")).status, 404);
    assert.equal((await fetch(s.url + "api/files/nope.png")).status, 404);

    assert.deepEqual(await (await fetch(s.url + "api/comments")).json(), []);
    assert.equal((await postComment(s.url + "api/comments", { author: "a" })).status, 400);
    const r = await postComment(s.url + "api/comments", { anchor: { section: "signin" }, author: "alex", body: "why a cookie?" });
    assert.equal(r.status, 201);
    const c: Comment = await r.json();
    assert.ok(c.id && c.created);
    const onDisk = JSON.parse(readFileSync(join(dir, "comments.json"), "utf8"));
    assert.equal(onDisk[0].body, "why a cookie?");
    assert.deepEqual(onDisk[0].anchor, { section: "signin" });
    assert.equal((await (await fetch(s.url + "api/comments")).json()).length, 1);
  } finally { await s.close(); }
});

test("serve: live reload pushes an SSE event and re-parses doc.md", async () => {
  const dir = copyFixture();
  const s = await startServe(dir, { log: () => {} });
  try {
    const res = await fetch(s.url + "api/events");
    const reader = res.body!.getReader();
    await reader.read(); // ": hi"
    const md = readFileSync(join(dir, "doc.md"), "utf8");
    writeFileSync(join(dir, "doc.md"), md.replace("title: Todo app sign-in and export", "title: Renamed"));
    const dec = new TextDecoder();
    let got = "";
    const deadline = Date.now() + 3000;
    while (!got.includes("event: reload") && Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), new Promise<never>((_, no) => setTimeout(() => no(new Error("no reload event")), 3000))]);
      if (done) break;
      got += dec.decode(value);
    }
    assert.match(got, /event: reload/);
    assert.equal((await (await fetch(s.url + "api/doc")).json()).title, "Renamed");
    await reader.cancel();
  } finally { await s.close(); }
});

test("serve: zip bundle keeps comments in a sidecar", async () => {
  const d = tmp();
  const zip = join(d, "sample.review");
  writeFileSync(zip, zipBundle(FIXTURE));
  const s = await startServe(zip, { log: () => {} });
  try {
    assert.equal((await fetch(s.url + "api/files/assets/shot.png")).status, 200);
    assert.equal((await postComment(s.url + "api/comments", { author: "a", body: "hi" })).status, 201);
    assert.ok(existsSync(zip + ".comments.json"));
    assert.equal((await (await fetch(s.url + "api/comments")).json())[0].body, "hi");
  } finally { await s.close(); }
});

test("build: one HTML with boot, referenced files inlined, no api", async () => {
  const { html, files } = await buildHtml(FIXTURE);
  assert.deepEqual(files, ["assets/shot.png", "demos/todo.replay"]);
  const boot = bootOf(html);
  assert.equal(boot.api, undefined);
  assert.equal(boot.doc.title, "Todo app sign-in and export");
  assert.deepEqual(Object.keys(boot.files!).sort(), files);
  assert.equal(Buffer.from(boot.files!["assets/shot.png"], "base64").length, 70);
  const replay = unzipSync(Buffer.from(boot.files!["demos/todo.replay"], "base64"));
  assert.ok(replay["rrweb.json"] && replay["steps.json"] && !replay["trace.zip"]);
  assert.ok(!html.includes("<!--RECAP_BOOT-->"));
});

test("server: publish, view, comment, re-publish in place, auth, unlisted index", async () => {
  const data = tmp();
  const srv = await startHosted({ data, token: "sekrit" });
  const to = srv.url;
  try {
    await assert.rejects(publish(FIXTURE, { to }), /401/);
    const { id, url } = await publish(FIXTURE, { to, token: "sekrit" });
    assert.match(id, /^[A-Za-z0-9]{10}$/);
    assert.equal(url, `${to}d/${id}`);
    assert.ok(existsSync(join(data, id, "bundle.review")) && existsSync(join(data, id, "doc.json")));

    const boot = bootOf(await (await fetch(url)).text());
    assert.equal(boot.api, `/d/${id}/api`);
    const api = `${to}d/${id}/api`;
    assert.equal((await (await fetch(api + "/doc")).json()).title, "Todo app sign-in and export");
    const png = await fetch(api + "/files/assets/shot.png");
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.equal((await postComment(api + "/comments", { author: "r", body: "looks good" })).status, 201);

    // re-publish (PR re-push): same id, new content, comments kept; the token alone is enough
    const dir = copyFixture();
    writeFileSync(join(dir, "doc.md"), readFileSync(join(dir, "doc.md"), "utf8").replace("title: Todo app sign-in and export", "title: v2"));
    await assert.rejects(publish(dir, { to, id }), /401/);
    const again = await publish(dir, { to, token: "sekrit", id });
    assert.equal(again.id, id);
    assert.equal((await (await fetch(api + "/doc")).json()).title, "v2");
    assert.equal((await (await fetch(api + "/comments")).json())[0].body, "looks good");

    await assert.rejects(publish(FIXTURE, { to, token: "sekrit", id: "AAAAAAAAAA" }), /404/);
    const bad = await fetch(to + "api/docs", { method: "POST", headers: { authorization: "Bearer sekrit" }, body: "not a zip" });
    assert.equal(bad.status, 400);

    assert.equal((await fetch(to)).status, 404);
    assert.equal((await fetch(to + "?token=wrong")).status, 404);
    const index = await fetch(to + "?token=sekrit");
    assert.equal(index.status, 200);
    assert.match(await index.text(), new RegExp(`/d/${id}">v2<`));
    assert.equal((await fetch(to + "d/zzzzzzzzzz")).status, 404);
  } finally { await srv.close(); }
});

test("build: a real sample boots the real viewer; injected JSON never closes the script", async () => {
  const dir = join(tmp(), "replay-lab-backend.review");
  cpSync(new URL("../samples/replay-lab-backend.review", import.meta.url).pathname, dir, { recursive: true });
  const md = readFileSync(join(dir, "doc.md"), "utf8");
  writeFileSync(join(dir, "doc.md"), md.replace(/^title: .*$/m, "title: \"Hostile </script><script>alert(1)</script> <!-- title\""));
  const { html, files } = await buildHtml(dir);
  assert.deepEqual(files, ["demos/todo-otel.replay", "demos/webhooks-otel.replay"]);
  const start = html.indexOf("window.__RECAP__=");
  assert.ok(start > 0, "boot script present");
  const end = html.indexOf("</script>", start);
  const json = html.slice(start + "window.__RECAP__=".length, end).replace(/;$/, "");
  assert.ok(!/<\/script/i.test(json) && !json.includes("<!--") && !json.includes("<"), "no raw < inside the injected JSON");
  const boot: ViewerBoot = JSON.parse(json);
  assert.equal(boot.doc.title, "Hostile </script><script>alert(1)</script> <!-- title");
  assert.ok(boot.doc.overviewBlocks.length > 0);
  assert.match(html, /<div id="root"><\/div>/, "real viewer, not a stub");
  assert.ok(html.indexOf("window.__RECAP__=") < html.indexOf('<script type="module"'), "boot runs before the viewer module");
});
