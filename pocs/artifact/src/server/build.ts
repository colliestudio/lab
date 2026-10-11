// `recap build`: one self-contained HTML (viewer + doc + referenced files as base64), no API.
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { CodeLevel, Doc } from "../model.ts";
import { applyCodeLevel } from "../code-level.ts";
import { loadBundle } from "../parse/index.ts";
import { openBundle, referencedFiles, slimReplay, type BundleReader } from "./bundle.ts";
import { injectBoot, viewerTemplate } from "./http.ts";

export interface BuildOptions { code?: CodeLevel }   // default "key"
export interface BuildPart { name: string; bytes: number }

/** `parts`: what the HTML is made of (viewer, doc text, code, each inlined file), biggest first. */
/** `code`: the level asked for; `stripped`: whether it removed anything (a plan without a patch has nothing to strip). */
export interface Built { html: string; files: string[]; parts: BuildPart[]; code: CodeLevel; stripped: boolean }

export async function buildHtml(bundlePath: string, opts: BuildOptions = {}): Promise<Built> {
  const path = resolve(bundlePath);
  return buildFromDoc((await loadBundle(path)).doc, openBundle(path), opts);
}

/** The single file for an already-parsed doc; serve/server use this for `GET <api>/export`. */
export function buildFromDoc(full: Doc, bundle: Pick<BundleReader, "read">, opts: BuildOptions = {}): Built {
  const code = opts.code ?? "key";
  const doc = applyCodeLevel(full, code);
  const paths = referencedFiles(doc, bundle);
  const files: Record<string, string> = {};
  for (const p of paths) {
    let bytes = bundle.read(p)!;
    if (p.endsWith(".replay")) bytes = slimReplay(bytes);
    files[p] = Buffer.from(bytes).toString("base64");
  }
  const viewer = packViewerJs(viewerTemplate());
  const html = injectBoot(viewer, { doc, files });
  const codeBytes = docCodeBytes(doc);
  const docBytes = Buffer.byteLength(JSON.stringify(doc));
  const parts: BuildPart[] = [
    { name: "viewer", bytes: Buffer.byteLength(viewer) },
    { name: "code (patch + diff/code blocks)", bytes: codeBytes },
    { name: "doc (text, map)", bytes: Math.max(0, docBytes - codeBytes) },
    ...paths.map((p) => ({ name: p, bytes: files[p].length })),
  ].sort((a, b) => b.bytes - a.bytes);
  return { html, files: paths, parts, code, stripped: !!doc.codeLevel };
}

/** JSON bytes of the code the doc carries: file hunks, diff block hunks, code block bodies. */
function docCodeBytes(doc: Doc): number {
  let n = 0;
  for (const f of doc.files) n += Buffer.byteLength(JSON.stringify(f.hunks));
  for (const b of [...(doc.overviewBlocks ?? []), ...doc.sections.flatMap((s) => s.blocks)]) {
    if (b.type === "diff") n += Buffer.byteLength(JSON.stringify(b.hunks));
    else if (b.type === "code") n += Buffer.byteLength(JSON.stringify(b.code));
  }
  return n;
}

export const SIZE_WARN = 5 * 1024 * 1024;
export const SIZE_REFUSE = 25 * 1024 * 1024;

/**
 * The size report `recap build` prints: total + biggest parts; over `warn` a warning with what to cut, over `refuse` an
 * error (the caller doesn't write the file unless --force).
 */
export function sizeReport(total: number, parts: BuildPart[], code: CodeLevel, limits = { warn: SIZE_WARN, refuse: SIZE_REFUSE }):
  { lines: string[]; level: "ok" | "warn" | "refuse" } {
  const lines = parts.slice(0, 6).map((p) => `  ${fmtBytes(p.bytes).padStart(8)}  ${p.name}`);
  const level = total > limits.refuse ? "refuse" : total > limits.warn ? "warn" : "ok";
  if (level !== "ok") {
    const tips: string[] = [];
    const codePart = parts.find((p) => p.name.startsWith("code"))?.bytes ?? 0;
    if (code === "full" && codePart > 0) tips.push("`--code key` (only the hunks diff/code blocks show)");
    else if (code === "key" && codePart > 0) tips.push("`--code none`, or fewer/shorter diff blocks");
    if (parts.some((p) => p.name.endsWith(".replay"))) {
      tips.push("shorter recordings (replays are already inlined without trace.zip; drop demos that don't show this change)");
    }
    const over = level === "refuse" ? `over ${fmtBytes(limits.refuse)}` : `over ${fmtBytes(limits.warn)}`;
    lines.push(`${level === "refuse" ? "error" : "warning"}: ${fmtBytes(total)} is ${over}${level === "refuse" ? "; not written (--force to write anyway)" : ""}`);
    if (tips.length) lines.push(`  to shrink: ${tips.join("; ")}`);
  }
  return { lines, level };
}

export function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

const MODULE_OPEN = /<script type="module"[^>]*>/;

/**
 * The single file ships the viewer JS gzipped + base64 (~2.8 MB instead of ~7 MB, mostly Mermaid and ELK) with a
 * few-line module that inflates it (DecompressionStream) and imports it from a blob: URL; works offline and from
 * file://. Mermaid's module bodies stay lazy either way (the bundler wraps dynamic-import targets in init functions).
 * Only for `build`: serve/server cut the plain JS out into a cached asset instead (and their CSP has no blob: scripts).
 */
export function packViewerJs(html: string): string {
  const m = MODULE_OPEN.exec(html);
  const close = m ? html.indexOf("</script>", m.index) : -1;
  if (!m || close < 0) return html;
  const js = html.slice(m.index + m[0].length, close);
  const b64 = gzipSync(Buffer.from(js), { level: 9 }).toString("base64");
  const loader = `<script type="application/gzip;base64" id="recap-js">${b64}</script>`
    + '<script type="module">const b=Uint8Array.from(atob(document.getElementById("recap-js").textContent),(c)=>c.charCodeAt(0));'
    + 'const t=await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).text();'
    + 'await import(URL.createObjectURL(new Blob([t],{type:"text/javascript"})));</script>';
  return html.slice(0, m.index) + loader + html.slice(close + "</script>".length);
}
