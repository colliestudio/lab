import { createServer, type ServerResponse } from "node:http";
import { watch } from "node:fs";
import { join } from "node:path";
import { createBuilder, formatMessages, fmtBytes, htmlEscape, repoRoot } from "./build.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const RELOAD = `<script>new EventSource("/__events").onmessage=()=>location.reload()</script>`;

/** Serves the artifact built in memory on loopback only; rebuilds and reloads the page on changes to the dir or the kit. */
export async function dev(dir: string, port: number, host = "127.0.0.1") {
  if (!LOOPBACK.has(host)) throw new Error(`refusing to bind ${host}: dev serves on loopback only (the Mini's proxy reaches it)`);
  const builder = await createBuilder(dir, { dev: true });
  let page = "", building: Promise<void> = Promise.resolve();
  const clients = new Set<ServerResponse>();
  const rebuild = () => (building = building.then(async () => {
    const t = Date.now();
    const r = await builder.rebuild(RELOAD);
    if (r.errors.length) {
      const msg = await formatMessages(r.errors, "error");
      page = `<!doctype html><meta charset=utf-8><body style="font:14px ui-monospace,monospace;padding:2rem;background:#fff0f0"><h3>Build failed</h3><pre>${htmlEscape(msg)}</pre>${RELOAD}`;
      console.error(msg);
    } else {
      page = r.html;
      for (const m of r.collected.missing) console.warn(`warning: missing evidence ${m}`);
      console.log(`built ${fmtBytes(r.bytes)} in ${Date.now() - t} ms`);
    }
    for (const c of clients) c.write("data: reload\n\n");
  }));
  await rebuild();
  const server = createServer((req, res) => {
    if (req.url === "/__events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 500\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page);
  });
  await new Promise<void>((ok, bad) => { server.once("error", bad); server.listen(port, host, ok); });
  const addr = server.address() as { port: number };
  let timer: NodeJS.Timeout | undefined;
  const bump = (_: unknown, f: string | Buffer | null) => {
    if (f && /(^|[\\/])\./.test(String(f))) return;
    clearTimeout(timer); timer = setTimeout(rebuild, 120);
  };
  const watchers = [watch(dir, { recursive: true }, bump), watch(join(repoRoot, "artifact"), { recursive: true }, bump)];
  return { port: addr.port, host, close: async () => { watchers.forEach((w) => w.close()); clearTimeout(timer); for (const c of clients) c.end(); server.close(); server.closeAllConnections?.(); await builder.dispose(); } };
}
