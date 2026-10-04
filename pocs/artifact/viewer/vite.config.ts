import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// Dev only: a mock of the serve API backed by the real parser, so the viewer's fetch + comments paths work without
// `recap serve`. /dev-api/<bundle>/{doc,files/<path>,comments}; <bundle> = a repo-relative bundle path
// (default samples/recap-lab.review, see viewer/src/boot.ts). Comments stay in memory.
function devApi(): Plugin {
  const comments = new Map<string, unknown[]>();
  return {
    name: "recap-dev-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const m = req.url?.match(/^\/dev-api\/([^/]+)\/(.*?)(\?.*)?$/);
        if (!m) return next();
        const name = decodeURIComponent(m[1]);
        const rest = decodeURIComponent(m[2]);
        const path = resolve(repoRoot, name);
        if (!path.startsWith(repoRoot + "/") || !existsSync(path)) { res.statusCode = 404; return res.end("no bundle " + name); }
        const { loadBundle } = await import("../src/parse/index.ts");
        const b = await loadBundle(path);
        const json = (v: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
        if (rest === "doc") return json(b.doc);
        if (rest.startsWith("files/")) {
          const data = b.files.read(rest.slice(6));
          if (!data) { res.statusCode = 404; return res.end("no file"); }
          return res.end(data);
        }
        if (rest === "comments") {
          if (!comments.has(name)) comments.set(name, []);
          const list = comments.get(name)!;
          if (req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
              const c = { ...JSON.parse(body), id: "c" + (list.length + 1), created: new Date().toISOString() };
              list.push(c);
              json(c);
            });
            return;
          }
          return json(list);
        }
        res.statusCode = 404;
        res.end();
      });
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [react(), viteSingleFile(), devApi()],
  build: { outDir: join(here, "dist"), emptyOutDir: true, chunkSizeWarningLimit: 100_000 },
  server: { fs: { allow: [join(here, "..")] } },
});
