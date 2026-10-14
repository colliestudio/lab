// Untrusted bundles and exposed servers: review.md findings 1, 2, 3, 5, 6, 7, 8, 12.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { loadBundle, parseDoc } from "../src/parse/index.ts";
import { publish, run, startHosted, startServe } from "../src/server/index.ts";
import { zipBundle } from "../src/server/publish.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const root = new URL("../", import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), "recap-sec-"));
const copy = (name: string, to = tmp()) => { const d = join(to, name); cpSync(fixture(name), d, { recursive: true }); return d; };
const setPlan = (dir: string, plan: string) =>
  writeFileSync(join(dir, "doc.md"), readFileSync(join(dir, "doc.md"), "utf8").replace(/^plan: .*$/m, `plan: ${plan}`));
const upload = (to: string, body: Uint8Array, headers: Record<string, string> = {}) =>
  fetch(to + "api/docs", { method: "POST", headers: { "content-type": "application/zip", ...headers }, body: body as Uint8Array<ArrayBuffer> });

test("server: an upload's plan: never reads server disk; links only to a plan on the same server", async () => {
  const data = tmp();
  const srv = await startHosted({ data });
  try {
    // absolute path to a real plan on this machine: not followed, plan title doesn't leak
    const review = copy("retries.review");
    setPlan(review, fixture("retries.plan"));
    const a = await publish(review, { to: srv.url });
    const docA = await (await fetch(`${srv.url}d/${a.id}/api/doc`)).json();
    assert.equal(docA.planLink, undefined);
    assert.ok(!JSON.stringify(docA).includes("Retry failed webhook deliveries\",\"done"));
    assert.match(docA.warnings.join("\n"), /not linked/);

    // /dev/zero: answered at once (it used to read forever)
    setPlan(review, "/dev/zero");
    const t0 = Date.now();
    const z = await publish(review, { to: srv.url });
    assert.ok(Date.now() - t0 < 5000);
    assert.equal((await (await fetch(`${srv.url}d/${z.id}/api/doc`)).json()).planLink, undefined);

    // a plan published to the same server, referenced by id or /d/<id> link
    const plan = await publish(copy("retries.plan"), { to: srv.url });
    const local = (await loadBundle(fixture("retries.review"))).doc.planLink!;
    for (const ref of [plan.id, plan.url]) {
      setPlan(review, ref);
      const r = await publish(review, { to: srv.url });
      const link = (await (await fetch(`${srv.url}d/${r.id}/api/doc`)).json()).planLink;
      assert.deepEqual({ ...link, src: "" }, { ...local, src: "" });
    }
  } finally { await srv.close(); }
});

test("local: plan: pointing at a device or fifo is not read", async () => {
  const review = copy("retries.review");
  setPlan(review, "/dev/zero");
  const t0 = Date.now();
  const b = await loadBundle(review);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(b.doc.planLink, undefined);
  assert.match(b.doc.warnings.join("\n"), /not found/);
});

test("server: refuses a non-loopback bind without a token", async () => {
  await assert.rejects(startHosted({ data: tmp(), host: "0.0.0.0" }), /without a token/);
  const srv = await startHosted({ data: tmp(), host: "0.0.0.0", token: "t" });
  await srv.close();
  assert.equal(await run("server", ["--data", tmp(), "--host", "0.0.0.0"]), 1);
});

test("server: re-publish needs the doc's edit secret (or the token); the CLI saves and reuses the secret", async () => {
  const data = tmp();
  const srv = await startHosted({ data });
  try {
    const first = await publish(fixture("sample.review"), { to: srv.url });
    assert.ok(first.secret && first.secret.length >= 20);
    const meta = JSON.parse(readFileSync(join(data, first.id, "meta.json"), "utf8"));
    assert.equal(meta.editHash, createHash("sha256").update(first.secret).digest("hex"));
    assert.ok(!readFileSync(join(data, first.id, "meta.json"), "utf8").includes(first.secret));

    await assert.rejects(publish(fixture("sample.review"), { to: srv.url, id: first.id }), /401/);
    await assert.rejects(publish(fixture("sample.review"), { to: srv.url, id: first.id, secret: "x".repeat(24) }), /401/);
    await assert.rejects(publish(fixture("sample.review"), { to: srv.url, id: first.id, token: "anything" }), /401/);
    // another doc's secret doesn't work either
    const other = await publish(fixture("sample.review"), { to: srv.url });
    await assert.rejects(publish(fixture("sample.review"), { to: srv.url, id: first.id, secret: other.secret }), /401/);
    assert.equal((await publish(fixture("sample.review"), { to: srv.url, id: first.id, secret: first.secret })).id, first.id);

    // CLI: first publish writes .recap-publish.json next to the bundle; --id finds the secret there
    const bundle = copy("sample.review");
    const log = console.log, err = console.error;
    const out: string[] = [];
    console.log = (s: string) => out.push(s); console.error = () => {};
    try {
      assert.equal(await run("publish", [bundle, "--to", srv.url]), 0);
      const rec = join(bundle, "..", ".recap-publish.json");
      assert.ok(existsSync(rec));
      assert.equal(statSync(rec).mode & 0o777, 0o600);
      const id = out[0].split("/d/")[1];
      writeFileSync(join(bundle, "doc.md"), readFileSync(join(bundle, "doc.md"), "utf8").replace(/^title: .*$/m, "title: v2"));
      assert.equal(await run("publish", [bundle, "--to", srv.url, "--id", id]), 0);
      assert.equal((await (await fetch(`${srv.url}d/${id}/api/doc`)).json()).title, "v2");
    } finally { console.log = log; console.error = err; }
  } finally { await srv.close(); }
});

test("server: zip bombs and oversized uploads are rejected before inflating", async () => {
  const srv = await startHosted({ data: tmp(), limits: { maxBytes: 1024 * 1024, maxEntries: 50 } });
  try {
    const ok = zipBundle(fixture("sample.review"));
    assert.equal((await upload(srv.url, ok)).status, 201);
    const bomb = zipSync({ "doc.md": new TextEncoder().encode("---\ntitle: x\n---\n"), "big.bin": new Uint8Array(8 * 1024 * 1024) }, { level: 9 });
    assert.ok(bomb.length < 100 * 1024);
    const r = await upload(srv.url, bomb);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /too large/);
    const many: Record<string, Uint8Array> = { "doc.md": new TextEncoder().encode("---\ntitle: x\n---\n") };
    for (let i = 0; i < 60; i++) many[`f${i}.txt`] = new Uint8Array(1);
    assert.match(await (await upload(srv.url, zipSync(many))).text(), /more than 50 files/);
    assert.equal((await upload(srv.url, new Uint8Array(26 * 1024 * 1024))).status, 413);
  } finally { await srv.close(); }
});

test("serve + server: bundle files are passive (nosniff, sandbox CSP, active types downloaded)", async () => {
  const dir = copy("sample.review");
  writeFileSync(join(dir, "evil.html"), "<script>alert(document.domain)</script>");
  writeFileSync(join(dir, "evil.js"), "alert(1)");
  writeFileSync(join(dir, "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  const s = await startServe(dir, { log: () => {} });
  const srv = await startHosted({ data: tmp() });
  try {
    const { id } = await publish(dir, { to: srv.url });
    for (const base of [`${s.url}api/files/`, `${srv.url}d/${id}/api/files/`]) {
      for (const f of ["evil.html", "evil.js"]) {
        const r = await fetch(base + f);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("content-type"), "application/octet-stream");
        assert.match(r.headers.get("content-disposition")!, /^attachment/);
        assert.equal(r.headers.get("x-content-type-options"), "nosniff");
        assert.match(r.headers.get("content-security-policy")!, /^sandbox/);
      }
      const svg = await fetch(base + "pic.svg");
      assert.equal(svg.headers.get("content-type"), "image/svg+xml");
      assert.match(svg.headers.get("content-security-policy")!, /^sandbox; default-src 'none'/);
      const png = await fetch(base + "assets/shot.png");
      assert.equal(png.headers.get("content-type"), "image/png");
      assert.equal(png.headers.get("x-content-type-options"), "nosniff");
    }
  } finally { await s.close(); await srv.close(); }
});

test("serve + server: viewer page is a small shell with a strict CSP; viewer JS/CSS are cached assets", async () => {
  const s = await startServe(fixture("sample.review"), { log: () => {} });
  const srv = await startHosted({ data: tmp() });
  try {
    const { url } = await publish(fixture("sample.review"), { to: srv.url });
    for (const page of [s.url, url]) {
      const r = await fetch(page);
      const html = await r.text();
      assert.ok(html.length < 200_000, `shell is small (${html.length})`);
      const csp = r.headers.get("content-security-policy")!;
      const inline = /<script>(.*?)<\/script>/s.exec(html)![1];
      const hash = createHash("sha256").update(inline).digest("base64");
      assert.ok(csp.includes(`script-src 'self' 'sha256-${hash}'`), csp);
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal((html.match(/<script>/g) ?? []).length, 1, "one inline script (the boot)");

      const origin = new URL(page).origin;
      const js = /<script type="module" src="([^"]+)"/.exec(html)![1];
      const css = /<link rel="stylesheet" href="([^"]+)"/.exec(html)![1];
      const a = await fetch(origin + js);
      assert.equal(a.status, 200);
      assert.match(a.headers.get("content-type")!, /javascript/);
      assert.match(a.headers.get("cache-control")!, /immutable/);
      assert.ok((await a.arrayBuffer()).byteLength > 1_000_000);
      const again = await fetch(origin + js, { headers: { "if-none-match": a.headers.get("etag")! } });
      assert.equal(again.status, 304);
      assert.match((await fetch(origin + css)).headers.get("content-type")!, /text\/css/);
      assert.equal((await fetch(origin + "/_recap/viewer.nope.js")).status, 404);
    }
  } finally { await s.close(); await srv.close(); }
});

test("serve: rejects foreign Host headers and non-JSON comment posts", async () => {
  const dir = copy("sample.review");
  const s = await startServe(dir, { log: () => {} });
  try {
    const port = new URL(s.url).port;
    const status = (host: string) => new Promise<number>((ok, no) => {
      request({ host: "127.0.0.1", port, path: "/api/doc", headers: { host } }, (r) => { r.resume(); ok(r.statusCode!); }).on("error", no).end();
    });
    assert.equal(await status("evil.example:" + port), 403);
    assert.equal(await status("localhost:" + port), 200);
    const r = await fetch(s.url + "api/comments", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ body: "x" }) });
    assert.equal(r.status, 415);
    assert.ok(!existsSync(join(dir, "comments.json")));
  } finally { await s.close(); }
});

test("cli comments: reads a zip bundle's sidecar comments", async () => {
  const d = tmp();
  const zip = join(d, "sample.review");
  writeFileSync(zip, zipBundle(fixture("sample.review")));
  const s = await startServe(zip, { log: () => {} });
  try {
    const post = (body: object) => fetch(s.url + "api/comments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await post({ author: "a", body: "first" });
    await post({ author: "a", body: "done", resolved: true });
  } finally { await s.close(); }
  const cli = (...a: string[]) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", join(root, "src/cli.ts"), "comments", ...a], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(cli(zip).map((c: { body: string }) => c.body), ["first", "done"]);
  assert.deepEqual(cli(zip, "--open").map((c: { body: string }) => c.body), ["first"]);
});

test("parse: an inline diff of a Markdown file keeps its ``` context lines", () => {
  const md = [
    "---", "title: t", "---", "", "## A {#a}", "", "```diff", "--- a/README.md", "+++ b/README.md", "@@ -1,3 +1,4 @@",
    " ```", "-old", "+new", "+more", " ```", "```", "",
  ].join("\n");
  const doc = parseDoc(md);
  const b = doc.sections[0].blocks.find((x) => x.type === "diff");
  assert.ok(b && b.type === "diff");
  assert.equal(b.hunks[0].lines.length, 5);
  assert.deepEqual(b.hunks[0].lines.map((l) => l.s), ["```", "old", "new", "more", "```"]);
});
