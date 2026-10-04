// `recap serve`: local viewer + API on 127.0.0.1, live reload over SSE when the bundle changes.
import { createServer, type ServerResponse } from "node:http";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Doc } from "../model.ts";
import { loadBundle } from "./_stub-load.ts"; // MERGE: swap for "../parse/index.ts"
import { appendComment, commentsFile, openBundle, readComments, type BundleReader } from "./bundle.ts";
import { guard, handleApi, injectBoot, send, viewerTemplate, type DocSource } from "./http.ts";

export interface Running { url: string; close(): Promise<void> }

export async function startServe(bundlePath: string, opts: { port?: number; host?: string; log?: (s: string) => void } = {}): Promise<Running> {
  const path = resolve(bundlePath);
  const log = opts.log ?? ((s) => console.error(s));
  let doc: Doc = (await loadBundle(path)).doc;
  let reader: BundleReader = openBundle(path);
  const cFile = commentsFile(path);
  const clients = new Set<ServerResponse>();

  const src: DocSource = {
    doc: () => doc,
    file: (p) => reader.read(p),
    comments: () => readComments(cFile, reader),
    addComment: (c) => { appendComment(cFile, c, reader); },
  };

  // Live reload: dir bundle → doc.md (and changes.patch) inside it; zip bundle → the file itself.
  // Watch the parent dir: editors save by rename, which detaches a watch on the file.
  const watchDir = reader.isDir ? path : dirname(path);
  const relevant = (f: string | null) => reader.isDir ? f === "doc.md" || f === "changes.patch" : f === basename(path);
  let timer: NodeJS.Timeout | undefined;
  const watcher: FSWatcher = watch(watchDir, (_ev, f) => {
    if (!relevant(f)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        if (!reader.isDir) reader = openBundle(path);
        doc = (await loadBundle(path)).doc;
        for (const c of clients) c.write("event: reload\ndata: {}\n\n");
        log(`reloaded ${basename(path)}`);
      } catch (e) { log(`reload failed: ${(e as Error).message}`); }
    }, 80);
  });

  const server = createServer(guard(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    if (p === "/" || p === "/index.html") {
      return send(res, 200, injectBoot(viewerTemplate(), { doc, api: "/api" }, "/api/events"), "text/html; charset=utf-8");
    }
    if (p === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hi\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (p.startsWith("/api/") && await handleApi(req, res, p.slice(5), src)) return;
    send(res, 404, "not found");
  }));

  await new Promise<void>((ok, err) => { server.once("error", err); server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", ok); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}/`,
    close: () => new Promise<void>((ok) => {
      clearTimeout(timer);
      watcher.close();
      for (const c of clients) c.end();
      server.close(() => ok());
      server.closeAllConnections();
    }),
  };
}
