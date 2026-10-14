// Build-time evidence: find what the artifact's source references under evidence/ and data/, and turn it into the
// compact registry the kit reads at runtime (parsed patches, replays without trace.zip, data URIs, text).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { parsePatch } from "../../src/parse/patch.ts";
import type { Evidence, Meta, PatchFile, Registry, ReplayMeta } from "../kit/registry.ts";

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
  unsafe: string[];           // references that leave evidence/ (.. segments, symlinks to elsewhere)
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

interface Attr { str?: string; expr?: string }
/** Attributes of a JSX tag at its own level: string values and `{…}` expressions; text inside another prop's value is ignored. */
export function topAttrs(tag: string): Map<string, Attr> {
  const out = new Map<string, Attr>();
  let i = tag.search(/[\s]/);
  if (i < 0) return out;
  while (i < tag.length) {
    const m = /^\s*([A-Za-z_][\w-]*)\s*=\s*/.exec(tag.slice(i));
    if (!m) { // skip one token (boolean attr, spread, `/>`)
      const sp = /^\s*(\{[^}]*\}|[^\s=]+)/.exec(tag.slice(i));
      if (!sp) break;
      i += sp[0].length; continue;
    }
    i += m[0].length;
    const c = tag[i];
    if (c === '"' || c === "'") {
      const e = tag.indexOf(c, i + 1);
      if (e < 0) break;
      out.set(m[1], { str: tag.slice(i + 1, e) }); i = e + 1;
    } else if (c === "{") {
      let depth = 0, q = "", j = i;
      for (; j < tag.length; j++) {
        const ch = tag[j];
        if (q) { if (ch === q && tag[j - 1] !== "\\") q = ""; continue; }
        if (ch === '"' || ch === "'" || ch === "`") q = ch;
        else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) break;
      }
      out.set(m[1], { expr: tag.slice(i + 1, j) }); i = j + 1;
    } else break;
  }
  return out;
}

/** Files of a patch the source asks for through `<Diff patch="X" file="…">`; null = all (some use can't be narrowed). */
export function neededFiles(src: string, path: string): string[] | null {
  const files: string[] = [];
  let uses = 0, narrowed = 0;
  for (const m of src.matchAll(/<Diff\b/g)) {
    const attrs = topAttrs(tagAt(src, m.index!));
    const pa = attrs.get("patch");
    if (!pa || pa.str?.replace(/^\.\//, "") !== path) continue;
    uses++;
    const f = attrs.get("file");
    const fs = f?.str != null ? [f.str] : f?.expr ? [...f.expr.matchAll(/^\s*\[|(["'])(.*?)\1/g)].flatMap((x) => (x[2] != null ? [x[2]] : [])) : [];
    const plain = f?.str != null || (f?.expr != null && /^\s*\[\s*(?:(["']).*?\1\s*,?\s*)+\]\s*$/.test(f.expr));
    if (plain && fs.length) { narrowed++; files.push(...fs); }
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

/** What the page needs before it decodes a recording (chapters, size of the stage, length), so the zip stays an inert string until the reader scrolls to it. */
export function replayMeta(bytes: Uint8Array): ReplayMeta {
  const files = unzipSync(bytes, { filter: (f) => ["manifest.json", "steps.json", "rrweb.json"].includes(f.name) });
  const read = <T,>(n: string, d: T): T => (files[n] ? JSON.parse(strFromU8(files[n])) : d);
  const manifest = read<{ viewport?: { width: number; height: number }; startedAt?: string }>("manifest.json", {});
  const events = read<{ timestamp: number }[]>("rrweb.json", []);
  const steps = read<{ t: number; text: string; kind?: string }[]>("steps.json", []);
  const t0 = events[0]?.timestamp ?? (manifest.startedAt ? Date.parse(manifest.startedAt) : steps[0]?.t ?? 0);
  return {
    screen: events.length > 0, viewport: manifest.viewport ?? { width: 1280, height: 800 }, duration: events.length ? events[events.length - 1].timestamp - t0 : 0,
    steps: steps.map((s) => ({ rel: Math.max(0, s.t - t0), text: s.text, ...(s.kind ? { kind: s.kind } : {}) })),
  };
}

export function encodeEvidence(path: string, abs: string, src: string): Evidence {
  const ext = extname(path).toLowerCase();
  if (ext === ".patch" || ext === ".diff") return { k: "patch", files: patchFiles(readFileSync(abs, "utf8"), neededFiles(src, path)) };
  if (ext === ".replay") { const raw = readFileSync(abs); return { k: "replay", b64: slimReplay(raw), meta: replayMeta(raw) }; }
  if (IMAGE_MIME[ext]) return { k: "image", url: `data:${IMAGE_MIME[ext]};base64,${readFileSync(abs).toString("base64")}` };
  if (TEXT_EXT.has(ext)) return { k: "text", text: readFileSync(abs, "utf8") };
  return { k: "file", url: `data:application/octet-stream;base64,${readFileSync(abs).toString("base64")}` };
}

/** Code the references are searched in: tsx/ts/jsx/mdx outside evidence/ (data files are only read for whole-string refs). */
export function sourceText(dir: string): string {
  return walk(dir, (r) => r.startsWith("evidence/") || r.startsWith("evidence" + "\\"))
    .filter((f) => /\.(tsx?|jsx?|mjs|mdx?)$/.test(f))
    .map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

export function collect(dir: string): Collected {
  const meta = readMeta(dir);
  const src = sourceText(dir);
  // static imports of evidence are handled by the build's loaders: don't inline them twice
  const scan = src.replace(/\bfrom\s*(["'])[^"']*\1/g, "").replace(/\bimport\s*\(\s*(["'])[^"']*\1\s*\)/g, "").replace(/\bimport\s*(["'])[^"']*\1/g, "");
  const evDir = join(dir, "evidence");
  const have = walk(evDir, () => false).map((f) => "evidence/" + f.split("\\").join("/"));
  const refs = new Set<string>();
  // hard references are string literals that start at the path: "evidence/x", './evidence/x'
  // a template literal with ${…} (`evidence/${id}.jpg`) is a glob over the files in evidence/: every match is inlined
  const globs: string[] = [];
  for (const m of scan.matchAll(/(["'`])(?:\.\/)?(evidence\/[^"'`\n]+?)\1/g)) { if (m[1] === "`" && m[2].includes("${")) globs.push(m[2]); else refs.add(m[2]); }
  const data: Record<string, unknown> = {};
  for (const f of walk(join(dir, "data"), () => false).filter((f) => f.endsWith(".json"))) {
    const v = JSON.parse(readFileSync(join(dir, "data", f), "utf8"));
    data[f.slice(0, -5).split("\\").join("/")] = v;
    const visit = (x: unknown) => {
      if (typeof x === "string") { const m = /^(?:\.\/)?(evidence\/.+)$/.exec(x); if (m) refs.add(m[1]); }
      else if (Array.isArray(x)) x.forEach(visit);
      else if (x && typeof x === "object") Object.values(x).forEach(visit);
    };
    visit(v);
  }
  const dynamic = globs.length > 0;
  const missingGlobs: string[] = [];
  for (const g of globs) {
    const re = new RegExp("^" + g.split(/\$\{[^}]*\}/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
    const hits = have.filter((f) => re.test(f));
    if (!hits.length) missingGlobs.push(g);
    hits.forEach((h) => refs.add(h));
  }
  const want = refs;
  const evidence: Record<string, Evidence> = {}, sizes: Record<string, number> = {}, missing: string[] = [], unsafe: string[] = [];
  const evReal = existsSync(evDir) ? realpathSync(evDir) : evDir;
  for (const p of [...want].sort()) {
    if (p.split("/").includes("..")) { unsafe.push(p); continue; }
    const abs = join(dir, p);
    if (!existsSync(abs) || !statSync(abs).isFile()) { if (!have.includes(p)) missing.push(p); continue; }
    if (!realpathSync(abs).startsWith(evReal + sep)) { unsafe.push(p); continue; }
    evidence[p] = encodeEvidence(p, abs, src);
    sizes[p] = JSON.stringify(evidence[p]).length;
  }
  missing.push(...missingGlobs.map((g) => `${g} (matches no file in evidence/)`));
  return { registry: { meta, data, evidence }, missing, unreferenced: have.filter((p) => !(p in evidence) && !unsafe.includes(p)), sizes, dynamic, unsafe };
}
