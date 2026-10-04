// Shared HTTP bits: responses, the doc API (GET doc / files/<path> / comments, POST comments), viewer page.
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Comment, Doc, ViewerBoot } from "../model.ts";
import { newComment, safePath } from "./bundle.ts";
import { STUB_VIEWER_HTML } from "./_stub-viewer.ts";

const VIEWER_DIST = fileURLToPath(new URL("../../viewer/dist/index.html", import.meta.url));
export const BOOT_MARKER = "<!--RECAP_BOOT-->";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  json: "application/json", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
  patch: "text/x-diff; charset=utf-8", diff: "text/x-diff; charset=utf-8", html: "text/html; charset=utf-8",
  css: "text/css", js: "text/javascript", replay: "application/zip", zip: "application/zip", mp4: "video/mp4", webm: "video/webm",
};
export const mimeOf = (p: string) => MIME[p.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

export function send(res: ServerResponse, status: number, body: string | Uint8Array, type = "text/plain; charset=utf-8", headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}
export const sendJson = (res: ServerResponse, status: number, value: unknown) =>
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");

export async function readBody(req: IncomingMessage, limit = 100 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** The viewer's HTML: the real build (viewer/dist) when present, else the stub page. */
export function viewerTemplate(): string {
  return existsSync(VIEWER_DIST) ? readFileSync(VIEWER_DIST, "utf8") : STUB_VIEWER_HTML;
}

/** JSON safe inside <script> (no `</script>` / `<!--`); U+2028/9 are legal in JS strings since ES2019. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** Injects window.__RECAP__ at the marker (or before </head>); `events` adds a live-reload EventSource. */
export function injectBoot(html: string, boot: ViewerBoot, events?: string): string {
  let tag = `<script>window.__RECAP__=${scriptJson(boot)}</script>`;
  if (events) tag += `<script>new EventSource(${scriptJson(events)}).addEventListener("reload",()=>location.reload())</script>`;
  if (html.includes(BOOT_MARKER)) return html.replace(BOOT_MARKER, () => tag);
  return html.includes("</head>") ? html.replace("</head>", () => tag + "</head>") : tag + html;
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
    send(res, 200, bytes, mimeOf(p), { "cache-control": "no-cache" });
    return true;
  }
  if (sub === "comments" && m === "GET") { sendJson(res, 200, src.comments()); return true; }
  if (sub === "comments" && m === "POST") {
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
