// Recorder: drives a Playwright context and captures five streams on one clock.
//   rrweb    — DOM replay (injected into the page)
//   console  — page.on('console') + uncaught errors
//   network  — every request with timing, headers, and fetch/xhr bodies
//   storage  — cookies (Node side) + localStorage/sessionStorage (in-page hook)
//   steps    — say("caption") markers
// finish() writes a bundle dir + <name>.replay zip + Playwright trace.zip.
import { mkdirSync, readFileSync } from "node:fs";
import { writeBundle } from "./bundle.js";
import { expect as pwExpect } from "@playwright/test";

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
export async function record(browser, { name, url, stage = "ui", viewport = { width: 1280, height: 800 }, colorScheme = "light", contextOptions = {}, cookies = [] }) {
  const context = await browser.newContext({ viewport, colorScheme, baseURL: url, ...contextOptions });
  if (cookies.length) await context.addCookies(cookies.map((c) => ({ url, ...c })));
  const startedAt = Date.now();
  const s = { rrweb: [], console: [], network: [], storage: [], steps: [] };
  const now = () => Date.now();

  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  let mainPage = null; // only the main page is filmed; offstage pages are not
  await context.exposeBinding("__replay", ({ page }, kind, data) => {
    if (mainPage && page !== mainPage) return;
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
  mainPage = page;
  // Console is attached to the filmed page only; offstage pages stay out of the recording.
  if (page) onPage(page);

  // Targets: a Playwright locator, a CSS selector, or visible text (button/link name, then label, then exact text).
  const looksLikeCss = (x) => /^([#.\[]|[a-z][\w-]*[#.\[:])/i.test(x.trim()) || /^(css|xpath)=/.test(x);
  const target = (x) => {
    if (typeof x !== "string") return x;
    if (looksLikeCss(x)) return page.locator(x);
    return page.getByRole("button", { name: x, exact: true })
      .or(page.getByRole("link", { name: x, exact: true }))
      .or(page.getByRole("tab", { name: x, exact: true }))
      .or(page.getByRole("menuitem", { name: x, exact: true }))
      .first();
  };
  const field = (x) => (typeof x !== "string" ? x : looksLikeCss(x) ? page.locator(x) : page.getByLabel(x, { exact: true }).or(page.getByPlaceholder(x, { exact: true })).first());
  const actions = (s.actions = []); // what each step touched, with its box: the sheet zooms there
  const highlight = async (loc, kind = "act") => {
    const box = await loc.boundingBox({ timeout: 3000 }).catch(() => null);
    actions.push({ t: now(), kind, target: String(loc).slice(0, 200), box });
    if (!box) return;
    await page.evaluate((b) => {
      const d = document.createElement("div");
      d.className = "__demo_hl";
      Object.assign(d.style, { position: "fixed", left: b.x - 5 + "px", top: b.y - 5 + "px", width: b.width + 10 + "px", height: b.height + 10 + "px",
        border: "3px solid #f59e0b", borderRadius: "6px", pointerEvents: "none", zIndex: 2147483647 });
      document.documentElement.append(d);
      setTimeout(() => d.remove(), 700);
    }, box).catch(() => {});
    await pause(650);
  };
  const expects = (s.expects = []);

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
    async click(what) {
      const el = target(what);
      await el.waitFor({ state: "visible", timeout: 10000 });
      await highlight(el, "click");
      await el.click();
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await pause(700);
    },
    async type(what, text) {
      const el = field(what);
      await highlight(el, "type");
      await el.click();
      await el.press("ControlOrMeta+a"); // select-all then type: fill("") left "03" in React number inputs (hotelapp-qa)
      await el.pressSequentially(text, { delay: 55 });
      await pause(300);
    },
    async pick(what, option) { const el = field(what); await highlight(el, "pick"); await el.selectOption({ label: option }); await pause(500); },
    /** Playwright expect, recorded as ✓/✗ on the timeline. soft: record ✗ and carry on (compare "before" runs). */
    expect(locator, { soft = false } = {}) {
      const loc = typeof locator === "string" ? page.getByText(locator).first() : locator;
      return new Proxy({}, {
        get: (_, matcher) => async (...args) => {
          const e = { t: now(), step: s.steps.at(-1)?.text, matcher: String(matcher), target: String(loc), pass: true };
          try { await pwExpect(loc)[matcher](...args); e.box = await loc.first().boundingBox({ timeout: 500 }).catch(() => null) ?? undefined; }
          catch (err) { e.pass = false; e.message = String(err.message).split("\n").slice(0, 4).join(" ").slice(0, 400); }
          expects.push(e);
          await page.evaluate((e) => window.rrweb?.record.addCustomEvent("expect", e), e).catch(() => {});
          if (!e.pass && !soft) throw new Error("expect failed: " + e.message);
          await pause(400);
        },
      });
    },
    /** Unfilmed setup mid-journey: a separate page in the same context (shares cookies), not recorded. */
    async offstage(fn, label) {
      const p = await context.newPage();
      try { await fn(p, context); } finally { await p.close(); }
      if (label) s.steps.push({ t: now(), text: label, kind: "offstage" });
    },
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
      if (!expects.length) delete s.expects;
      if (!actions.length) delete s.actions;
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
