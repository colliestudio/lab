// GitHub URLs and text autolinking for a PR (pure: no React, no registry, usable from tests and scripts).

/** What the links need from data/pr.json (as written by `artifact gather gh-pr`). */
export interface PrLinkInfo {
  repo: string; n: number; url?: string; headSha?: string; baseSha?: string; head?: string; base?: string;
  files?: { path: string; oldPath?: string }[]; commits?: { sha: string; oid?: string }[];
}
export interface GhUrls {
  /** the PR page */
  pr(n?: number): string;
  issue(n: number): string;
  commit(sha: string): string;
  /** `side: "base"` (default "head") picks the file at the base commit; `line` or `[from, to]` adds the #L anchor */
  file(path: string, line?: number | [number, number], o?: { side?: "base" | "head" | string }): string;
  /** the file in the PR's "Files changed" tab (`side: "base"` anchors the old line, L instead of R) */
  diff(path: string, line?: number, o?: { side?: "base" | "head" }): string;
  /** the PR's Files changed tab */
  files(): string;
  checks(): string;
  branch(name: string): string;
  user(login: string): string;
  /** an inline review comment of the PR by its id */
  comment(id: string | number): string;
  /** the repo page */
  repo: string;
}

const lines = (l?: number | [number, number]) => (l == null ? "" : Array.isArray(l) && l[1] !== l[0] ? `#L${l[0]}-L${l[1]}` : `#L${Array.isArray(l) ? l[0] : l}`);
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export function makeGhUrl(pr: PrLinkInfo): GhUrls {
  const repo = `https://github.com/${pr.repo}`;
  const prUrl = () => pr.url ?? `${repo}/pull/${pr.n}`;
  const ref = (side?: string) => side === "base" ? pr.baseSha ?? pr.base ?? "HEAD" : side && side !== "head" ? side : pr.headSha ?? pr.head ?? "HEAD";
  return {
    repo,
    pr: (n) => (n == null || n === pr.n ? prUrl() : `${repo}/pull/${n}`),
    issue: (n) => `${repo}/issues/${n}`,
    commit: (sha) => `${repo}/commit/${sha}`,
    file: (path, line, o) => `${repo}/blob/${ref(o?.side)}/${enc(path)}${lines(line)}`,
    diff: (path, line, o) => `${prUrl()}/files#diff-${sha256(path)}${line != null ? (o?.side === "base" ? "L" : "R") + line : ""}`,
    files: () => `${prUrl()}/files`,
    checks: () => `${prUrl()}/checks`,
    branch: (name) => `${repo}/tree/${enc(name)}`,
    user: (login) => `https://github.com/${login}`,
    comment: (id) => `${prUrl()}#discussion_r${id}`,
  };
}

// ---- autolink -----------------------------------------------------------------------------------------------------

export type Part = { t: "text"; s: string } | { t: "link"; s: string; href: string } | { t: "code"; s: string; href?: string };
const RE = /(`[^`\n]+`)|(https?:\/\/[^\s<>)\]]+)|(\b[\w.-]+\/[\w.-]+#\d+\b)|((?<![\w&/#])#\d+\b)/g;
const FILE = /^([\w@.\-/]+\.\w+)(?::(\d+)(?:-(\d+))?)?$/;

/**
 * Split text into plain text, links and code spans: URLs, `#123`, `owner/repo#123`, and `file.ext:12` / `sha` in backticks
 * (a file only when the PR changes it, or it has a folder; a sha is 7 to 40 hex characters).
 */
export function linkify(text: string, pr?: PrLinkInfo): Part[] {
  const gh = pr ? makeGhUrl(pr) : undefined;
  const out: Part[] = [];
  let at = 0;
  const push = (p: Part) => { const last = out[out.length - 1]; if (p.t === "text" && last?.t === "text") last.s += p.s; else out.push(p); };
  for (const m of text.matchAll(RE)) {
    const i = m.index!;
    if (i > at) push({ t: "text", s: text.slice(at, i) });
    at = i + m[0].length;
    if (m[1]) {
      const inner = m[1].slice(1, -1);
      const f = gh && inner.match(FILE);
      const known = f && (pr!.files?.some((x) => x.path === f[1] || x.path.endsWith("/" + f[1]) || x.oldPath === f[1]) || f[1].includes("/"));
      if (known) {
        const full = pr!.files?.find((x) => x.path === f![1] || x.path.endsWith("/" + f![1]))?.path ?? f![1];
        push({ t: "code", s: inner, href: gh!.file(full, f![2] ? (f![3] ? [Number(f![2]), Number(f![3])] : Number(f![2])) : undefined) });
      } else if (gh && /^[0-9a-f]{7,40}$/.test(inner)) push({ t: "code", s: inner, href: gh.commit(inner) });
      else push({ t: "code", s: inner });
    } else if (m[2]) {
      const url = m[2].replace(/[.,;:!?]+$/, "");
      push({ t: "link", s: url, href: url });
      at = i + url.length;
    } else if (m[3]) {
      const [r, n] = m[3].split("#");
      push({ t: "link", s: m[3], href: `https://github.com/${r}/issues/${n}` });
    } else if (gh) push({ t: "link", s: m[4], href: gh.issue(Number(m[4].slice(1))) });
    else push({ t: "text", s: m[4] });
  }
  if (at < text.length) push({ t: "text", s: text.slice(at) });
  return out;
}

// ---- sha256 (GitHub anchors a file in the PR diff by the hash of its path) -----------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const n = bytes.length, len = (((n + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(len); buf.set(bytes); buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(len - 8, Math.floor((n * 8) / 2 ** 32)); dv.setUint32(len - 4, (n * 8) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rr = (x: number, k: number) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < len; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const a = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3), b = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + a + w[i - 7] + b) | 0; }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
}
