// `check` advice: taste warnings that never fail a build. They read the server-rendered HTML (everything visible at depth 4).
import { execFileSync } from "node:child_process";
import type { Meta } from "../kit/registry.ts";

interface N { tag: string; attrs: string; kids: N[]; text?: string; parent?: N }
const VOID = new Set(["img", "br", "hr", "input", "meta", "link", "source", "col", "wbr"]);

export function parseHtml(html: string): N {
  const root: N = { tag: "#root", attrs: "", kids: [] };
  let cur = root;
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g)) {
    if (m[0].startsWith("<!--")) continue;
    if (m[5] != null) { cur.kids.push({ tag: "#text", attrs: "", kids: [], text: m[5].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'"), parent: cur }); continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) { let n: N | undefined = cur; while (n && n.tag !== tag) n = n.parent; if (n?.parent) cur = n.parent; continue; }
    const node: N = { tag, attrs: m[3], kids: [], parent: cur };
    cur.kids.push(node);
    if (!VOID.has(tag) && !m[4]) cur = node;
  }
  return root;
}
const attr = (n: N, k: string) => n.attrs.match(new RegExp(`(?:^|\\s)${k}="([^"]*)"`))?.[1];
const textOf = (n: N, skip?: (n: N) => boolean): string => (n.tag === "#text" ? n.text ?? "" : skip?.(n) ? "" : n.kids.map((k) => textOf(k, skip)).join(" "));
function* walk(n: N): Generator<N> { yield n; for (const k of n.kids) yield* walk(k); }
const inside = (n: N, pred: (a: N) => boolean) => { for (let a = n.parent; a; a = a.parent) if (pred(a)) return true; return false; };
const words = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? [];

export interface Advice { warnings: string[]; stats: { screens: number } }

export function advise(html: string, meta: Pick<Meta, "summary">): Advice {
  const root = parseHtml(html);
  const out: string[] = [];
  const all = [...walk(root)];

  // 1. the first callout restates the summary (the host prints the summary large under the title)
  if (meta.summary) {
    const co = all.find((n) => attr(n, "data-c") === "callout");
    if (co) {
      const a = new Set(words(textOf(co))), b = new Set(words(meta.summary));
      const common = [...a].filter((w) => b.has(w)).length;
      if (Math.min(a.size, b.size) >= 5 && common / Math.min(a.size, b.size) >= 0.6) out.push("the first Callout repeats the summary; the header already shows it large, so say something new or drop the Callout");
    }
  }

  // 2. length: rough screens at depth 4 (the reader sees them all unless artifact.json sets "depth")
  const body = all.find((n) => attr(n, "class")?.includes("a-content")) ?? root;
  const nw = words(textOf(body)).length;
  const heavy = [...walk(body)].filter((n) => ["figure", "svg"].includes(n.tag) || ["map", "chart", "diff", "code", "replay", "flow", "gallery", "scorecard", "riskmatrix"].includes(attr(n, "data-c") ?? "")).length;
  const rows = [...walk(body)].filter((n) => n.tag === "tr").length;
  const screens = Math.round((nw / 300 + heavy * 0.5 + rows * 0.04) * 10) / 10;
  if (screens > 6) out.push(`long page (about ${screens} screens): put supporting detail in <More>, fold sections, or cut`);

  // 3. big table outside <Depth>
  for (const t of all.filter((n) => n.tag === "table" && !attr(n, "class")?.includes("a-diff"))) {
    const r = [...walk(t)].filter((n) => n.tag === "tr").length - 1;
    if (r > 20 && !inside(t, (a) => (attr(a, "class") ?? "").split(" ").includes("a-more")) && !attr(t.parent ?? t, "class")?.includes("a-heavy-body")) out.push(`a table with ${r} rows is open on the page: wrap it in <More label="…"> (or give the Table \`collapsed\`), or cut it to the rows that matter`);
  }

  // 4. a slide that shows nothing at step 0 (only its heading)
  for (const s of all.filter((n) => attr(n, "data-section") != null && !inside(n, (a) => attr(a, "data-section") != null))) {
    const hasStep = [...walk(s)].some((n) => attr(n, "data-step") != null);
    const visible = textOf(s, (n) => attr(n, "data-step") != null || ["h2", "h3", "button"].includes(n.tag)).trim();
    if (hasStep && !visible) out.push(`present: the slide "${attr(s, "data-title")}" is empty at step 0 (everything is in <Step>): put its lead line outside the Steps`);
  }

  // 5. every Decision batched in the last Section: put each next to its evidence, and what is asked of the reader up top
  const tops = all.filter((n) => attr(n, "data-section") != null && !inside(n, (a) => attr(a, "data-section") != null));
  const decs = all.filter((n) => attr(n, "data-c") === "decision");
  if (tops.length >= 3 && decs.length) {
    const last = tops[tops.length - 1];
    if (decs.every((d) => inside(d, (a) => a === last))) out.push(`all ${decs.length} Decision${decs.length > 1 ? "s are" : " is"} in the last Section: put each next to the evidence it depends on, and list what you need from the reader up top (<DecisionIndex />)`);
  }
  return { warnings: out, stats: { screens } };
}

export type Exec = (cmd: string, args: string[]) => string;
const sh: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Commit SHAs cited as `kind="commit"` sources (code or artifact.json) that no remote branch of `repo` contains. Best effort. */
export function unpublishedCommits(source: string, meta: Pick<Meta, "sources">, repo: string, exec: Exec = sh): string[] {
  const shas = new Set<string>();
  for (const m of source.matchAll(/<Source\b[^>]*kind=["']commit["'][^>]*>/g)) for (const h of m[0].matchAll(/\b[0-9a-f]{7,40}\b/g)) shas.add(h[0]);
  for (const s of meta.sources ?? []) if (typeof s === "object" && s.kind === "commit") for (const h of `${s.label} ${s.href ?? ""}`.matchAll(/\b[0-9a-f]{7,40}\b/g)) shas.add(h[0]);
  const bad: string[] = [];
  for (const sha of shas) {
    try { if (!exec("git", ["-C", repo, "branch", "-r", "--contains", sha]).trim()) bad.push(sha); } catch { bad.push(sha); }
  }
  return bad;
}

/** Maps that would be drawn smaller than `min` of their natural size in a ~880 px column (node text gets unreadable). */
export async function smallMaps(maps: { nodes: { id: string; label: string; group?: string }[]; edges: { from: string; to: string; label?: string }[]; groups: { id: string; label: string }[]; direction?: string; height?: number }[], min = 0.65): Promise<string[]> {
  const { layoutMap, approxMeasure, groupCycle } = await import("../kit/map-layout.ts");
  const out: string[] = [];
  for (const [i, m] of maps.entries()) {
    const [right, down] = await Promise.all([layoutMap({ groups: m.groups ?? [], nodes: m.nodes, edges: m.edges ?? [] }, "RIGHT", approxMeasure), layoutMap({ groups: m.groups ?? [], nodes: m.nodes, edges: m.edges ?? [] }, "DOWN", approxMeasure)]);
    const maxH = Math.min(m.height ?? 560, 640);
    const scale = (l: { w: number; h: number }) => Math.min(880 / l.w, maxH / l.h, 1);
    const lay = m.direction === "right" ? right : m.direction === "down" ? down : scale(right) < 0.85 && scale(down) > scale(right) + 0.1 ? down : right;
    if (groupCycle({ groups: m.groups ?? [], nodes: m.nodes, edges: m.edges ?? [] })) out.push(`Map #${i + 1} has groups and an edge running back against the group order: the layout may come out jumbled; drop the groups, or reverse/remove the back edge`);
    const s = scale(lay);
    if (s < min) out.push(`Map #${i + 1} (${m.nodes.length} nodes) fits at about ${Math.round(s * 100)}%: too small to read; cut nodes, collapse groups, or try direction="down" with a taller height`);
  }
  return out;
}
