// Shared HTTP bits: responses, the doc API (GET doc / files/<path> / comments, POST comments), viewer page + assets.
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Comment, Doc, ViewerBoot } from "../model.ts";
import { newComment, safePath } from "./bundle.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VIEWER_DIST = join(ROOT, "viewer/dist/index.html");
export const BOOT_MARKER = "<!--RECAP_BOOT-->";

/**
 * Bundle files are untrusted. Only passive types the viewer uses are served with their own type; everything else
 * (html, js, css, unknown) is an octet-stream download. Every file response also gets nosniff and a sandbox CSP, so
 * even an svg opened directly runs no script on this origin.
 */
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  json: "application/json", md: "text/plain; charset=utf-8", txt: "text/plain; charset=utf-8",
  patch: "text/plain; charset=utf-8", diff: "text/plain; charset=utf-8",
  replay: "application/zip", zip: "application/zip", mp4: "video/mp4", webm: "video/webm",
};

export function fileHeaders(p: string): { type: string; headers: Record<string, string> } {
  const type = MIME[p.split(".").pop()!.toLowerCase()];
  const headers: Record<string, string> = {
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    "cross-origin-resource-policy": "same-origin",
  };
  if (!type) headers["content-disposition"] = `attachment; filename="${(p.split("/").pop() || "file").replace(/[^\w.-]/g, "_")}"`;
  return { type: type ?? "application/octet-stream", headers };
}

export function send(res: ServerResponse, status: number, body: string | Uint8Array, type = "text/plain; charset=utf-8", headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}
export const sendJson = (res: ServerResponse, status: number, value: unknown) =>
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");

/** Upload cap 25 MB (viewing.md). */
export async function readBody(req: IncomingMessage, limit = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** The viewer's HTML (viewer/dist/index.html, one self-contained file). Builds it once if missing. */
export function viewerTemplate(): string {
  if (!existsSync(VIEWER_DIST)) {
    const vite = join(ROOT, "node_modules/vite/bin/vite.js");
    process.stderr.write("recap: viewer/dist missing, building the viewer (pnpm viewer:build)…\n");
    try {
      execFileSync(process.execPath, [vite, "build", "--config", join(ROOT, "viewer/vite.config.ts"), "--logLevel", "warn"],
        { cwd: ROOT, stdio: ["ignore", 2, 2] });
    } catch { /* reported below */ }
    if (!existsSync(VIEWER_DIST)) throw new Error("viewer not built and the automatic build failed; run `pnpm viewer:build` in the recap-lab repo");
  }
  return readFileSync(VIEWER_DIST, "utf8");
}

/** JSON safe inside <script> (no `</script>` / `<!--`); U+2028/9 are legal in JS strings since ES2019. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** The inline boot script: window.__RECAP__, plus a live-reload EventSource when `events` is set. */
const bootScript = (boot: ViewerBoot, events?: string) =>
  `window.__RECAP__=${scriptJson(boot)};` +
  (events ? `new EventSource(${scriptJson(events)}).addEventListener("reload",()=>location.reload());` : "");

/** Injects the boot <script> at the marker (or before </head>). `build` uses it on the single-file viewer. */
export function injectBoot(html: string, boot: ViewerBoot, events?: string): string {
  const tag = `<script>${bootScript(boot, events)}</script>`;
  if (html.includes(BOOT_MARKER)) return html.replace(BOOT_MARKER, () => tag);
  return html.includes("</head>") ? html.replace("</head>", () => tag + "</head>") : tag + html;
}

// ---- viewer page + cached assets (serve / server) ----
// The single-file build inlines ~7 MB of JS+CSS. serve/server cut it back out into /_recap/viewer.<hash>.{js,css}
// (immutable, cached by the browser) and send a small HTML shell per page that carries only the boot script.

export const ASSET_PREFIX = "/_recap/";
interface Asset { body: Buffer; type: string; etag: string }
interface ViewerAssets { shell: string; assets: Map<string, Asset> }
let viewerCache: { mtime: number; v: ViewerAssets } | undefined;

const sha256 = (s: string | Buffer, enc: "hex" | "base64") => createHash("sha256").update(s).digest(enc);

/** Splits viewer/dist/index.html into a shell + hashed JS/CSS assets; re-splits when the build changes. */
export function viewerAssets(): ViewerAssets {
  const html = viewerTemplate();
  const mtime = statSync(VIEWER_DIST).mtimeMs;
  if (viewerCache?.mtime === mtime) return viewerCache.v;
  const assets = new Map<string, Asset>();
  let shell = html;
  const cut = (open: RegExp, close: string, ext: string, type: string, tag: (href: string) => string) => {
    const m = open.exec(shell);
    if (!m) return;
    const bodyStart = m.index + m[0].length, end = shell.indexOf(close, bodyStart);
    if (end < 0) return;
    const body = Buffer.from(shell.slice(bodyStart, end));
    const hash = sha256(body, "hex").slice(0, 16);
    const name = `viewer.${hash}.${ext}`;
    assets.set(name, { body, type, etag: `"${hash}"` });
    shell = shell.slice(0, m.index) + tag(ASSET_PREFIX + name) + shell.slice(end + close.length);
  };
  cut(/<script type="module"[^>]*>/, "</script>", "js", "text/javascript; charset=utf-8", (h) => `<script type="module" src="${h}"></script>`);
  cut(/<style rel="stylesheet"[^>]*>/, "</style>", "css", "text/css; charset=utf-8", (h) => `<link rel="stylesheet" href="${h}">`);
  viewerCache = { mtime, v: { shell, assets } };
  return viewerCache.v;
}

/** CSP for viewer pages: our own scripts plus the one inline boot script (by hash); no plugins, framing or forms. */
function viewerCsp(bootJs: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'sha256-${sha256(bootJs, "base64")}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'self' blob: data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** Sends the viewer page for a doc: small HTML shell, boot inline, viewer JS/CSS from ASSET_PREFIX, strict CSP. */
export function sendViewer(res: ServerResponse, boot: ViewerBoot, opts: { events?: string; headers?: Record<string, string> } = {}) {
  const js = bootScript(boot, opts.events);
  const html = viewerAssets().shell.replace(BOOT_MARKER, () => `<script>${js}</script>`);
  send(res, 200, html, "text/html; charset=utf-8", {
    "cache-control": "no-cache",
    "content-security-policy": viewerCsp(js),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...opts.headers,
  });
}

/** Serves `${ASSET_PREFIX}<name>`; returns false if `path` isn't under ASSET_PREFIX. */
export function handleAsset(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (!path.startsWith(ASSET_PREFIX)) return false;
  const a = viewerAssets().assets.get(path.slice(ASSET_PREFIX.length));
  if (!a) { send(res, 404, "not found"); return true; }
  const headers = { etag: a.etag, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" };
  if (req.headers["if-none-match"] === a.etag) { res.writeHead(304, headers); res.end(); return true; }
  send(res, 200, a.body, a.type, headers);
  return true;
}

export interface DocSource {
  doc(): Doc;
  file(path: string): Uint8Array | undefined;
  comments(): Comment[];
  addComment(c: Comment): void;
}

/** Handles `${api}/<sub>`; returns false if `sub` isn't an API route. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, sub: string, src: DocSource): Promise<boolean> {
  const m = req.method ?? "GET";
  if (sub === "doc" && m === "GET") { sendJson(res, 200, src.doc()); return true; }
  if (sub.startsWith("files/") && (m === "GET" || m === "HEAD")) {
    let p: string | null = null;
    try { p = safePath(decodeURIComponent(sub.slice(6))); } catch { /* bad escape */ }
    const bytes = p ? src.file(p) : undefined;
    if (!p || !bytes) { send(res, 404, "not found"); return true; }
    const { type, headers } = fileHeaders(p);
    send(res, 200, bytes, type, headers);
    return true;
  }
  if (sub === "comments" && m === "GET") { sendJson(res, 200, src.comments()); return true; }
  if (sub === "comments" && m === "POST") {
    // JSON only: other sites can't send this content-type cross-origin without a preflight, which we never answer
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      sendJson(res, 415, { error: "content-type must be application/json" });
      return true;
    }
    let c: Comment;
    try { c = newComment(JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"))); }
    catch (e) { sendJson(res, 400, { error: (e as Error).message }); return true; }
    src.addComment(c);
    sendJson(res, 201, c);
    return true;
  }
  return false;
}

/** Wraps a handler: errors → 500/413 JSON instead of a crashed process. */
export function guard(fn: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return (req: IncomingMessage, res: ServerResponse) => {
    fn(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, (e as { status?: number }).status ?? 500, { error: (e as Error).message });
      else res.end();
    });
  };
}
