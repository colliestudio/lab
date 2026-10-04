// `recap publish`: zip a bundle (dir → in memory) and upload it to a `recap server`.
// First publish returns an edit secret; it's kept in `.recap-publish.json` next to the bundle so `--id` can re-publish.
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { openBundle, writeJsonAtomic } from "./bundle.ts";

const SKIP = new Set(["comments.json", ".DS_Store"]); // comments live server-side
const STORED = /\.(replay|zip|png|jpe?g|webp|gif|mp4|webm)$/i; // already compressed

export function zipBundle(bundlePath: string): Uint8Array {
  const path = resolve(bundlePath);
  if (!statSync(path).isDirectory()) return readFileSync(path);
  const b = openBundle(path);
  const entries: Zippable = {};
  for (const f of b.list()) {
    if (SKIP.has(f.split("/").pop()!)) continue;
    entries[f] = [b.read(f)!, { level: STORED.test(f) ? 0 : 6 }];
  }
  if (!entries["doc.md"]) throw new Error(`${bundlePath}: no doc.md`);
  return zipSync(entries);
}

export interface Published { id: string; url: string; secret?: string }

/** POST (new doc; the response carries its edit secret) or PUT `--id` (needs the server token or the edit secret). */
export async function publish(bundlePath: string, opts: { to: string; token?: string; id?: string; secret?: string }): Promise<Published> {
  const base = opts.to.replace(/\/+$/, "");
  const kind = /\.plan\/?$/.test(resolve(bundlePath)) ? "?kind=plan" : "";
  const headers: Record<string, string> = { "content-type": "application/zip" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.secret) headers["x-recap-edit-secret"] = opts.secret;
  const res = await fetch((opts.id ? `${base}/api/docs/${encodeURIComponent(opts.id)}` : `${base}/api/docs`) + kind, {
    method: opts.id ? "PUT" : "POST", headers, body: zipBundle(bundlePath) as Uint8Array<ArrayBuffer>,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`publish failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

// ---- .recap-publish.json: { "<server>": { "<bundle name>": { id, url, secret } } }, next to the bundle ----

export const recordFile = (bundlePath: string) => join(dirname(resolve(bundlePath)), ".recap-publish.json");
type Records = Record<string, Record<string, Published>>;
const serverKey = (to: string) => to.replace(/\/+$/, "");

function readRecords(file: string): Records {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}; } catch { return {}; }
}

/** The edit secret saved for doc `id` on server `to` (any bundle in the same folder), if any. */
export function savedSecret(bundlePath: string, to: string, id: string): string | undefined {
  const forServer = readRecords(recordFile(bundlePath))[serverKey(to)] ?? {};
  return Object.values(forServer).find((r) => r.id === id)?.secret;
}

export function saveRecord(bundlePath: string, to: string, r: Published): string {
  const file = recordFile(bundlePath);
  const all = readRecords(file);
  (all[serverKey(to)] ??= {})[basename(resolve(bundlePath))] = r;
  writeJsonAtomic(file, all);
  chmodSync(file, 0o600); // holds edit secrets
  return file;
}
