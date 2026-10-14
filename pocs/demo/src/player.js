// Player: turns a bundle dir into one self-contained index.html.
// rrweb-player on the left; Steps / Console / Network / Storage on the right,
// all keyed to the same clock, so the panels follow playback and clicking a row seeks.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const PLAYER_JS = readFileSync(new URL("../node_modules/rrweb-player/dist/rrweb-player.umd.min.cjs", import.meta.url), "utf8");
const PLAYER_CSS = readFileSync(new URL("../node_modules/rrweb-player/dist/style.min.css", import.meta.url), "utf8");

export function buildPlayer(dir) {
  const read = (f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const data = {
    manifest: read("manifest.json"),
    rrweb: read("rrweb.json"),
    steps: read("steps.json"),
    console: read("console.json"),
    network: read("network.json"),
    storage: read("storage.json"),
    // Opt-in backend streams.
    server: existsSync(`${dir}/server.json`) ? read("server.json") : null,
    spans: existsSync(`${dir}/spans.json`) ? read("spans.json") : null,
    inbound: existsSync(`${dir}/inbound.json`) ? read("inbound.json") : null,
    db: existsSync(`${dir}/db.json`) ? read("db.json") : null,
  };
  const json = JSON.stringify(data).replaceAll("</", "<\\/");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${data.manifest.name} · replay</title>
<style>${PLAYER_CSS}</style>
<style>
  :root { color-scheme: light; --bg:#f1f5f9; --card:#fff; --ink:#0f172a; --mute:#64748b; --line:#e2e8f0; --hi:#fef3c7; --amber:#f59e0b; --red:#dc2626; --warn:#b45309; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--ink); }
  header { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: baseline; padding: 10px 16px; background: #0f172a; color: #f8fafc; }
  header h1 { font-size: 15px; margin: 0; }
  header span { color: #94a3b8; }
  header code { background: #1e293b; padding: 2px 6px; border-radius: 4px; color: #e2e8f0; }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 440px; gap: 12px; padding: 12px; height: calc(100vh - 44px); }
  #caption { padding: 8px 12px; margin-bottom: 8px; border-radius: 6px; background: #0f172a; color: #fff; font-weight: 600; min-height: 36px; font-size: 14px; }
  aside { display: flex; flex-direction: column; background: var(--card); border-radius: 8px; overflow: hidden; min-height: 0; border: 1px solid var(--line); }
  nav { display: flex; border-bottom: 1px solid var(--line); }
  nav button { all: unset; cursor: pointer; padding: 8px 12px; color: var(--mute); border-bottom: 2px solid transparent; }
  nav button.on { color: var(--ink); border-color: var(--amber); font-weight: 600; }
  nav button b { font-weight: 500; font-size: 11px; background: var(--line); border-radius: 8px; padding: 0 6px; margin-left: 4px; }
  nav button b.err { background: #fee2e2; color: var(--red); }
  .panel { flex: 1; overflow: auto; min-height: 0; }
  .row { display: grid; grid-template-columns: 44px 1fr; gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--line); cursor: pointer; font-family: ui-monospace, monospace; font-size: 12px; }
  .row:hover { background: #f8fafc; }
  .row.future { opacity: .35; }
  .row.now { background: var(--hi); }
  .row time { color: var(--mute); font-variant-numeric: tabular-nums; }
  .row .main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.step .main { font-family: ui-sans-serif, system-ui; font-size: 13px; white-space: normal; }
  .lv-error .main { color: var(--red); } .lv-warning .main { color: var(--warn); }
  .net { display: grid; grid-template-columns: 44px 44px 36px 1fr 52px; gap: 8px; }
  .net .st.bad { color: var(--red); font-weight: 700; }
  .detail { border-top: 2px solid var(--line); max-height: 45%; overflow: auto; padding: 8px 10px; font: 12px/1.4 ui-monospace, monospace; background: #f8fafc; }
  .detail h4 { margin: 8px 0 2px; font: 600 11px ui-sans-serif, system-ui; text-transform: uppercase; color: var(--mute); }
  .detail pre { margin: 0; white-space: pre-wrap; word-break: break-all; }
  table.kv { border-collapse: collapse; width: 100%; font: 12px ui-monospace, monospace; }
  table.kv td { border-bottom: 1px solid var(--line); padding: 4px 10px; vertical-align: top; word-break: break-all; }
  table.kv td:first-child { color: var(--mute); width: 35%; }
  .area { padding: 8px 10px 2px; font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--mute); }
  .srv { grid-template-columns: 44px 1fr 64px; } .srv.stderr .main { color: var(--red); }
  .tid { color: #7c3aed; font-size: 11px; }
  .wf { margin-top: 4px; font: 11px ui-monospace, monospace; }
  .wf .span { display: grid; grid-template-columns: 180px 1fr 52px; gap: 6px; align-items: center; padding: 1px 0; }
  .wf .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wf .track { position: relative; height: 12px; background: #eef2f7; border-radius: 2px; }
  .wf .bar { position: absolute; top: 1px; bottom: 1px; border-radius: 2px; background: #60a5fa; min-width: 2px; }
  .wf .bar.client { background: #94a3b8; } .wf .bar.db { background: #34d399; } .wf .bar.error { background: var(--red); }
  .wf .dur { color: var(--mute); text-align: right; }
  /* http stage: the story as cards, revealed as the clock passes them */
  #cards { height: calc(100vh - 170px); overflow: auto; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  .card { border: 1px solid var(--line); border-left: 4px solid #94a3b8; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; cursor: pointer; background: #fff; }
  .card.future { display: none; }
  .card.latest { box-shadow: 0 0 0 2px var(--amber); }
  .card.step { border: 0; background: #0f172a; color: #fff; font-weight: 600; }
  .card.api { border-left-color: #2563eb; } .card.in { border-left-color: #7c3aed; } .card.db { border-left-color: #059669; }
  .card.bad { border-left-color: var(--red); }
  .card .h { display: flex; gap: 8px; align-items: baseline; font-family: ui-monospace, monospace; font-size: 12px; }
  .card .h time { color: var(--mute); min-width: 44px; }
  .card .kind { font: 600 10px ui-sans-serif, system-ui; text-transform: uppercase; color: var(--mute); min-width: 56px; }
  .card .st { font-weight: 700; } .card .st.bad { color: var(--red); } .card .st.ok { color: #059669; }
  .card pre { margin: 6px 0 0; font: 11px/1.35 ui-monospace, monospace; color: #334155; white-space: pre-wrap; max-height: 120px; overflow: auto; }
  .card .diff { font: 11px ui-monospace, monospace; margin-top: 4px; } .card .diff b { color: #059669; font-weight: 600; } .card .diff s { color: var(--red); }
  #clock { display: flex; gap: 10px; align-items: center; padding: 8px 4px; }
  #clock button { font: inherit; border: 0; border-radius: 6px; padding: 5px 12px; background: #0f172a; color: #fff; cursor: pointer; }
  #clock input[type=range] { flex: 1; accent-color: var(--amber); }
  #clock span { font: 12px ui-monospace, monospace; color: var(--mute); min-width: 90px; text-align: right; }
  .changed td { background: var(--hi); transition: background 1s; }
  .empty { padding: 6px 10px; color: var(--mute); }
  @media (max-width: 1000px) { main { grid-template-columns: 1fr; height: auto; } aside { height: 60vh; } }
</style>
</head>
<body>
<header>
  <h1 id="title"></h1><span id="meta"></span>
  <span>deep debug: <code>npx playwright show-trace trace.zip</code></span>
</header>
<main>
  <section><div id="caption"></div><div id="stage"></div></section>
  <aside>
    <nav id="tabs"></nav>
    <div class="panel" id="panel"></div>
    <div class="detail" id="detail" hidden></div>
  </aside>
</main>
<script>${PLAYER_JS}</script>
<script>
const D = ${json};
const $ = (id) => document.getElementById(id);
const HTTP = D.manifest.stage === "http" || !D.rrweb.length;
const t0 = HTTP ? Date.parse(D.manifest.startedAt) : D.rrweb[0].timestamp;
const rel = (t) => t - t0;
const fmt = (ms) => (ms / 1000).toFixed(1) + "s";
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const path = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
let now = 0, tab = "steps", selected = null;

$("title").textContent = D.manifest.name;
$("meta").textContent = new Date(D.manifest.startedAt).toLocaleString() + " · " + fmt(D.manifest.durationMs) + (HTTP ? " · backend demo" : " · " + D.manifest.viewport.width + "×" + D.manifest.viewport.height);

const stage = $("stage");
let seek;
if (!HTTP) {
  const width = Math.min(stage.clientWidth || 900, 1280);
  const player = new (rrwebPlayer.default ?? rrwebPlayer)({
    target: stage,
    props: { events: D.rrweb, width, height: Math.round(width * 0.625), autoPlay: false, showController: true, tags: { step: "#f59e0b" } },
  });
  seek = (t) => { player.goto(Math.max(0, rel(t) - 50), true); };
  player.addEventListener("ui-update-current-time", ({ payload }) => setNow(payload));
} else {
  seek = httpStage();
}

// ---- http stage: API calls, inbound webhooks and DB changes as cards on one clock ----
function httpStage() {
  const total = D.manifest.durationMs;
  const items = [
    ...D.steps.map((x) => ({ t: x.t, kind: "step", x })),
    ...D.network.map((x, i) => ({ t: x.t, kind: "api", x, i })),
    ...(D.inbound || []).map((x) => ({ t: x.t, kind: "in", x })),
    // One card per (moment, table): row changes seen in the same poll.
    ...Object.values((D.db || []).filter((e) => e.op !== "snapshot").reduce((g, e) => ((g[e.t + e.table] ??= { t: e.t, kind: "db", x: [] }).x.push(e), g), {})),
  ].sort((a, b) => a.t - b.t || (a.kind === "step" ? -1 : 1));
  const pretty = (b) => { try { return JSON.stringify(JSON.parse(b), null, 1).slice(0, 600); } catch { return String(b ?? "").slice(0, 600); } };
  const val = (v) => (v === null ? "null" : typeof v === "string" && v.length > 28 ? JSON.stringify(v.slice(0, 26) + "…") : JSON.stringify(v));
  const card = ({ t, kind, x, i }) => {
    const time = "<time>" + fmt(rel(t)) + "</time>";
    if (kind === "step") return '<div class="card step" data-t="' + t + '">' + esc(x.text) + "</div>";
    if (kind === "api") {
      const bad = x.error || x.status >= 400;
      return '<div class="card api ' + (bad ? "bad" : "") + '" data-t="' + t + '" data-i="' + i + '"><div class="h">' + time + '<span class="kind">API</span><b>' + x.method + "</b> " + esc(path(x.url)) + ' → <span class="st ' + (bad ? "bad" : "ok") + '">' + (x.status ?? "…") + '</span> <span style="color:var(--mute)">' + (x.duration ?? "") + "ms</span></div>" +
        (x.requestBody ? "<pre>→ " + esc(pretty(x.requestBody)) + "</pre>" : "") + (x.responseBody ? "<pre>← " + esc(pretty(x.responseBody)) + "</pre>" : "") + "</div>";
    }
    if (kind === "in") {
      const bad = x.status >= 300;
      const h = x.headers;
      return '<div class="card in ' + (bad ? "bad" : "") + '" data-t="' + t + '"' + (x.traceId ? ' data-trace="' + x.traceId + '"' : "") + '><div class="h">' + time + '<span class="kind">Received</span><b>' + x.method + "</b> " + esc(x.path) + (h["x-webhook-event"] ? " · " + esc(h["x-webhook-event"]) : "") + (h["x-webhook-attempt"] ? " · attempt " + esc(h["x-webhook-attempt"]) : "") + ' → answered <span class="st ' + (bad ? "bad" : "ok") + '">' + x.status + "</span></div>" +
        (h["x-webhook-signature"] ? '<pre>signature ' + esc(h["x-webhook-signature"].slice(0, 30)) + "…</pre>" : "") + (Number(h["x-webhook-attempt"] || 1) > 1 ? "" : "<pre>" + esc(pretty(x.body)) + "</pre>") + "</div>";
    }
    return '<div class="card db" data-t="' + t + '"><div class="h">' + time + '<span class="kind">DB</span>' + x.map((e) => e.table).filter((v, i, a) => a.indexOf(v) === i).join(", ") + "</div>" + x.map((e) =>
      '<div class="diff">' + (e.op === "insert" ? "<b>+ insert</b> " + e.table + " #" + e.key + " " + esc(Object.entries(e.after).map(([k, v]) => k + "=" + val(v)).join(" "))
        : e.op === "delete" ? "<s>− delete</s> " + e.table + " #" + e.key
        : "~ " + e.table + " #" + e.key + " " + esc(e.changed.map((c) => c + ": " + val(e.before[c]) + " → ").join("")).split(" → ").map((part, j) => j < e.changed.length ? part + " → <b>" + esc(val(e.after[e.changed[j]])) + "</b>" : "").join("  ")) + "</div>").join("") + "</div>";
  };
  stage.innerHTML = '<div id="cards">' + items.map(card).join("") + '</div><div id="clock"><button id="play">▶ Play</button><input id="scrub" type="range" min="0" max="' + total + '" value="0" step="10"><span id="tlabel"></span><select id="speed"><option>1</option><option selected>2</option><option>4</option></select>×</div>';
  const cards = [...stage.querySelectorAll(".card")];
  let playing = false, last;
  const render = () => {
    let latest;
    for (const c of cards) { const f = rel(Number(c.dataset.t)) > now; c.classList.toggle("future", f); c.classList.remove("latest"); if (!f) latest = c; }
    latest?.classList.add("latest");
    if (latest !== render.prev) latest?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    render.prev = latest;
    $("scrub").value = now;
    $("tlabel").textContent = fmt(now) + " / " + fmt(total);
  };
  const tick = (ts) => {
    if (!playing) return;
    if (last != null) now = Math.min(total, now + (ts - last) * Number($("speed").value));
    last = ts;
    setNow(now); render();
    if (now >= total) { playing = false; $("play").textContent = "▶ Play"; return; }
    requestAnimationFrame(tick);
  };
  $("play").onclick = () => { playing = !playing; last = null; if (playing && now >= total) now = 0; $("play").textContent = playing ? "❚❚ Pause" : "▶ Play"; if (playing) requestAnimationFrame(tick); };
  $("scrub").oninput = () => { now = Number($("scrub").value); setNow(now); render(); };
  $("cards").onclick = (e) => {
    const c = e.target.closest(".card"); if (!c) return;
    if (c.dataset.i) { tab = "network"; selected = Number(c.dataset.i); drawTabs(); draw(); showRequest(selected); }
    else if (c.dataset.trace) { const i = D.network.findIndex((n) => n.traceId === c.dataset.trace); if (i >= 0) { tab = "network"; selected = i; drawTabs(); draw(); showRequest(i); } }
  };
  setTimeout(() => { setNow(0); render(); });
  return (t) => { now = Math.max(0, rel(t)); setNow(now); render(); };
}

const errors = D.console.filter((c) => c.level === "error").length;
const failed = D.network.filter((n) => n.error || n.status >= 400).length;
const TABS = [
  ["steps", "Steps", D.steps.length],
  ["console", "Console", D.console.length, errors],
  ["network", "Network", D.network.length, failed],
  ["storage", "Storage", null],
  ...(D.server ? [["server", "Server", D.server.length, D.server.filter((l) => l.stream === "stderr").length]] : []),
];
function drawTabs() {
  $("tabs").innerHTML = TABS.map(([k, label, n, bad]) =>
    '<button data-k="' + k + '" class="' + (k === tab ? "on" : "") + '">' + label +
    (n != null ? '<b class="' + (bad ? "err" : "") + '">' + (bad ? bad + "/" : "") + n + "</b>" : "") + "</button>").join("");
}
$("tabs").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; tab = b.dataset.k; selected = null; drawTabs(); draw(); };

// Rows are drawn once per tab; playback only toggles classes (redrawing every tick breaks clicks).
function draw() {
  const P = $("panel");
  $("detail").hidden = true;
  if (tab === "steps") {
    P.innerHTML = D.steps.map((s) => '<div class="row step" data-t="' + s.t + '"><time>' + fmt(rel(s.t)) + '</time><div class="main">' + esc(s.text) + "</div></div>").join("");
  } else if (tab === "console") {
    P.innerHTML = D.console.map((c) => '<div class="row lv-' + c.level + '" data-t="' + c.t + '" title="' + esc(c.stack || c.source) + '"><time>' + fmt(rel(c.t)) + '</time><div class="main">' + (c.level === "log" ? "" : "[" + c.level + "] ") + esc(c.text) + "</div></div>").join("") || '<div class="empty">No console output</div>';
  } else if (tab === "server") {
    P.innerHTML = D.server.map((l) => '<div class="row srv ' + l.stream + '" data-t="' + l.t + '"' + (l.traceId ? ' data-trace="' + l.traceId + '"' : "") + '><time>' + fmt(rel(l.t)) + '</time><div class="main">' + esc(l.text) + '</div><span class="tid">' + (l.traceId ? l.traceId.slice(0, 8) : "") + "</span></div>").join("");
  } else if (tab === "network") {
    P.innerHTML = D.network.map((n, i) => {
      const bad = n.error || n.status >= 400;
      return '<div class="row net" data-t="' + n.t + '" data-i="' + i + '"><time>' + fmt(rel(n.t)) + '</time><span>' + n.method + '</span><span class="st ' + (bad ? "bad" : "") + '">' + (n.status ?? (n.error ? "ERR" : "…")) + '</span><span class="main">' + esc(path(n.url)) + (n.traceId && D.spans?.some((x) => x.traceId === n.traceId) ? ' <span class="tid">⧉ trace</span>' : "") + '</span><span style="color:var(--mute)">' + (n.duration != null ? n.duration + "ms" : "") + "</span></div>";
    }).join("");
    if (selected != null) showRequest(selected);
  }
  sync(true);
}

// Past rows normal, future rows dimmed, the latest past row highlighted.
function sync(scroll) {
  if (tab === "storage") return drawStorage();
  const rows = [...$("panel").querySelectorAll(".row")];
  let current;
  for (const row of rows) {
    const future = rel(Number(row.dataset.t)) > now;
    row.classList.toggle("future", future);
    row.classList.remove("now");
    if (!future) current = row;
  }
  current?.classList.add("now");
  if (scroll && current !== lastCurrent) current?.scrollIntoView({ block: "nearest" });
  lastCurrent = current;
}
let lastCurrent;

// Storage is event-sourced: replay every write up to "now" to get the state at that moment.
function drawStorage() {
  const state = { cookie: [], local: {}, session: {} };
  const recent = new Set();
  for (const e of D.storage) {
    if (rel(e.t) > now) break;
    if (e.area === "cookie") state.cookie = e.value;
    else if (e.op === "snapshot") state[e.area] = { ...e.value };
    else if (e.op === "set") state[e.area][e.key] = e.value;
    else if (e.op === "remove") delete state[e.area][e.key];
    else if (e.op === "clear") state[e.area] = {};
    if (now - rel(e.t) < 1500) recent.add(e.area + ":" + (e.key ?? "*"));
  }
  const table = (area, entries) => '<div class="area">' + area + '</div>' + (entries.length
    ? '<table class="kv">' + entries.map(([k, v, hot]) => '<tr class="' + (hot ? "changed" : "") + '"><td>' + esc(k) + "</td><td>" + esc(v) + "</td></tr>").join("") + "</table>"
    : '<div class="empty">empty</div>');
  $("panel").innerHTML =
    table("Cookies", state.cookie.map((c) => [c.name, c.value + (c.httpOnly ? "  (HttpOnly)" : ""), recent.has("cookie:*")])) +
    table("localStorage", Object.entries(state.local).map(([k, v]) => [k, v, recent.has("local:" + k)])) +
    table("sessionStorage", Object.entries(state.session).map(([k, v]) => [k, v, recent.has("session:" + k)]));
}

function showRequest(i) {
  const n = D.network[i];
  const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
  const headers = (h) => Object.entries(h || {}).map(([k, v]) => k + ": " + v).join("\\n");
  const d = $("detail");
  d.hidden = false;
  d.innerHTML = "<b>" + n.method + " " + esc(n.url) + "</b> → " + (n.status ?? n.error) + backend(n) +
    (n.requestBody ? "<h4>Request body</h4><pre>" + esc(pretty(n.requestBody)) + "</pre>" : "") +
    (n.responseBody != null && n.type !== "document" ? "<h4>Response body</h4><pre>" + esc(pretty(n.responseBody)) + "</pre>" : "") +
    "<h4>Response headers</h4><pre>" + esc(headers(n.responseHeaders)) + "</pre>" +
    "<h4>Request headers</h4><pre>" + esc(headers(n.requestHeaders)) + "</pre>";
}

// Backend for one request: the browser request is the root span; server spans hang off it by parentSpanId.
function backend(n) {
  if (!n.traceId || !D.spans) return "";
  // The catcher's received requests join the tree too: their traceparent names the outbound span as parent.
  const spans = [...D.spans.filter((x) => x.traceId === n.traceId),
    ...(D.inbound || []).filter((x) => x.traceId === n.traceId).map((x, k) => ({ spanId: "in" + k, parentSpanId: x.parentSpanId, name: "receiver answered " + x.status, start: x.t, end: x.t + 1, kind: "receiver", status: x.status >= 300 ? "error" : undefined, attributes: {} }))];
  const logs = (D.server || []).filter((l) => l.traceId === n.traceId);
  if (!spans.length && !logs.length) return "";
  const start = n.t, end = Math.max(n.end ?? n.t, ...spans.map((x) => x.end));
  const span = end - start || 1;
  const kids = (id) => spans.filter((x) => x.parentSpanId === id).sort((a, b) => a.start - b.start);
  const rows = [];
  const walk = (x, depth) => { rows.push([x, depth]); kids(x.spanId).forEach((k) => walk(k, depth + 1)); };
  const root = { spanId: n.spanId, name: (n.type === "api" ? "client " : "browser ") + n.method + " " + path(n.url), start: n.t, end: n.end ?? n.t, kind: "browser" };
  walk(root, 0);
  // Spans whose parent we never saw (shouldn't happen) still get shown.
  spans.filter((x) => !rows.some(([r]) => r === x)).forEach((x) => walk(x, 1));
  const cls = (x) => (x.status === "error" ? "error" : x.kind === "browser" || x.kind === 3 ? "client" : x.name.startsWith("db.") ? "db" : "");
  const label = (x) => x.kind === 2 ? (x.service || "server") + " " + x.name + " " + (x.attributes["url.path"] || x.attributes["http.target"] || "") : x.kind === 3 ? "→ " + x.name + " " + (x.attributes["url.full"] || x.attributes["http.url"] || "") : x.name;
  return "<h4>Backend trace " + n.traceId.slice(0, 8) + '</h4><div class="wf">' + rows.map(([x, depth]) =>
    '<div class="span"><span class="lbl" style="padding-left:' + depth * 10 + 'px" title="' + esc(label(x)) + '">' + esc(label(x)) + '</span><span class="track"><span class="bar ' + cls(x) + '" style="left:' + ((x.start - start) / span * 100) + "%;width:" + ((x.end - x.start) / span * 100) + '%"></span></span><span class="dur">' + (x.end - x.start) + "ms</span></div>").join("") + "</div>" +
    (logs.length ? "<h4>Server logs</h4><pre>" + logs.map((l) => (l.stream === "stderr" ? "! " : "  ") + esc(l.text)).join("\\n") + "</pre>" : "");
}

$("panel").onclick = (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  seek(Number(row.dataset.t));
  if (row.dataset.i) { selected = Number(row.dataset.i); showRequest(selected); }
  if (row.dataset.trace) {
    const i = D.network.findIndex((n) => n.traceId === row.dataset.trace);
    if (i >= 0) { tab = "network"; selected = i; drawTabs(); draw(); showRequest(i); }
  }
};

function setNow(ms) {
  now = ms;
  let step;
  for (const s of D.steps) if (rel(s.t) <= now) step = s;
  $("caption").textContent = step ? step.text : "";
  sync(true);
}

drawTabs();
draw();
</script>
</body>
</html>
`;
  writeFileSync(`${dir}/index.html`, html);
  return `${dir}/index.html`;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(buildPlayer(process.argv[2]));
