// Tiny demo app: login (cookie + localStorage), todos via fetch, one broken endpoint.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const todos = [{ id: 1, text: "Buy milk", done: false }];
const html = () => readFileSync(new URL("./index.html", import.meta.url));

export function start(port = 7100) {
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
      return res.end(html());
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

if (import.meta.url === `file://${process.argv[1]}`) start().then(() => console.log("http://localhost:7100"));
