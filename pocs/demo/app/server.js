// Tiny demo app: login (cookie + localStorage), todos via fetch, one broken endpoint.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { writeBundle } from "../src/bundle.js";
import { buildPlayer } from "../src/player.js";

// Record mode: the page gets the recorder as a plain <script> — no Playwright.
const RECORDER = () =>
  readFileSync(new URL("../node_modules/rrweb/umd/rrweb.min.js", import.meta.url), "utf8").replace(/\n\/\/# sourceMappingURL=.*$/, "") +
  "\n;" + readFileSync(new URL("../src/inpage.js", import.meta.url), "utf8");

// SQLite so the runner can watch rows change (DB_PATH=file); in-memory otherwise.
const sql = new DatabaseSync(process.env.DB_PATH || ":memory:");
sql.exec(`
  drop table if exists todos; drop table if exists webhooks; drop table if exists deliveries;
  create table todos (id integer primary key, text text not null, done integer not null default 0);
  create table webhooks (id integer primary key, url text not null, secret text not null);
  create table deliveries (id integer primary key, webhook_id integer not null, event text not null,
    status text not null, attempts integer not null default 0, last_status integer, next_attempt_at text);
  insert into todos (text) values ('Buy milk');
`);
const listTodos = () => sql.prepare("select id, text, done = 1 as done from todos order by id").all().map((t) => ({ ...t, done: !!t.done }));

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
// ---- Webhooks: every created todo is delivered to each registered URL, signed, with retries ----
const BACKOFF = [300, 600, 1200]; // ms before attempts 2, 3, 4; then dead-lettered
function enqueue(event, payload) {
  for (const hook of sql.prepare("select * from webhooks").all()) {
    const { lastInsertRowid } = sql.prepare("insert into deliveries (webhook_id, event, status) values (?, ?, 'pending')").run(hook.id, event);
    log("delivery", lastInsertRowid, "queued for webhook", hook.id);
    // setTimeout keeps the active trace context, so retries stay in the originating request's trace.
    setTimeout(() => attempt(Number(lastInsertRowid), hook, event, payload), 50);
  }
}
async function attempt(id, hook, event, payload) {
  const n = sql.prepare("update deliveries set attempts = attempts + 1, status = 'sending' where id = ? returning attempts").get(id).attempts;
  const body = JSON.stringify({ id, event, data: payload });
  const sig = createHmac("sha256", hook.secret).update(body).digest("hex");
  const run = async () => {
    let status = 0;
    try {
      const res = await fetch(hook.url, { method: "POST", headers: { "content-type": "application/json", "x-webhook-event": event, "x-webhook-signature": "sha256=" + sig, "x-webhook-attempt": String(n) }, body });
      status = res.status;
    } catch {}
    if (status >= 200 && status < 300) {
      sql.prepare("update deliveries set status = 'delivered', last_status = ?, next_attempt_at = null where id = ?").run(status, id);
      return log("delivery", id, "delivered on attempt", n);
    }
    if (n > BACKOFF.length) {
      sql.prepare("update deliveries set status = 'dead', last_status = ?, next_attempt_at = null where id = ?").run(status, id);
      return console.error(new Date().toISOString(), `trace=${traceId()}`, "delivery", id, "dead after", n, "attempts, last status", status);
    }
    const wait = BACKOFF[n - 1];
    sql.prepare("update deliveries set status = 'retrying', last_status = ?, next_attempt_at = ? where id = ?").run(status, new Date(Date.now() + wait).toISOString(), id);
    console.warn(new Date().toISOString(), `trace=${traceId()}`, "delivery", id, "attempt", n, "got", status, "- retry in", wait, "ms");
    setTimeout(() => attempt(id, hook, event, payload), wait);
  };
  return tracer ? tracer.startActiveSpan(`webhook.deliver`, { attributes: { "delivery.id": id, "delivery.attempt": n } }, async (span) => { try { await run(); } finally { span.end(); } }) : run();
}

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
    if (url.pathname === "/api/todos" && req.method === "GET") return json(200, await db("todos.select", async () => { await sleep(5); return listTodos(); }));
    if (url.pathname === "/api/todos" && req.method === "POST") {
      const { text } = await body();
      await sleep(250); // validation, etc. — feel like a real API
      const todo = await db("todos.insert", async () => {
        await sleep(40);
        return sql.prepare("insert into todos (text) values (?) returning id, text, done = 1 as done").get(text);
      });
      todo.done = !!todo.done;
      log("created todo", todo.id);
      enqueue("todo.created", todo);
      return json(201, todo);
    }
    if (url.pathname === "/api/webhooks" && req.method === "POST") {
      const { url: target } = await body();
      const secret = "whsec_" + randomBytes(12).toString("hex");
      const hook = sql.prepare("insert into webhooks (url, secret) values (?, ?) returning id, url, secret").get(target, secret);
      log("webhook", hook.id, "registered", target);
      return json(201, hook);
    }
    if (url.pathname === "/api/deliveries" && req.method === "GET") {
      return json(200, sql.prepare("select id, webhook_id, event, status, attempts, last_status from deliveries order by id").all());
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
