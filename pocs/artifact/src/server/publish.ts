// `recap publish`: zip a bundle (dir → in memory) and upload it to a `recap server`.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { openBundle } from "./bundle.ts";

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

export async function publish(bundlePath: string, opts: { to: string; token?: string; id?: string }): Promise<{ id: string; url: string }> {
  const base = opts.to.replace(/\/+$/, "");
  const res = await fetch(opts.id ? `${base}/api/docs/${encodeURIComponent(opts.id)}` : `${base}/api/docs`, {
    method: opts.id ? "PUT" : "POST",
    headers: { "content-type": "application/zip", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: zipBundle(bundlePath) as Uint8Array<ArrayBuffer>,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`publish failed: ${res.status} ${text}`);
  return JSON.parse(text);
}
