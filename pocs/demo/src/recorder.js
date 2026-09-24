// Recorder: drives a Playwright context and captures five streams on one clock.
//   rrweb    — DOM replay (injected into the page)
//   console  — page.on('console') + uncaught errors
//   network  — every request with timing, headers, and fetch/xhr bodies
//   storage  — cookies (Node side) + localStorage/sessionStorage (in-page hook)
//   steps    — say("caption") markers
// finish() writes a bundle dir + <name>.replay zip + Playwright trace.zip.
import { mkdirSync, readFileSync } from "node:fs";
import { writeBundle } from "./bundle.js";

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

  // Trace context: each same-origin fetch gets a W3C traceparent. The browser request is the root
  // span; the server continues the trace, so a network row links to its backend spans and logs.
  const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
  const origFetch = window.fetch;
  window.fetch = function (input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin !== location.origin) return origFetch.call(this, input, init);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has("traceparent")) headers.set("traceparent", "00-" + hex(16) + "-" + hex(8) + "-01");
    return origFetch.call(this, input, { ...init, headers });
  };

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

// stage: "ui" (a page, rrweb) or "http" (no page; API calls, webhooks, DB changes are the show).
export async function record(browser, { name, url, stage = "ui", viewport = { width: 1280, height: 800 }, colorScheme = "light" }) {
  const context = await browser.newContext({ viewport, colorScheme, baseURL: url });
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
    const tp = /^00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(r.headers().traceparent ?? "");
    const entry = { id: nextId++, t: now(), method: r.method(), url: r.url(), type: r.resourceType(), requestHeaders: r.headers(), requestBody: r.postData() ?? undefined, traceId: tp?.[1], spanId: tp?.[2] };
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

  const page = stage === "ui" ? await context.newPage() : null;

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const onStep = []; // hooks run at every step boundary (e.g. DB snapshot)

  // API calls: Playwright's request client does the HTTP (cookies shared with the browser context),
  // but emits no events and isn't in library-mode traces — so we record the call ourselves.
  const call = (method) => async (path, opts = {}) => {
    const traceId = hex(16), spanId = hex(8);
    const headers = { traceparent: `00-${traceId}-${spanId}-01`, ...(opts.headers ?? {}) };
    const body = opts.data === undefined ? undefined : typeof opts.data === "string" ? opts.data : JSON.stringify(opts.data);
    const entry = { id: nextId++, t: now(), method, url: new URL(path, url).href, type: "api", requestHeaders: headers, requestBody: body, traceId, spanId };
    s.network.push(entry);
    const res = await context.request.fetch(path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, data: body, failOnStatusCode: false });
    entry.end = now();
    entry.duration = entry.end - entry.t;
    entry.status = res.status();
    entry.responseHeaders = res.headers();
    const text = await res.text();
    entry.responseBody = text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) + "…[truncated]" : text;
    await cookieCheck();
    let json;
    try { json = JSON.parse(text); } catch {}
    return { status: entry.status, headers: entry.responseHeaders, text, json };
  };
  const api = {
    page,
    /** Caption + timeline marker. Also groups the Playwright trace. */
    async say(text, readMs = stage === "ui" ? 1200 : 900) {
      for (const hook of onStep) await hook(text);
      s.steps.push({ t: now(), text });
      if (page) await page.evaluate((text) => window.rrweb?.record.addCustomEvent("step", { text }), text).catch(() => {});
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
    http: { get: call("GET"), post: call("POST"), put: call("PUT"), patch: call("PATCH"), delete: call("DELETE") },
    /** Poll until fn() is truthy — for effects that happen after the response (jobs, webhooks, retries). */
    async until(fn, { timeout = 10000, every = 100 } = {}) {
      const end = Date.now() + timeout;
      while (!(await fn())) { if (Date.now() > end) throw new Error("until: timed out"); await pause(every); }
    },
    onStep,
    stream(name) { return (s[name] ??= []); },

    /** extra: optional backend streams, e.g. { server: [...], spans: [...] } */
    async finish(outDir = "out", extra = {}) {
      await pause(800);
      await Promise.allSettled([...reqs.keys()].map((r) => r.response()));
      for (const hook of onStep) await hook(null);
      const dir = `${outDir}/${name}`;
      mkdirSync(dir, { recursive: true });
      await context.tracing.stop({ path: `${dir}/trace.zip` });
      await context.close();

      return writeBundle(outDir, {
        name, url, recorder: "playwright", stage,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        viewport, colorScheme,
        userAgent: await browser.version(),
      }, { ...s, ...(await (typeof extra === "function" ? extra() : extra)) });
    },
  };
  return api;
}
