// Human descriptions of what a comment is about, and text-range anchors (quote + context) that survive reloads.
// The CSS path / id of an anchor stays hidden data for re-anchoring; readers see labels and quotes.

const short = (s: string, n = 60) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
export const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** Rendered text (block boundaries become spaces), collapsed. */
export const textOf = (el: Element) => norm((el as HTMLElement).innerText || el.textContent || "");

const KIT: Record<string, string> = {
  actions: "actions", callout: "callout", card: "card", chart: "chart", checklist: "checklist", code: "code", compare: "comparison", decision: "Decision", "decisions-index": "decision list",
  diff: "diff", facts: "facts", figure: "figure", flow: "flow diagram", gallery: "gallery", lane: "lane", map: "map", more: "details", pagecards: "page cards", pr: "pull request",
  questions: "questions", replay: "replay", riskmatrix: "risk matrix", scorecard: "scorecard", source: "source", stages: "stages", stale: "stale note", stats: "stats",
  steps: "steps", table: "table", tabs: "tabs", timeaxis: "timeline", timeline: "timeline", walkthrough: "walkthrough",
};

/** A short human label for an element: "image: alt", "chart: title", "Decision: question", `table cell "text"`, or its text snippet. */
export function labelFor(el: Element): string {
  const e = el as HTMLElement;
  const text = textOf(el);
  const c = e.dataset?.c;
  if (c === "decision") return `Decision: ${short(e.dataset.q || text)}`;
  if (c) {
    const title = e.getAttribute("aria-label") || e.dataset.title || norm(e.querySelector("figcaption, caption, h3, h4, .a-card-head b, b")?.textContent ?? "") || text;
    return `${KIT[c] ?? c}${title ? `: ${short(title)}` : ""}`;
  }
  const tag = el.tagName.toLowerCase();
  if (tag === "img") return `image: ${(el as HTMLImageElement).alt || "(no alt)"}`;
  if (tag === "figure") { const i = el.querySelector("img"); return `image: ${i?.alt || short(text) || "(no alt)"}`; }
  if (tag === "svg") return `diagram: ${short(el.getAttribute("aria-label") || el.querySelector("title")?.textContent || text) || "(unlabelled)"}`;
  if (tag === "canvas" || tag === "video") return tag;
  const q = (s: string) => (s ? `"${short(s)}"` : "");
  if (tag === "td" || tag === "th") return `table cell ${q(text)}`.trim();
  if (tag === "tr") return `table row ${q([...el.children].slice(0, 3).map(textOf).join(" | "))}`.trim();
  if (tag === "pre") return `code ${q((el.textContent ?? "").split("\n").find((l) => l.trim()) ?? "")}`.trim();
  if (tag === "li") return `list item ${q(text)}`.trim();
  if (/^h[1-6]$/.test(tag)) return `heading ${q(text)}`.trim();
  if (tag === "button") return `button ${q(text)}`.trim();
  if (e.matches("[data-section]")) return `section ${q(e.dataset.title ?? text)}`.trim();
  return q(text) || tag;
}

/** The title of the Section/Slide that holds `el`, else of the nearest heading above it. */
export function whereFor(el: Element, root: Element): string {
  let sec = el.closest<HTMLElement>("[data-section]");
  if (sec === el) sec = sec.parentElement?.closest<HTMLElement>("[data-section]") ?? null; // a Section's own heading: describe it by its parent
  if (sec && root.contains(sec)) return sec.dataset.title ?? "";
  let last = "";
  for (const h of root.querySelectorAll("h1, h2, h3, h4")) {
    if (h.contains(el) || el.contains(h)) continue;
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) last = norm(h.textContent ?? ""); else break;
  }
  return short(last, 70);
}

// --- text ranges ---

interface Flat { text: string; map: { n: Text; o: number }[] }
const inlineCache = new WeakMap<Element, boolean>();
const isInline = (e: Element) => { let v = inlineCache.get(e); if (v == null) { v = getComputedStyle(e).display.startsWith("inline"); inlineCache.set(e, v); } return v; };

/** The text of a subtree with whitespace collapsed (and a space between blocks), each character mapped back to its text node. */
export function flatten(root: Node): Flat {
  const out: Flat = { text: "", map: [] };
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let lastBlock: Element | null = null;
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    const p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
    if (lastBlock && p !== lastBlock && out.text && !out.text.endsWith(" ") && !isInline(p) ) { out.text += " "; out.map.push({ n, o: 0 }); }
    lastBlock = p;
    const d = n.data;
    for (let i = 0; i < d.length; i++) {
      if (/\s/.test(d[i])) { if (out.text && !out.text.endsWith(" ")) { out.text += " "; out.map.push({ n, o: i }); } }
      else { out.text += d[i]; out.map.push({ n, o: i }); }
    }
  }
  return out;
}

/** The Range holding `quote` (preferring the occurrence with the given text before/after it) inside `root`. */
export function textRange(root: Node, quote: string, before = "", after = ""): Range | null {
  const q = norm(quote);
  if (!q) return null;
  const f = flatten(root);
  let best = -1, bestScore = -1;
  for (let i = f.text.indexOf(q); i >= 0; i = f.text.indexOf(q, i + 1)) {
    const b = before ? norm(before) : "", a = after ? norm(after) : "";
    const pre = f.text.slice(Math.max(0, i - b.length), i), post = f.text.slice(i + q.length, i + q.length + a.length);
    const score = (b && pre.trim().endsWith(b.trim()) ? 1 : 0) + (a && post.trim().startsWith(a.trim()) ? 1 : 0);
    if (score > bestScore) { best = i; bestScore = score; if (score === (b ? 1 : 0) + (a ? 1 : 0)) break; }
  }
  if (best < 0) return null;
  const s = f.map[best], e = f.map[best + q.length - 1];
  if (!s || !e) return null;
  const r = document.createRange();
  r.setStart(s.n, s.o); r.setEnd(e.n, e.o + 1);
  return r;
}

/** Up to 32 characters of text on each side of a selection, taken inside `el`. */
export function contextOf(range: Range, el: Element): { before: string; after: string } {
  const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(range.startContainer, range.startOffset);
  const post = document.createRange(); post.selectNodeContents(el); post.setStart(range.endContainer, range.endOffset);
  return { before: norm(pre.toString()).slice(-32), after: norm(post.toString()).slice(0, 32) };
}

// --- highlights (CSS Custom Highlight API; falls back to nothing, the element mark still shows) ---
type HL = { set(name: string, h: unknown): void; delete(name: string): void };
const hls = (): HL | undefined => (typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: HL }).highlights : undefined);
export function setHighlight(name: string, ranges: Range[]): void {
  const h = hls(), H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!h || !H) return;
  if (ranges.length) h.set(name, new H(...ranges)); else h.delete(name);
}
