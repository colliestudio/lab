// Recorder: drives a Playwright context and captures five streams on one clock.
//   rrweb    — DOM replay (injected into the page)
//   console  — page.on('console') + uncaught errors
//   network  — every request with timing, headers, and fetch/xhr bodies
//   storage  — cookies (Node side) + localStorage/sessionStorage (in-page hook)
//   steps    — say("caption") markers
// finish() writes a bundle dir + <name>.replay zip + Playwright trace.zip.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";

const RRWEB = readFileSync(new URL("../node_modules/rrweb/umd/rrweb.min.js", import.meta.url), "utf8").replace(/\n\/\/# sourceMappingURL=.*$/, "");
const BODY_LIMIT = 64 * 1024;

// Runs in every document. Starts rrweb and reports storage writes.
const INIT = `${RRWEB}
;(() => {
  if (!location.protocol.startsWith("http")) return;
  const send = (kind, data) => window.__replay(kind, data);
  const start = () => rrweb.record({
    emit: (event) => send("rrweb", event),
    sampling: { mousemove: 50, scroll: 150 },  // input: every keystroke ("last" keeps only the final value)
    maskInputOptions: { password: true },
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // Storage: patch the prototype so every write is seen, whichever store.
  const area = (s) => (s === localStorage ? "local" : "session");
  const P = Storage.prototype;
  const set = P.setItem, remove = P.removeItem, clear = P.clear;
  P.setItem = function (k, v) { send("storage", { area: area(this), op: "set", key: k, value: String(v) }); return set.call(this, k, v); };
  P.removeItem = function (k) { send("storage", { area: area(this), op: "remove", key: k }); return remove.call(this, k); };
  P.clear = function () { send("storage", { area: area(this), op: "clear" }); return clear.call(this); };
  // Initial state for this document, so the timeline starts complete.
  const dump = (s) => Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)]));
  send("storage", { area: "local", op: "snapshot", value: dump(localStorage) });
  send("storage", { area: "session", op: "snapshot", value: dump(sessionStorage) });
})();`;

export async function record(browser, { name, url, viewport = { width: 1280, height: 800 }, colorScheme = "light" }) {
  const context = await browser.newContext({ viewport, colorScheme });
  const startedAt = Date.now();
  const s = { rrweb: [], console: [], network: [], storage: [], steps: [] };
  const now = () => Date.now();

  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  await context.exposeBinding("__replay", ({ page }, kind, data) => {
    if (kind === "rrweb") s.rrweb.push(data);
    else s.storage.push({ t: now(), origin: new URL(page.url()).origin, ...data });
  });
  await context.addInitScript({ content: INIT });

  // Console + errors
  const onPage = (page) => {
    page.on("console", (m) => {
      const loc = m.location();
      s.console.push({ t: now(), level: m.type(), text: m.text(), source: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined });
    });
    page.on("pageerror", (e) => s.console.push({ t: now(), level: "error", text: `Uncaught ${e.name}: ${e.message}`, stack: e.stack }));
  };
  context.on("page", onPage);

  // Network
  const reqs = new Map();
  let nextId = 1;
  context.on("request", (r) => {
    const entry = { id: nextId++, t: now(), method: r.method(), url: r.url(), type: r.resourceType(), requestHeaders: r.headers(), requestBody: r.postData() ?? undefined };
    reqs.set(r, entry);
    s.network.push(entry);
  });
  const settle = async (r, failure) => {
    const entry = reqs.get(r);
    if (!entry) return;
    entry.end = now();
    entry.duration = entry.end - entry.t;
    if (failure) return void (entry.error = failure);
    const res = await r.response();
    if (!res) return;
    entry.status = res.status();
    entry.responseHeaders = await res.allHeaders();
    if (entry.type === "fetch" || entry.type === "xhr" || entry.type === "document") {
      try {
        const body = await res.text();
        entry.responseBody = body.length > BODY_LIMIT ? body.slice(0, BODY_LIMIT) + "…[truncated]" : body;
      } catch {}
    }
    // Cookies can change on any response; record a diff.
    await cookieCheck();
  };
  context.on("requestfinished", (r) => settle(r));
  context.on("requestfailed", (r) => settle(r, r.failure()?.errorText ?? "failed"));

  let lastCookies = "[]";
  const cookieCheck = async () => {
    const cookies = await context.cookies();
    const json = JSON.stringify(cookies);
    if (json === lastCookies) return;
    lastCookies = json;
    s.storage.push({ t: now(), area: "cookie", op: "snapshot", value: cookies });
  };

  const page = await context.newPage();

  const pause = (ms) => page.waitForTimeout(ms);
  const api = {
    page,
    /** Caption + timeline marker. Also groups the Playwright trace. */
    async say(text, readMs = 1200) {
      s.steps.push({ t: now(), text });
      await page.evaluate((text) => window.rrweb?.record.addCustomEvent("step", { text }), text).catch(() => {});
      await pause(readMs);
    },
    async go(path) { await page.goto(new URL(path, url).href); await pause(600); },
    async click(selector) {
      const el = page.locator(selector);
      await el.evaluate((n) => { n.style.outline = "3px solid #f59e0b"; n.style.outlineOffset = "2px"; });
      await pause(500);
      await el.evaluate((n) => { n.style.outline = ""; });
      await el.click();
      await pause(700);
    },
    async type(selector, text) { await page.locator(selector).pressSequentially(text, { delay: 55 }); await pause(300); },
    pause,

    async finish(outDir = "out") {
      await pause(800);
      await Promise.allSettled([...reqs.keys()].map((r) => r.response()));
      const dir = `${outDir}/${name}`;
      mkdirSync(dir, { recursive: true });
      await context.tracing.stop({ path: `${dir}/trace.zip` });
      await context.close();

      const endedAt = Date.now();
      const manifest = {
        format: "replay/0",
        name,
        url,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: endedAt - startedAt,
        viewport,
        colorScheme,
        userAgent: await browser.version(),
        counts: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.length])),
        files: ["manifest.json", "rrweb.json", "steps.json", "console.json", "network.json", "storage.json", "trace.zip"],
      };
      const files = {
        "manifest.json": manifest,
        "rrweb.json": s.rrweb,
        "steps.json": s.steps,
        "console.json": s.console,
        "network.json": s.network,
        "storage.json": s.storage,
      };
      const zip = {};
      for (const [f, v] of Object.entries(files)) {
        const text = JSON.stringify(v, null, f === "rrweb.json" ? 0 : 2);
        writeFileSync(`${dir}/${f}`, text);
        zip[f] = strToU8(text);
      }
      zip["trace.zip"] = [readFileSync(`${dir}/trace.zip`), { level: 0 }];
      writeFileSync(`${outDir}/${name}.replay`, zipSync(zip, { level: 9 }));
      return { dir, bundle: `${outDir}/${name}.replay`, manifest };
    },
  };
  return api;
}
