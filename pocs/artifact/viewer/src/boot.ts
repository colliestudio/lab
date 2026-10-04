import type { ViewerBoot, Comment } from "../../src/model.ts";

declare global {
  interface Window { __RECAP__?: ViewerBoot }
}

export async function loadBoot(): Promise<ViewerBoot | null> {
  if (window.__RECAP__) return window.__RECAP__;
  if (import.meta.env.DEV) {
    // Dev (`pnpm viewer:dev`): ?bundle=<repo-relative bundle path>, parsed by the real parser behind /dev-api.
    const name = new URLSearchParams(location.search).get("bundle") ?? "samples/recap-lab.review";
    const api = `/dev-api/${encodeURIComponent(name)}`;
    const doc = await fetch(`${api}/doc`).then((r) => (r.ok ? r.json() : null));
    return doc ? { doc, api } : null;
  }
  return null;
}

export type GetFile = (path: string) => Promise<Uint8Array>;

export function makeGetFile(boot: ViewerBoot): GetFile {
  const cache = new Map<string, Promise<Uint8Array>>();
  return (path) => {
    const p = path.replace(/^\.?\//, "");
    let hit = cache.get(p);
    if (!hit) {
      hit = (async () => {
        const b64 = boot.files?.[p];
        if (b64 != null) {
          const bin = atob(b64);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        }
        if (!boot.api) throw new Error(`file not in bundle: ${p}`);
        const r = await fetch(`${boot.api}/files/${p.split("/").map(encodeURIComponent).join("/")}`);
        if (!r.ok) throw new Error(`${r.status} fetching ${p}`);
        return new Uint8Array(await r.arrayBuffer());
      })();
      cache.set(p, hit);
    }
    return hit;
  };
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp", gif: "image/gif",
};
export function mimeOf(path: string) {
  return MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export type NewComment = Omit<Comment, "id" | "created">;

export const commentsApi = {
  async list(api: string): Promise<Comment[]> {
    const r = await fetch(`${api}/comments`);
    return r.ok ? r.json() : [];
  },
  async add(api: string, c: NewComment): Promise<void> {
    const r = await fetch(`${api}/comments`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c),
    });
    if (!r.ok) throw new Error(`comment failed: ${r.status}`);
  },
};
