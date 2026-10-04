// `recap build`: one self-contained HTML (viewer + doc + referenced files as base64), no API.
import { resolve } from "node:path";
import { loadBundle } from "./_stub-load.ts"; // MERGE: swap for "../parse/index.ts"
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
  return { html: injectBoot(viewerTemplate(), { doc, files }), files: paths };
}
