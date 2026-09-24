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
    if (url.pathname === "/api/login" && req.method === "POST") {
      const { name } = await body();
      return json(200, { name }, { "set-cookie": `session=${Buffer.from(name).toString("base64")}; Path=/; HttpOnly` });
    }
    if (url.pathname === "/api/todos" && req.method === "GET") return json(200, todos);
    if (url.pathname === "/api/todos" && req.method === "POST") {
      const { text } = await body();
      await new Promise((r) => setTimeout(r, 300)); // feel like a real API
      const todo = { id: todos.length + 1, text, done: false };
      todos.push(todo);
      return json(201, todo);
    }
    if (url.pathname === "/api/report") return json(500, { error: "report service unavailable" });
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const record = process.argv.includes("--record");
  const port = record ? 7103 : 7100;
  start(port, { record }).then(() => console.log(`http://localhost:${port}` + (record ? "  (record mode)" : "")));
}
