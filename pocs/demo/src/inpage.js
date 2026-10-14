// In-page recorder: no Playwright, no driver. Load after rrweb's UMD in any page.
// Captures the same five streams as recorder.js, from inside the page:
//   rrweb DOM · console (patched methods + error events) · network (patched fetch/XHR
//   + the navigation entry) · storage (Storage.prototype patch + document.cookie polling) · steps.
// Survives full page loads by parking the buffer in sessionStorage on pagehide.
// Limits vs Playwright: no HttpOnly cookies, no static-asset requests, no response
// headers the server hides from CORS; timings are from the page's own clock.
(() => {
  if (window.__replayInpage) return;
  window.__replayInpage = true;
  const KEY = "__replay";
  const origSet = Storage.prototype.setItem, origGet = Storage.prototype.getItem, origRemove = Storage.prototype.removeItem;
  const now = () => Date.now();
  const BODY_LIMIT = 64 * 1024;
  const cap = (s) => (s && s.length > BODY_LIMIT ? s.slice(0, BODY_LIMIT) + "…[truncated]" : s);

  let rec = null;           // { id, name, startedAt, streams }
  let stopRrweb = null;
  const saved = origGet.call(sessionStorage, KEY);
  if (saved) { rec = JSON.parse(saved); origRemove.call(sessionStorage, KEY); }
  const push = (stream, entry) => rec && rec.streams[stream].push(entry);

  // ---------- console + errors ----------
  const fmt = (a) => { if (typeof a === "string") return a; try { return JSON.stringify(a); } catch { return String(a); } };
  for (const [method, level] of [["log", "log"], ["info", "info"], ["warn", "warning"], ["error", "error"], ["debug", "debug"]]) {
    const orig = console[method];
    console[method] = function (...args) { push("console", { t: now(), level, text: args.map(fmt).join(" ") }); return orig.apply(this, args); };
  }
  addEventListener("error", (e) => push("console", { t: now(), level: "error", text: "Uncaught " + (e.error?.name ?? "Error") + ": " + e.message, stack: e.error?.stack }));
  addEventListener("unhandledrejection", (e) => push("console", { t: now(), level: "error", text: "Uncaught (in promise) " + (e.reason?.name ?? "") + ": " + (e.reason?.message ?? e.reason), stack: e.reason?.stack }));

  // ---------- network ----------
  let nextId = 1;
  const headersObj = (h) => { const o = {}; h?.forEach?.((v, k) => (o[k] = v)); return o; };
  const origFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const req = new Request(input, init);
    const entry = { id: nextId++, t: now(), method: req.method, url: req.url, type: "fetch", requestHeaders: headersObj(req.headers), requestBody: typeof init.body === "string" ? cap(init.body) : undefined };
    push("network", entry);
    try {
      const res = await origFetch.call(this, input, init);
      entry.end = now(); entry.duration = entry.end - entry.t; entry.status = res.status; entry.responseHeaders = headersObj(res.headers);
      res.clone().text().then((b) => (entry.responseBody = cap(b))).catch(() => {});
      return res;
    } catch (err) {
      entry.end = now(); entry.duration = entry.end - entry.t; entry.error = String(err);
      throw err;
    }
  };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__r = { method, url: new URL(url, location.href).href }; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    const entry = { id: nextId++, t: now(), method: this.__r?.method, url: this.__r?.url, type: "xhr", requestBody: typeof body === "string" ? cap(body) : undefined };
    push("network", entry);
    this.addEventListener("loadend", () => {
      entry.end = now(); entry.duration = entry.end - entry.t; entry.status = this.status || undefined;
      if (!this.status) entry.error = "failed";
      try { entry.responseBody = cap(this.responseText); } catch {}
    });
    return XS.apply(this, arguments);
  };
  // The document itself: the page can't see its own request, but the navigation entry has url/status/timing.
  const logNavigation = () => {
    const nav = performance.getEntriesByType("navigation")[0];
    push("network", { id: nextId++, t: Math.round(performance.timeOrigin + (nav?.startTime ?? 0)), method: "GET", url: location.href, type: "document", status: nav?.responseStatus, duration: Math.round(nav?.duration || nav?.responseEnd || 0) });
  };

  // ---------- storage + cookies ----------
  const area = (s) => (s === localStorage ? "local" : "session");
  const P = Storage.prototype;
  const set = P.setItem, remove = P.removeItem, clear = P.clear;
  P.setItem = function (k, v) { push("storage", { t: now(), area: area(this), op: "set", key: k, value: String(v) }); return set.call(this, k, v); };
  P.removeItem = function (k) { push("storage", { t: now(), area: area(this), op: "remove", key: k }); return remove.call(this, k); };
  P.clear = function () { push("storage", { t: now(), area: area(this), op: "clear" }); return clear.call(this); };
  const dump = (s) => Object.fromEntries(Object.keys(s).filter((k) => k !== KEY).map((k) => [k, s.getItem(k)]));
  let lastCookie = null;
  const cookieCheck = () => {
    if (!rec || document.cookie === lastCookie) return;
    lastCookie = document.cookie;
    const value = document.cookie ? document.cookie.split("; ").map((c) => { const i = c.indexOf("="); return { name: c.slice(0, i), value: c.slice(i + 1) }; }) : [];
    push("storage", { t: now(), area: "cookie", op: "snapshot", value });
  };
  setInterval(cookieCheck, 300);

  // ---------- control ----------
  function begin(afterNavigation) {
    stopRrweb = rrweb.record({
      emit: (e) => push("rrweb", e),
      sampling: { mousemove: 50, scroll: 150 },
      maskInputOptions: { password: true },
      blockClass: "replay-widget",
    });
    if (afterNavigation) logNavigation();
    push("storage", { t: now(), area: "local", op: "snapshot", value: dump(localStorage) });
    push("storage", { t: now(), area: "session", op: "snapshot", value: dump(sessionStorage) });
    lastCookie = null;
    cookieCheck();
  }
  const api = {
    start(name = "manual-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")) {
      if (rec) return;
      rec = { name, startedAt: now(), url: location.origin, streams: { rrweb: [], console: [], network: [], storage: [], steps: [] } };
      begin();
      render();
    },
    say(text) {
      if (!rec) return;
      push("steps", { t: now(), text });
      rrweb.record.addCustomEvent("step", { text });
      render();
    },
    async stop() {
      if (!rec) return;
      stopRrweb?.();
      const r = rec; rec = null;
      render();
      const res = await origFetch("/__replay/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) });
      const { player } = await res.json();
      widget.querySelector(".msg").innerHTML = 'Saved → <a href="' + player + '" target="_blank">' + player + "</a>";
      return player;
    },
    get recording() { return !!rec; },
  };
  window.replay = api;
  // Park the buffer across full page loads.
  addEventListener("pagehide", () => { if (rec) origSet.call(sessionStorage, KEY, JSON.stringify(rec)); });

  // ---------- widget (blocked from the recording by blockClass) ----------
  const widget = document.createElement("div");
  widget.className = "replay-widget";
  widget.innerHTML = `<style>
    .replay-widget{position:fixed;left:16px;bottom:16px;z-index:2147483647;font:13px system-ui;background:#0f172a;color:#fff;border-radius:10px;padding:8px;display:flex;gap:6px;align-items:center;box-shadow:0 4px 16px #0005}
    .replay-widget button{font:inherit;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;background:#334155;color:#fff}
    .replay-widget .rec{background:#dc2626}.replay-widget input{font:inherit;padding:5px 8px;border-radius:6px;border:0;width:220px}
    .replay-widget .msg a{color:#fcd34d}</style>
    <span class="dot"></span><button class="go"></button><input class="cap" placeholder="Caption for this step…"><button class="step">Step</button><span class="msg"></span>`;
  const $ = (s) => widget.querySelector(s);
  function render() {
    $(".go").textContent = rec ? "■ Stop & save" : "● Record";
    $(".go").className = "go " + (rec ? "" : "rec");
    $(".dot").textContent = rec ? "🔴 " + rec.streams.steps.length + " steps" : "";
    $(".cap").style.display = $(".step").style.display = rec ? "" : "none";
  }
  $(".go").onclick = () => (rec ? api.stop() : api.start());
  const addStep = () => { const v = $(".cap").value.trim(); if (v) { api.say(v); $(".cap").value = ""; } };
  $(".step").onclick = addStep;
  $(".cap").onkeydown = (e) => { if (e.key === "Enter") addStep(); };
  const mount = () => { document.documentElement.append(widget); render(); if (rec) begin(true); };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount); else mount();
})();
