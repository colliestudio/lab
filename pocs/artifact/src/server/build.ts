// `recap build`: one self-contained HTML (viewer + doc + referenced files as base64), no API.
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { loadBundle } from "../parse/index.ts";
import { openBundle, referencedFiles, slimReplay } from "./bundle.ts";
import { injectBoot, viewerTemplate } from "./http.ts";

export async function buildHtml(bundlePath: string): Promise<{ html: string; files: string[] }> {
  const path = resolve(bundlePath);
  const { doc } = await loadBundle(path);
  const bundle = openBundle(path);
  const paths = referencedFiles(doc, bundle);
  const files: Record<string, string> = {};
  for (const p of paths) {
    let bytes = bundle.read(p)!;
    if (p.endsWith(".replay")) bytes = slimReplay(bytes);
    files[p] = Buffer.from(bytes).toString("base64");
  }
  return { html: injectBoot(packViewerJs(viewerTemplate()), { doc, files }), files: paths };
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
