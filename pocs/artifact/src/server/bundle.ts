// Bundle file access (dir or zip), the files a doc references, and comment storage.
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { randomBytes } from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import type { Comment, Doc } from "../model.ts";

export interface BundleReader {
  isDir: boolean;
  read(path: string): Uint8Array | undefined;
  list(): string[];
}

/** Normalizes a bundle-relative path; null if it escapes the bundle. */
export function safePath(p: string): string | null {
  const n = posix.normalize(p.replace(/\\/g, "/")).replace(/^(\.\/|\/)+/, "");
  if (!n || n === "." || n === ".." || n.startsWith("../") || n.includes("\0")) return null;
  return n;
}

export function openBundle(path: string): BundleReader {
  if (statSync(path).isDirectory()) {
    return {
      isDir: true,
      read(p) {
        const s = safePath(p);
        if (!s) return undefined;
        try { return readFileSync(join(path, s)); } catch { return undefined; }
      },
      list: () => (readdirSync(path, { recursive: true }) as string[])
        .map((p) => p.split("\\").join("/")).filter((p) => statSync(join(path, p)).isFile()),
    };
  }
  return zipReader(readFileSync(path));
}

/** Caps for unzipping untrusted uploads. Sizes come from the zip headers; fflate never inflates past them. */
export interface ZipLimits { maxBytes: number; maxEntries: number }
export const UPLOAD_LIMITS: ZipLimits = { maxBytes: 200 * 1024 * 1024, maxEntries: 2000 };

/** Throws (status 400) before inflating anything if the zip's declared total size or entry count is over `limits`. */
export function checkZip(zip: Uint8Array, limits: ZipLimits): void {
  let bytes = 0, entries = 0;
  const over = (what: string) => Object.assign(new Error(`bundle too large: ${what}`), { status: 400 });
  unzipSync(zip, {
    filter: (f) => {
      bytes += f.originalSize;
      if (++entries > limits.maxEntries) throw over(`more than ${limits.maxEntries} files`);
      if (bytes > limits.maxBytes) throw over(`more than ${limits.maxBytes / 1024 / 1024} MB unzipped`);
      return false; // count only
    },
  });
}

export function zipReader(zip: Uint8Array, limits?: ZipLimits): BundleReader {
  if (limits) checkZip(zip, limits);
  const files = unzipSync(zip);
  return {
    isDir: false,
    read: (p) => { const s = safePath(p); return s ? files[s] : undefined; },
    list: () => Object.keys(files).filter((f) => !f.endsWith("/")),
  };
}

/** Bundle paths the doc points at: demo blocks, before-after shots, markdown images/links. */
export function referencedFiles(doc: Doc, bundle: BundleReader): string[] {
  const refs = new Set<string>();
  const md: string[] = [doc.overview];
  const blocks = [{ summary: "", blocks: doc.overviewBlocks ?? [] }, ...doc.sections];
  for (const s of blocks) {
    md.push(s.summary);
    for (const b of s.blocks) {
      if (b.type === "demo") refs.add(b.src);
      else if (b.type === "before-after") for (const shot of [b.before, b.after]) { if (shot.src) refs.add(shot.src); if (shot.demo) refs.add(shot.demo); }
      else if (b.type === "markdown" || b.type === "callout") md.push(b.md);
    }
  }
  for (const text of md) for (const m of (text ?? "").matchAll(/\]\(\s*<?([^)\s>]+)|\bsrc=["']([^"']+)/g)) refs.add(m[1] ?? m[2]);
  const out: string[] = [];
  for (const r of refs) {
    let s: string | null = null;
    try { s = r && !/^[a-z]+:/i.test(r) ? safePath(decodeURI(r.split(/[?#]/)[0])) : null; } catch { /* bad escape */ }
    if (s && bundle.read(s)) out.push(s);
  }
  return [...new Set(out)].sort();
}

/** Drops trace.zip (usually ~95% of a .replay) for inlining; the viewer only needs the JSON streams. */
export function slimReplay(bytes: Uint8Array): Uint8Array {
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name !== "trace.zip" });
    return zipSync(files, { level: 6 });
  } catch { return bytes; }
}

// ---- comments ----

/** Dir bundle: comments.json inside it. Zip bundle: sidecar `<bundle>.comments.json` next to it. */
export function commentsFile(bundlePath: string): string {
  return statSync(bundlePath).isDirectory() ? join(bundlePath, "comments.json") : bundlePath + ".comments.json";
}

export function readComments(file: string, fallback?: Pick<BundleReader, "read">): Comment[] {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    const inZip = fallback?.read("comments.json");
    if (inZip) return JSON.parse(new TextDecoder().decode(inZip));
  } catch { /* corrupt file: treat as empty */ }
  return [];
}

/** Validates a POSTed comment (Comment without id/created) and fills id + created. */
export function newComment(input: unknown): Comment {
  const c = (input ?? {}) as Partial<Comment>;
  if (typeof c.body !== "string" || !c.body.trim()) throw new Error("body required");
  if (c.body.length > 20_000) throw new Error("body too long");
  const a = (typeof c.anchor === "object" && c.anchor) || {};
  const anchor: Comment["anchor"] = {};
  if (typeof a.section === "string") anchor.section = a.section;
  if (typeof a.block === "string") anchor.block = a.block;
  if (typeof a.file === "string") anchor.file = a.file;
  if (typeof a.line === "number") anchor.line = a.line;
  return {
    id: randomBytes(5).toString("hex"), anchor,
    author: typeof c.author === "string" && c.author.trim() ? c.author.trim().slice(0, 100) : "anonymous",
    body: c.body, created: new Date().toISOString(),
    ...(c.resolved === true ? { resolved: true } : {}),
  };
}

export function appendComment(file: string, c: Comment, fallback?: Pick<BundleReader, "read">): Comment[] {
  const all = [...readComments(file, fallback), c];
  writeJsonAtomic(file, all);
  return all;
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}
