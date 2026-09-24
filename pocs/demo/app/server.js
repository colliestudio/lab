// Tiny demo app: login (cookie + localStorage), todos via fetch, one broken endpoint.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { writeBundle } from "../src/bundle.js";
import { buildPlayer } from "../src/player.js";

// Record mode: the page gets the recorder as a plain <script> — no Playwright.
const RECORDER = () =>
  readFileSync(new URL("../node_modules/rrweb/umd/rrweb.min.js", import.meta.url), "utf8").replace(/\n\/\/# sourceMappingURL=.*$/, "") +
  "\n;" + readFileSync(new URL("../src/inpage.js", import.meta.url), "utf8");

const todos = [{ id: 1, text: "Buy milk", done: false }];

// Optional OpenTelemetry: a no-op unless the process was started with an SDK (e.g. --import auto-instrumentation).
const otel = await import("@opentelemetry/api").catch(() => null);
const tracer = otel?.trace.getTracer("todo-app");
const traceId = () => otel?.trace.getActiveSpan()?.spanContext().traceId ?? "-";
const log = (...a) => console.log(new Date().toISOString(), `trace=${traceId()}`, ...a);
// A fake DB call so traces have a custom child span.
const db = (name, fn) => tracer
  ? tracer.startActiveSpan(`db.${name}`, { attributes: { "db.system": "memory", "db.operation": name } }, async (span) => {
      try { return await fn(); } finally { span.end(); } })
  : fn();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A second tiny server the app calls out to — so the trace has an outbound HTTP hop.
const reports = createServer((req, res) => { setTimeout(() => { res.writeHead(503).end("report worker down"); }, 40); });
await new Promise((r) => reports.listen(0, r));
reports.unref(); // do not keep the process alive
const html = () => readFileSync(new URL("./index.html", import.meta.url));

export function start(port = 7100, { record = false } = {}) {
  const server = createServer(async (req, res) => {
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const body = async () => {
      let s = "";
      for await (const c of req) s += c;
      return s ? JSON.parse(s) : {};
    };
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      const page = html().toString();
      return res.end(record ? page.replace("<head>", '<head>\n<script src="/__replay/recorder.js"></script>') : page);
    }
    if (record && url.pathname === "/__replay/recorder.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(RECORDER());
    }
    if (record && url.pathname === "/__replay/save" && req.method === "POST") {
      const r = await body();
      const first = r.streams.rrweb.find((e) => e.type === 4);
      const { dir } = writeBundle("out", {
        name: r.name, url: r.url, recorder: "inpage",
        startedAt: new Date(r.startedAt).toISOString(),
        durationMs: (r.streams.rrweb.at(-1)?.timestamp ?? r.startedAt) - r.startedAt,
        viewport: { width: first?.data.width ?? 0, height: first?.data.height ?? 0 },
        colorScheme: "light",
      }, r.streams);
      buildPlayer(dir);
      return json(200, { player: `http://localhost:7101/${r.name}/index.html` });
    }
    if (url.pathname.startsWith("/api/")) log(req.method, url.pathname);
    if (url.pathname === "/api/login" && req.method === "POST") {
      const { name } = await body();
      await db("users.upsert", () => sleep(15));
      log("signed in", name);
      return json(200, { name }, { "set-cookie": `session=${Buffer.from(name).toString("base64")}; Path=/; HttpOnly` });
    }
    if (url.pathname === "/api/todos" && req.method === "GET") return json(200, await db("todos.select", async () => { await sleep(5); return todos; }));
    if (url.pathname === "/api/todos" && req.method === "POST") {
      const { text } = await body();
      await sleep(250); // validation, etc. — feel like a real API
      const todo = await db("todos.insert", async () => { await sleep(40); const t = { id: todos.length + 1, text, done: false }; todos.push(t); return t; });
      log("created todo", todo.id);
      return json(201, todo);
    }
    if (url.pathname === "/api/report") {
      await db("todos.select", () => sleep(8));
      const r = await fetch(`http://127.0.0.1:${reports.address().port}/render`, { method: "POST" });
      console.error(new Date().toISOString(), `trace=${traceId()}`, "report worker failed:", r.status, await r.text());
      return json(500, { error: "report service unavailable" });
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const record = process.argv.includes("--record");
  const port = Number(process.env.PORT) || (record ? 7103 : 7100);
  start(port, { record }).then(() => console.log(`http://localhost:${port}` + (record ? "  (record mode)" : "")));
}
