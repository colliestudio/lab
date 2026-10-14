// `recap server`: hosted / self-hosted. Upload = zip bundle; unlisted random ids; comments server-side.
// Storage per doc: <data>/<id>/{bundle.review (zip), doc.json, meta.json, comments.json}.
// Every upload is untrusted: parsed without touching server disk (no `plan:` paths), unzip capped, files served passive.
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Doc } from "../model.ts";
import { linkPlan, loadBundle } from "../parse/index.ts";
import { appendComment, readComments, UPLOAD_LIMITS, writeJsonAtomic, zipReader, type BundleReader, type ZipLimits } from "./bundle.ts";
import { guard, handleApi, handleAsset, readBody, send, sendJson, sendViewer } from "./http.ts";
import type { Running } from "./serve.ts";

const ID_RE = /^[A-Za-z0-9]{10}$/;
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes
export const newId = () => [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const CACHE_MAX = 32;

/** editHash: sha256 of the per-doc edit secret returned once by the first publish (PUT needs it or the server token). */
interface Meta { id: string; title: string; kind: string; created: string; updated: string; editHash?: string }

export interface HostedOptions {
  data: string; port?: number; host?: string; token?: string;
  /** Unzip caps for uploads (tests lower them). */
  limits?: ZipLimits;
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

export async function startHosted(opts: HostedOptions): Promise<Running> {
  const host = opts.host ?? "127.0.0.1";
  if (!opts.token && !LOOPBACK.has(host)) {
    throw new Error(`refusing to listen on ${host} without a token (anyone could publish); pass --token or RECAP_TOKEN`);
  }
  const data = resolve(opts.data);
  mkdirSync(data, { recursive: true });
  const limits = opts.limits ?? UPLOAD_LIMITS;
  const cache = new Map<string, { doc: Doc; reader: BundleReader }>(); // LRU: Map keeps insertion order

  const tokenOk = (s: string | null | undefined) => !!opts.token && safeEqual(s ?? "", opts.token);
  const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const canCreate = (req: IncomingMessage) => !opts.token || tokenOk(bearer(req));
  const canEdit = (req: IncomingMessage, meta: Meta) => {
    if (tokenOk(bearer(req))) return true;
    const secret = req.headers["x-recap-edit-secret"];
    return typeof secret === "string" && !!meta.editHash && safeEqual(sha256hex(secret), meta.editHash);
  };

  /** Parses the upload, then swaps it in; comments.json is left alone (re-publish keeps comments). */
  async function store(id: string, zip: Buffer, kind: "review" | "plan", prev: Meta | undefined): Promise<{ meta: Meta; secret?: string }> {
    const dir = join(data, id);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `upload-${randomBytes(4).toString("hex")}.${kind}`);
    let doc: Doc;
    try {
      zipReader(zip, limits); // non-zip bodies and zip bombs fail here, before the parser inflates anything
      writeFileSync(tmp, zip);
      doc = (await loadBundle(tmp, { linkPlan: false })).doc; // never resolve `plan:` against server disk
    } catch (e) {
      rmSync(tmp, { force: true });
      if (!prev) rmSync(dir, { recursive: true, force: true });
      throw Object.assign(new Error(`invalid bundle: ${(e as Error).message}`), { status: 400 });
    }
    renameSync(tmp, join(dir, "bundle.review"));
    writeJsonAtomic(join(dir, "doc.json"), doc);
    const now = new Date().toISOString();
    const secret = prev ? undefined : randomBytes(18).toString("base64url");
    const meta: Meta = {
      id, title: doc.title, kind: doc.kind, created: prev?.created ?? now, updated: now,
      editHash: prev ? prev.editHash : sha256hex(secret!),
    };
    writeJsonAtomic(join(dir, "meta.json"), meta);
    cache.delete(id);
    return { meta, secret };
  }
  const readMeta = (id: string): Meta | undefined => {
    if (!ID_RE.test(id)) return undefined;
    try { return JSON.parse(readFileSync(join(data, id, "meta.json"), "utf8")); } catch { return undefined; }
  };
  const open = (id: string) => {
    if (!ID_RE.test(id) || !existsSync(join(data, id, "doc.json"))) return undefined;
    let hit = cache.get(id);
    if (hit) cache.delete(id); // re-insert below: most recent last
    else hit = { doc: JSON.parse(readFileSync(join(data, id, "doc.json"), "utf8")), reader: zipReader(readFileSync(join(data, id, "bundle.review"))) };
    cache.set(id, hit);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return hit;
  };

  /**
   * A review's `plan:` on this server links only to another doc stored here: a bare id, `/d/<id>`, or
   * `<this server>/d/<id>`. Resolved per request, so a re-published plan shows up at once.
   */
  const withPlan = (req: IncomingMessage, doc: Doc): Doc => {
    const plan = doc.meta.plan;
    if (doc.kind !== "review" || !plan) return doc;
    const m = /^(?:https?:\/\/([^/]+))?\/d\/([A-Za-z0-9]{10})\/?$/.exec(plan) ?? /^()([A-Za-z0-9]{10})$/.exec(plan);
    const target = m && (!m[1] || m[1] === req.headers.host) ? open(m[2])?.doc : undefined;
    if (target?.kind === "plan") return { ...doc, planLink: linkPlan(doc, target, plan) };
    return { ...doc, warnings: [...doc.warnings, `plan "${plan}" not linked: on a server, plan: must be the id or /d/<id> link of a plan published to the same server`] };
  };
  const docUrl = (req: IncomingMessage, id: string) => {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
    return `${proto}://${req.headers.host}/d/${id}`;
  };

  const server = createServer(guard(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname, m = req.method ?? "GET";
    const kind = url.searchParams.get("kind") === "plan" ? "plan" : "review";

    if (p === "/api/docs" && m === "POST") {
      if (!canCreate(req)) return sendJson(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      let id = newId();
      while (existsSync(join(data, id))) id = newId();
      const { secret } = await store(id, body, kind, undefined);
      return sendJson(res, 201, { id, url: docUrl(req, id), secret });
    }
    let r = /^\/api\/docs\/([^/]+)$/.exec(p);
    if (r && m === "PUT") {
      const meta = readMeta(r[1]);
      if (!meta) return sendJson(res, 404, { error: "no such doc" });
      if (!canEdit(req, meta)) return sendJson(res, 401, { error: "unauthorized: needs the server token or this doc's edit secret" });
      await store(r[1], await readBody(req), kind, meta);
      return sendJson(res, 200, { id: r[1], url: docUrl(req, r[1]) });
    }
    if (handleAsset(req, res, p)) return;

    r = /^\/d\/([^/]+)(\/.*)?$/.exec(p);
    if (r) {
      const id = r[1], rest = r[2] ?? "", hit = open(id);
      if (!hit) return send(res, 404, "not found");
      if (rest === "" || rest === "/") {
        return sendViewer(res, { doc: withPlan(req, hit.doc), api: `/d/${id}/api` }, { headers: { "x-robots-tag": "noindex" } });
      }
      if (rest.startsWith("/api/")) {
        const cFile = join(data, id, "comments.json");
        const handled = await handleApi(req, res, rest.slice(5), {
          doc: () => withPlan(req, hit.doc),
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
      const metas = readdirSync(data).map(readMeta).filter((x): x is Meta => !!x)
        .sort((a, b) => b.updated.localeCompare(a.updated));
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      const rows = metas.map((x) => `<li><a href="/d/${x.id}">${esc(x.title)}</a> <small>${esc(x.kind)} · ${esc(x.updated)}</small></li>`).join("");
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>recap docs</title><body style="font:14px system-ui;margin:24px"><h1>docs (${metas.length})</h1><ul>${rows}</ul>`,
        "text/html; charset=utf-8", { "x-robots-tag": "noindex", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "referrer-policy": "no-referrer" });
    }
    send(res, 404, "not found");
  }));

  await new Promise<void>((ok, err) => { server.once("error", err); server.listen(opts.port ?? 0, host, ok); });
  const { port } = server.address() as AddressInfo;
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shown}:${port}/`,
    close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }),
  };
}
