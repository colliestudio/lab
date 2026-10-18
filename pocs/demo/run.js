// Runner: starts the app as a child process, records a journey, and (opt-in) captures the backend.
//   node run.js [--journey todo|webhooks] [--logs|--otel]
//   --logs   server stdout/stderr on the replay clock                  → server.json
//   --otel   + OpenTelemetry spans via a local OTLP receiver           → spans.json
// Always available to journeys (streams only written if used):
//   r.catcher  a programmable webhook receiver                          → inbound.json
//   DB watch   row-level changes in the app's SQLite file                → db.json
// The app needs no code change for --otel: it is started with Node's zero-code auto-instrumentation.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { launchChrome } from "./src/chrome.js";
import { record } from "./src/recorder.js";
import { buildPlayer } from "./src/player.js";
import { mkdirSync, rmSync } from "node:fs";
import { catcher, dbWatch } from "./src/backend.js";

const journeyName = process.argv[process.argv.indexOf("--journey") + 1] && process.argv.includes("--journey") ? process.argv[process.argv.indexOf("--journey") + 1] : "todo";
const { default: journey, stage = "ui" } = await import(`./journeys/${journeyName}.js`);

const otel = process.argv.includes("--otel");
const logs = otel || process.argv.includes("--logs");
const APP_PORT = 7105, OTLP_PORT = 7104;
const name = journeyName + "-" + (otel ? "otel" : logs ? "logs" : "plain");
mkdirSync("out/.tmp", { recursive: true });
const DB_PATH = "out/.tmp/app.db";
rmSync(DB_PATH, { force: true });

// ---- OTLP/HTTP JSON receiver: the app's exporter posts batches here ----
const spans = [];
let otlp;
if (otel) {
  const nanosToMs = (n) => Number(BigInt(n) / 1000000n);
  const attrs = (list = []) => Object.fromEntries(list.map((a) => [a.key, Object.values(a.value ?? {})[0]]));
  otlp = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    try {
      for (const rs of JSON.parse(body).resourceSpans ?? []) {
        const service = attrs(rs.resource?.attributes)["service.name"];
        for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) {
          spans.push({
            traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || undefined,
            name: s.name, kind: s.kind, service, scope: ss.scope?.name,
            start: nanosToMs(s.startTimeUnixNano), end: nanosToMs(s.endTimeUnixNano),
            status: s.status?.code === 2 ? "error" : undefined, attributes: attrs(s.attributes),
          });
        }
      }
    } catch (e) { console.error("otlp parse", e.message); }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  }).listen(OTLP_PORT);
}

// ---- the app, as a child process ----
const env = { ...process.env, PORT: String(APP_PORT), DB_PATH, NODE_NO_WARNINGS: "1" };
const args = ["app/server.js"];
if (otel) {
  // ESM apps: the loader hook lets instrumentation patch `import { createServer } from "node:http"`.
  args.unshift("--experimental-loader", "@opentelemetry/instrumentation/hook.mjs", "--import", "@opentelemetry/auto-instrumentations-node/register");
  Object.assign(env, {
    OTEL_SERVICE_NAME: "todo-app",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${OTLP_PORT}`,
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_BSP_SCHEDULE_DELAY: "200",
    OTEL_NODE_ENABLED_INSTRUMENTATIONS: "http,undici",
  });
}
const app = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
const server = [];
for (const stream of ["stdout", "stderr"]) {
  createInterface({ input: app[stream] }).on("line", (text) => {
    const t = Date.now();
    if (!logs) return;
    const trace = /trace=([0-9a-f]{32})/.exec(text)?.[1];
    // Drop the app's own ISO timestamp/trace prefix; the player shows time + a trace link.
    server.push({ t, stream, text: text.replace(/^\S+Z trace=\S+ /, ""), traceId: trace });
  });
}
for (let i = 0; ; i++) {
  try { await fetch(`http://localhost:${APP_PORT}/`); break; } catch { if (i > 100) throw new Error("app did not start"); await new Promise((r) => setTimeout(r, 100)); }
}

// ---- record ----
const t0 = Date.now();
const browser = await launchChrome();
const r = await record(browser, { name, stage, url: `http://localhost:${APP_PORT}` });
r.catcher = await catcher();
const watch = dbWatch(DB_PATH);
watch.start();
await journey(r);
const { dir, manifest } = await r.finish("out", async () => {
  if (otel) await new Promise((res) => setTimeout(res, 600)); // let the exporter's last batch land
  watch.stop();
  r.catcher.close();
  return {
    inbound: r.catcher.inbound,
    db: watch.events,
    ...(logs ? { server: server.filter((l) => l.t >= t0) } : {}),
    ...(otel ? { spans: spans.filter((s) => s.start >= t0 - 1000) } : {}),
  };
});
await browser.close();
app.kill();
otlp?.close();
console.log(manifest.counts);
console.log("player:", buildPlayer(dir));
process.exit(0); // keep-alive sockets on the receiver would otherwise hold the process open
