import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Dev only: a mock of the serve API so the viewer's fetch + comments paths work without the real server.
// /dev-api/<fixture>/{doc,files/<path>,comments}. Fixture = viewer/fixtures/<name>.json (a ViewerBoot or a bare Doc),
// or test/fixtures/<name>.json when <name> starts with "test:".
function devApi(): Plugin {
  const comments = new Map<string, unknown[]>();
  const load = (name: string) => {
    const p = name.startsWith("test:")
      ? join(here, "../test/fixtures", name.slice(5) + ".json")
      : join(here, "fixtures", name + ".json");
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j.format ? { doc: j } : j;
  };
  return {
    name: "recap-dev-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/dev-api\/([^/]+)\/(.*?)(\?.*)?$/);
        if (!m) return next();
        const name = decodeURIComponent(m[1]);
        const rest = decodeURIComponent(m[2]);
        const boot = load(name);
        if (!boot) { res.statusCode = 404; return res.end("no fixture " + name); }
        const json = (v: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
        if (rest === "doc") return json(boot.doc);
        if (rest.startsWith("files/")) {
          const b64 = boot.files?.[rest.slice(6)];
          if (!b64) { res.statusCode = 404; return res.end("no file"); }
          return res.end(Buffer.from(b64, "base64"));
        }
        if (rest === "comments") {
          if (!comments.has(name)) comments.set(name, boot.comments ?? []);
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
