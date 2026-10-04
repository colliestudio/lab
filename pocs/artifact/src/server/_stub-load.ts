// STUB — swap at merge for the parser's real `loadBundle` (src/parse). Only `.doc` is used by src/server.
// Builds a trivial Doc: frontmatter (title/tldr/kind/risk/ask), `## ` sections of markdown,
// and ```demo fences (YAML body) as demo blocks, so serve/build/server can be exercised end to end.
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { parse as parseYaml } from "yaml";
import { FORMAT, type Block, type Doc, type Section } from "../model.ts";

export async function loadBundle(path: string): Promise<{ doc: Doc; files: Record<string, Uint8Array> }> {
  const files: Record<string, Uint8Array> = {};
  if (statSync(path).isDirectory()) {
    for (const rel of readdirSync(path, { recursive: true }) as string[]) {
      const p = rel.split("\\").join("/");
      if (statSync(join(path, p)).isFile()) files[p] = readFileSync(join(path, p));
    }
  } else {
    Object.assign(files, unzipSync(readFileSync(path)));
  }
  if (!files["doc.md"]) throw new Error(`${path}: no doc.md`);
  return { doc: stubDoc(strFromU8(files["doc.md"])), files };
}

function stubDoc(src: string): Doc {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const meta = (fm ? parseYaml(fm[1]) : {}) ?? {};
  const body = fm ? src.slice(fm[0].length) : src;
  const [overview, ...parts] = body.split(/^## /m);
  const sections: Section[] = parts.map((part, si) => {
    const nl = part.indexOf("\n");
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    const idm = /\{#([\w-]+)\}/.exec(head);
    const title = head.replace(/\{[^}]*\}/, "").trim();
    const blocks: Block[] = [];
    const rest = nl < 0 ? "" : part.slice(nl + 1);
    let last = 0;
    for (const m of rest.matchAll(/^```demo[^\n]*\n([\s\S]*?)^```$/gm)) {
      const md = rest.slice(last, m.index).trim();
      if (md) blocks.push({ id: `b${si}-${blocks.length}`, level: 2, type: "markdown", md });
      const y = parseYaml(m[1]) ?? {};
      blocks.push({ id: `b${si}-${blocks.length}`, level: 2, type: "demo", src: y.src, steps: y.steps, caption: y.caption });
      last = m.index! + m[0].length;
    }
    const tail = rest.slice(last).trim();
    if (tail) blocks.push({ id: `b${si}-${blocks.length}`, level: 2, type: "markdown", md: tail });
    return { id: idm?.[1] ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, summary: "", mechanical: /\.mechanical/.test(head), blocks };
  });
  return {
    format: FORMAT, kind: meta.kind === "plan" ? "plan" : "review",
    title: String(meta.title ?? "Untitled"), tldr: String(meta.tldr ?? ""),
    status: meta.status, ask: meta.ask,
    risk: meta.risk ? { level: meta.risk, why: meta.risk_why } : undefined,
    meta: {}, map: { groups: [], nodes: [], edges: [] },
    overview: overview.trim(), sections, files: [], questions: [], warnings: ["stub parser (src/server/_stub-load.ts)"],
  };
}
