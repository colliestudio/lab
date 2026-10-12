// The artifact build: esbuild bundles index.tsx + the kit + the host into one IIFE, evidence and data come in as a
// virtual module, and everything is inlined into a single HTML file.
import * as esbuild from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collect, IMAGE_MIME, slimReplay, type Collected } from "./evidence.ts";
import { parsePatch } from "../../src/parse/patch.ts";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const kitIndex = join(repoRoot, "artifact/kit/index.ts");
const hostMain = join(repoRoot, "artifact/host/main.tsx");

export interface BuildOpts { dev?: boolean; minify?: boolean }
export interface BuildResult {
  html: string; js: number; css: number; bytes: number;
  warnings: esbuild.Message[]; errors: esbuild.Message[];
  collected: Collected;
  parts: { name: string; bytes: number }[];
}

export function findEntry(dir: string): string {
  for (const f of ["index.tsx", "index.jsx", "index.ts", "index.mdx"]) if (existsSync(join(dir, f))) return join(dir, f);
  throw new Error(`no index.tsx in ${dir}`);
}

function plugin(state: { collected?: Collected; dir: string }): esbuild.Plugin {
  return {
    name: "artifact",
    setup(b) {
      b.onResolve({ filter: /^artifact$/ }, () => ({ path: kitIndex }));
      b.onResolve({ filter: /^artifact:registry$/ }, () => ({ path: "registry", namespace: "artifact-registry" }));
      b.onLoad({ filter: /.*/, namespace: "artifact-registry" }, () => {
        state.collected = collect(state.dir);
        return { contents: `export default ${JSON.stringify(state.collected.registry)};`, loader: "js", resolveDir: repoRoot };
      });
      // `x.css?text` → the CSS as a string (loaded only by the component that needs it)
      b.onResolve({ filter: /\?text$/ }, async (a) => {
        const r = await b.resolve(a.path.replace(/\?text$/, ""), { resolveDir: a.resolveDir, kind: a.kind });
        return { path: r.path, namespace: "css-text" };
      });
      b.onLoad({ filter: /.*/, namespace: "css-text" }, (a) => ({ contents: readFileSync(a.path, "utf8"), loader: "text" }));
      // direct imports of evidence: `import patch from "./evidence/x.patch"` → parsed, `.replay` → base64
      b.onLoad({ filter: /\.(patch|diff)$/ }, (a) => {
        const files = parsePatch(readFileSync(a.path, "utf8")).map((f) => ({
          path: f.path, change: f.change, additions: f.additions, deletions: f.deletions, binary: f.binary,
          hunks: f.hunks.map((h) => ({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines.map((l) => ({ t: l.t, s: l.s })) })),
        }));
        return { contents: `export default ${JSON.stringify(files)};`, loader: "js" };
      });
      b.onLoad({ filter: /\.replay$/ }, (a) => ({ contents: `export default ${JSON.stringify(slimReplay(readFileSync(a.path)))};`, loader: "js" }));
    },
  };
}

const options = (dir: string, state: { dir: string }, o: BuildOpts): esbuild.BuildOptions => ({
  stdin: {
    contents: [
      `import ${JSON.stringify(join(repoRoot, "artifact/kit/tokens.css"))};`,
      `import ${JSON.stringify(join(repoRoot, "artifact/kit/kit.css"))};`,
      `import ${JSON.stringify(join(repoRoot, "artifact/host/host.css"))};`,
      `import App from ${JSON.stringify(findEntry(dir))};`,
      `import { mount } from ${JSON.stringify(hostMain)};`,
      `mount(App);`,
    ].join("\n"),
    resolveDir: repoRoot, loader: "tsx", sourcefile: "artifact-entry.tsx",
  },
  bundle: true, write: false, format: "iife", outdir: "out", platform: "browser", target: "es2022",
  minify: o.minify ?? !o.dev, sourcemap: false, metafile: true, logLevel: "silent",
  jsx: "automatic", tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
  nodePaths: [join(repoRoot, "node_modules")],
  define: { "process.env.NODE_ENV": JSON.stringify(o.dev ? "development" : "production") },
  loader: { ...Object.fromEntries(Object.keys(IMAGE_MIME).map((e) => [e, "dataurl"])), ".md": "text", ".txt": "text" },
  plugins: [plugin(state as never)],
  legalComments: "none",
});

const esc = (s: string) => s.replace(/<\/(script|style)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
export const htmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function page(title: string, css: string, js: string, extra = ""): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${htmlEscape(title)}</title><style>${esc(css)}</style></head><body><div id="root"></div>${extra}<script>${esc(js)}</script></body></html>\n`;
}

function parts(meta: esbuild.Metafile): { name: string; bytes: number }[] {
  const out = Object.values(meta.outputs).find((o) => o.entryPoint || Object.keys(o.inputs).length) ?? { inputs: {} };
  const by = new Map<string, number>();
  for (const [p, i] of Object.entries(out.inputs)) {
    const m = p.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
    const name = m ? m[1] : p.startsWith("artifact-registry") ? "evidence+data" : p.includes("artifact/kit") ? "kit" : p.includes("artifact/host") ? "host" : p.includes("artifact-entry") ? "entry" : "artifact source";
    by.set(name, (by.get(name) ?? 0) + i.bytesInOutput);
  }
  return [...by].map(([name, bytes]) => ({ name, bytes })).filter((x) => x.bytes > 0).sort((a, b) => b.bytes - a.bytes);
}

function finish(dir: string, r: esbuild.BuildResult, state: { collected?: Collected }, o: BuildOpts, extra: string): BuildResult {
  const js = r.outputFiles?.find((f) => f.path.endsWith(".js"))?.text ?? "";
  const css = r.outputFiles?.find((f) => f.path.endsWith(".css"))?.text ?? "";
  const collected = state.collected ?? collect(dir);
  const html = r.errors.length ? "" : page(collected.registry.meta.title, css, js, extra);
  return { html, js: js.length, css: css.length, bytes: Buffer.byteLength(html), warnings: r.warnings, errors: r.errors, collected, parts: r.metafile ? parts(r.metafile) : [] };
}

async function run(go: () => Promise<esbuild.BuildResult>): Promise<esbuild.BuildResult> {
  try { return await go(); } catch (e) {
    const err = e as esbuild.BuildFailure;
    if (err.errors) return { errors: err.errors, warnings: err.warnings ?? [], outputFiles: [], metafile: undefined as never, mangleCache: undefined, rebuild: undefined as never, stop: undefined as never } as never;
    throw e;
  }
}

export async function buildArtifact(dir: string, o: BuildOpts = {}, extra = ""): Promise<BuildResult> {
  const state = { dir: resolve(dir), collected: undefined as Collected | undefined };
  const r = await run(() => esbuild.build(options(state.dir, state, o)));
  return finish(state.dir, r, state, o, extra);
}

/** Incremental builder for `dev`: rebuild() re-reads the artifact dir and re-collects evidence every time. */
export async function createBuilder(dir: string, o: BuildOpts = {}) {
  const state = { dir: resolve(dir), collected: undefined as Collected | undefined };
  let ctx: esbuild.BuildContext | undefined;
  return {
    async rebuild(extra = ""): Promise<BuildResult> {
      state.collected = undefined;
      ctx ??= await esbuild.context(options(state.dir, state, o));
      const r = await run(() => ctx!.rebuild());
      return finish(state.dir, r, state, o, extra);
    },
    dispose: async () => { await ctx?.dispose(); },
  };
}

export const fmtBytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} KB`);
export async function formatMessages(ms: esbuild.Message[], kind: "error" | "warning") {
  return (await esbuild.formatMessages(ms, { kind, color: false, terminalWidth: 100 })).join("\n");
}

/** Server-side render of the artifact (best effort): catches runtime errors in the agent's code and duplicate Section ids. */
export async function renderStatic(dir: string): Promise<{ html: string } | { error: string }> {
  const abs = resolve(dir);
  const state = { dir: abs, collected: undefined as Collected | undefined };
  const base = options(abs, state, { minify: false });
  const r = await esbuild.build({
    ...base,
    stdin: { contents: `import App from ${JSON.stringify(findEntry(abs))};\nimport { renderToString } from "react-dom/server";\nimport { createElement } from "react";\nglobalThis.__html = () => renderToString(createElement(App));`, resolveDir: repoRoot, loader: "tsx" },
    platform: "node", format: "cjs", write: false, outdir: "out", metafile: false,
    external: ["mermaid", "rrweb-player", "rrweb-player/*", "elkjs", "elkjs/*"],
  }).catch((e) => ({ errors: e.errors ?? [{ text: String(e) }], outputFiles: [] as never }));
  if (!r.outputFiles?.length) return { error: "bundle failed" };
  try {
    const g = globalThis as unknown as { __html?: () => string };
    new Function("require", "module", "exports", r.outputFiles[0].text)(createRequire(), { exports: {} }, {});
    const html = g.__html!();
    delete g.__html;
    return { html };
  } catch (e) { return { error: String((e as Error)?.stack ?? e).split("\n").slice(0, 6).join("\n") }; }
}
import { createRequire as cr } from "node:module";
function createRequire() { const req = cr(join(repoRoot, "package.json")); return (id: string) => req(id); }
