// `recap server`: hosted / self-hosted. Upload = zip bundle; unlisted random ids; comments server-side.
// Storage per doc: <data>/<id>/{bundle.review (zip), doc.json, meta.json, comments.json}.
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Doc } from "../model.ts";
import { loadBundle } from "./_stub-load.ts"; // MERGE: swap for "../parse/index.ts"
import { appendComment, readComments, writeJsonAtomic, zipReader, type BundleReader } from "./bundle.ts";
import { guard, handleApi, injectBoot, readBody, send, sendJson, viewerTemplate } from "./http.ts";
import type { Running } from "./serve.ts";

const ID_RE = /^[A-Za-z0-9]{10}$/;
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes
export const newId = () => [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join("");

interface Meta { id: string; title: string; kind: string; created: string; updated: string }

export async function startHosted(opts: { data: string; port?: number; host?: string; token?: string }): Promise<Running> {
  const data = resolve(opts.data);
  mkdirSync(data, { recursive: true });
  const cache = new Map<string, { doc: Doc; reader: BundleReader }>();

  const tokenOk = (s: string | null | undefined) => {
    const got = Buffer.from(s ?? ""), want = Buffer.from(opts.token ?? "");
    return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
  };
  const authorized = (req: IncomingMessage) => !opts.token || tokenOk(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]);

  /** Parses the upload, then swaps it in; comments.json is left alone (re-publish keeps comments). */
  async function store(id: string, zip: Buffer, isNew: boolean): Promise<Meta> {
    const dir = join(data, id);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `upload-${randomBytes(4).toString("hex")}.review`);
    writeFileSync(tmp, zip);
    let doc: Doc;
    try {
      zipReader(zip); // rejects non-zip bodies with a clear error before the parser sees them
      doc = (await loadBundle(tmp)).doc;
    } catch (e) {
      rmSync(tmp, { force: true });
      if (isNew) rmSync(dir, { recursive: true, force: true });
      throw Object.assign(new Error(`invalid bundle: ${(e as Error).message}`), { status: 400 });
    }
    renameSync(tmp, join(dir, "bundle.review"));
    writeJsonAtomic(join(dir, "doc.json"), doc);
    const now = new Date().toISOString();
    const prev = isNew ? undefined : readMeta(id);
    const meta: Meta = { id, title: doc.title, kind: doc.kind, created: prev?.created ?? now, updated: now };
    writeJsonAtomic(join(dir, "meta.json"), meta);
    cache.delete(id);
    return meta;
  }
  const readMeta = (id: string): Meta | undefined => {
    try { return JSON.parse(readFileSync(join(data, id, "meta.json"), "utf8")); } catch { return undefined; }
  };
  const open = (id: string) => {
    if (!ID_RE.test(id) || !existsSync(join(data, id, "doc.json"))) return undefined;
    let hit = cache.get(id);
    if (!hit) {
      hit = { doc: JSON.parse(readFileSync(join(data, id, "doc.json"), "utf8")), reader: zipReader(readFileSync(join(data, id, "bundle.review"))) };
      cache.set(id, hit);
    }
    return hit;
  };
  const docUrl = (req: IncomingMessage, id: string) => {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
    return `${proto}://${req.headers.host}/d/${id}`;
  };

  const server = createServer(guard(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname, m = req.method ?? "GET";

    if (p === "/api/docs" && m === "POST") {
      if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      let id = newId();
      while (existsSync(join(data, id))) id = newId();
      await store(id, body, true);
      return sendJson(res, 201, { id, url: docUrl(req, id) });
    }
    let r = /^\/api\/docs\/([^/]+)$/.exec(p);
    if (r && m === "PUT") {
      if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
      if (!open(r[1])) return sendJson(res, 404, { error: "no such doc" });
      await store(r[1], await readBody(req), false);
      return sendJson(res, 200, { id: r[1], url: docUrl(req, r[1]) });
    }

    r = /^\/d\/([^/]+)(\/.*)?$/.exec(p);
    if (r) {
      const id = r[1], rest = r[2] ?? "", hit = open(id);
      if (!hit) return send(res, 404, "not found");
      const noindex = { "x-robots-tag": "noindex", "referrer-policy": "no-referrer" };
      if (rest === "" || rest === "/") {
        return send(res, 200, injectBoot(viewerTemplate(), { doc: hit.doc, api: `/d/${id}/api` }), "text/html; charset=utf-8", noindex);
      }
      if (rest.startsWith("/api/")) {
        const cFile = join(data, id, "comments.json");
        const handled = await handleApi(req, res, rest.slice(5), {
          doc: () => hit.doc,
          file: (f) => hit.reader.read(f),
          comments: () => readComments(cFile, hit.reader),
          addComment: (c) => { appendComment(cFile, c, hit.reader); },
        });
        if (handled) return;
      }
      return send(res, 404, "not found");
    }

    // Index: unlisted by default; only with ?token=<server token>.
    if (p === "/" && tokenOk(url.searchParams.get("token"))) {
      const metas = readdirSync(data).filter((d) => ID_RE.test(d)).map(readMeta).filter((x): x is Meta => !!x)
        .sort((a, b) => b.updated.localeCompare(a.updated));
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      const rows = metas.map((x) => `<li><a href="/d/${x.id}">${esc(x.title)}</a> <small>${esc(x.kind)} · ${esc(x.updated)}</small></li>`).join("");
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>recap docs</title><body style="font:14px system-ui;margin:24px"><h1>docs (${metas.length})</h1><ul>${rows}</ul>`,
        "text/html; charset=utf-8", { "x-robots-tag": "noindex" });
    }
    send(res, 404, "not found");
  }));

  await new Promise<void>((ok, err) => { server.once("error", err); server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", ok); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host ?? "127.0.0.1"}:${port}/`,
    close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }),
  };
}
