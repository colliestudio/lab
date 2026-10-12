// Build-time evidence: find what the artifact's source references under evidence/ and data/, and turn it into the
// compact registry the kit reads at runtime (parsed patches, replays without trace.zip, data URIs, text).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { parsePatch } from "../../src/parse/patch.ts";
import type { Evidence, Meta, PatchFile, Registry } from "../kit/registry.ts";

export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif",
};
const TEXT_EXT = new Set([".txt", ".md", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".yaml", ".yml", ".go", ".py", ".rs", ".sh", ".css", ".html", ".toml", ".sql", ".log", ".csv", ".diff.txt"]);

export interface Collected {
  registry: Registry;
  missing: string[];          // referenced but not in evidence/
  unreferenced: string[];     // in evidence/ but never mentioned (not inlined)
  sizes: Record<string, number>;  // inlined bytes per evidence path
  dynamic: boolean;           // source builds evidence paths at runtime → everything inlined
}

export function readMeta(dir: string): Meta {
  const p = join(dir, "artifact.json");
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  const m = JSON.parse(readFileSync(p, "utf8")) as Meta;
  if (!m.title) throw new Error("artifact.json needs a title");
  return m;
}

function walk(dir: string, skip: (rel: string) => boolean, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name), rel = relative(base, full);
    if (e.name === "node_modules" || e.name.startsWith(".") || skip(rel)) return [];
    return e.isDirectory() ? walk(full, skip, base) : [rel];
  });
}

/** JSX tag text starting at `i` (`<Diff … />`), tracking braces and quotes so `=>` or `>` inside props don't end it. */
function tagAt(src: string, i: number): string {
  let depth = 0, q = "";
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === q && src[j - 1] !== "\\") q = ""; continue; }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

/** Files of a patch the source asks for through `<Diff patch="X" file="…">`; null = all (some use can't be narrowed). */
export function neededFiles(src: string, path: string): string[] | null {
  const files: string[] = [];
  let uses = 0, narrowed = 0;
  for (const m of src.matchAll(/<Diff\b/g)) {
    const tag = tagAt(src, m.index!);
    if (!new RegExp(`\\bpatch=(["'])(?:\\./)?${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`).test(tag)) continue;
    uses++;
    const f = tag.match(/\bfile=(["'])(.*?)\1/);
    const fs = f ? [f[2]] : [...(tag.match(/\bfile=\{\s*\[([^\]]*)\]\s*\}/)?.[1].matchAll(/(["'])(.*?)\1/g) ?? [])].map((x) => x[2]);
    if (fs.length) { narrowed++; files.push(...fs); }
  }
  const mentions = (src.match(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
  return uses > 0 && narrowed === uses && mentions === uses ? files : null;
}

function patchFiles(text: string, only: string[] | null): PatchFile[] {
  const parsed = parsePatch(text);
  const keep = only ? parsed.filter((f) => only.some((w) => f.path === w || f.path.endsWith("/" + w))) : parsed;
  return keep.map((f) => ({
    path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), change: f.change === "added" || f.change === "removed" ? f.change : "changed",
    additions: f.additions, deletions: f.deletions, binary: f.binary,
    hunks: f.hunks.map((h) => ({ oldStart: h.oldStart, newStart: h.newStart, ctx: h.header.replace(/^@@[^@]*@@\s*/, "") || undefined, lines: h.lines.map((l) => ({ t: l.t, s: l.s })) })),
  }));
}

/** .replay without trace.zip (the player doesn't use it and it is most of the file), base64. */
export function slimReplay(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name !== "trace.zip" });
  return Buffer.from(zipSync(files, { level: 9 })).toString("base64");
}

export function encodeEvidence(path: string, abs: string, src: string): Evidence {
  const ext = extname(path).toLowerCase();
  if (ext === ".patch" || ext === ".diff") return { k: "patch", files: patchFiles(readFileSync(abs, "utf8"), neededFiles(src, path)) };
  if (ext === ".replay") return { k: "replay", b64: slimReplay(readFileSync(abs)) };
  if (IMAGE_MIME[ext]) return { k: "image", url: `data:${IMAGE_MIME[ext]};base64,${readFileSync(abs).toString("base64")}` };
  if (TEXT_EXT.has(ext)) return { k: "text", text: readFileSync(abs, "utf8") };
  return { k: "file", url: `data:application/octet-stream;base64,${readFileSync(abs).toString("base64")}` };
}

/** Source text the references are searched in: everything but evidence/ itself. */
export function sourceText(dir: string): string {
  return walk(dir, (r) => r.startsWith("evidence/") || r.startsWith("evidence" + "\\"))
    .filter((f) => /\.(tsx?|jsx?|mjs|mdx?|json)$/.test(f) && f !== "artifact.json")
    .map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

export function collect(dir: string): Collected {
  const meta = readMeta(dir);
  const src = sourceText(dir);
  // static imports of evidence are handled by the build's loaders: don't inline them twice
  const scan = src.replace(/\bfrom\s*(["'])[^"']*\1/g, "").replace(/\bimport\s*\(\s*(["'])[^"']*\1\s*\)/g, "").replace(/\bimport\s*(["'])[^"']*\1/g, "");
  const evDir = join(dir, "evidence");
  const have = walk(evDir, () => false).map((f) => "evidence/" + f.split("\\").join("/"));
  const dynamic = /evidence\/[^"'`\s]*\$\{/.test(scan);
  const refs = new Set<string>();
  for (const m of scan.matchAll(/(?:\.\/)?(evidence\/[^\s"'`)\]}<>,;]+)/g)) refs.add(m[1].replace(/[.:!?]+$/, ""));
  const want = dynamic ? new Set([...have, ...refs]) : refs;
  const evidence: Record<string, Evidence> = {}, sizes: Record<string, number> = {}, missing: string[] = [];
  for (const p of [...want].sort()) {
    const abs = join(dir, p);
    if (!existsSync(abs) || !statSync(abs).isFile()) { if (!have.includes(p)) missing.push(p); continue; }
    evidence[p] = encodeEvidence(p, abs, src);
    sizes[p] = JSON.stringify(evidence[p]).length;
  }
  const data: Record<string, unknown> = {};
  for (const f of walk(join(dir, "data"), () => false).filter((f) => f.endsWith(".json"))) {
    data[f.slice(0, -5).split("\\").join("/")] = JSON.parse(readFileSync(join(dir, "data", f), "utf8"));
  }
  return { registry: { meta, data, evidence }, missing, unreferenced: have.filter((p) => !(p in evidence)), sizes, dynamic };
}
export { strFromU8, strToU8 };
