// Feedback without a server: readers comment in a single-file build (stored in their browser), copy the comments as
// Markdown and paste them back to the author; `recap comments x.review --import` turns that text into comments.json.
// Shared by the viewer (copy) and the CLI (import). No Node APIs here.
import type { Block, Comment, Doc } from "./model.ts";

type Anchor = Comment["anchor"];

export const BLOCK_NAME: Record<Block["type"], string> = {
  markdown: "Text", callout: "Callout", flow: "Flow", demo: "Demo", "before-after": "Before / after", "data-model": "Data model",
  api: "API", steps: "Steps", questions: "Decisions", checklist: "How to verify", files: "Files", diff: "Diff", code: "Code",
};

const clip = (s: string, n = 120) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const firstLine = (s: string | undefined) => clip((s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "");

function findBlock(doc: Doc, id: string): Block | undefined {
  for (const b of doc.overviewBlocks ?? []) if (b.id === id) return b;
  for (const s of doc.sections) for (const b of s.blocks) if (b.id === id) return b;
  return undefined;
}

/** The text of new-side line `line` of `file`, from the patch or any diff block (key builds keep only the blocks). */
function lineText(doc: Doc, file: string, line: number): { t: string; s: string } | undefined {
  const hunks = [
    ...(doc.files.find((f) => f.path === file)?.hunks ?? []),
    ...[...(doc.overviewBlocks ?? []), ...doc.sections.flatMap((s) => s.blocks)].flatMap((b) => (b.type === "diff" && b.file === file ? b.hunks : [])),
  ];
  for (const h of hunks) for (const l of h.lines) if (l.new === line) return { t: l.t, s: l.s };
  for (const b of [...(doc.overviewBlocks ?? []), ...doc.sections.flatMap((s) => s.blocks)]) {
    if (b.type === "code" && b.file === file && b.code) {
      const i = line - (b.start ?? 1), ls = b.code.split("\n");
      if (i >= 0 && i < ls.length) return { t: " ", s: ls[i] };
    }
  }
  return undefined;
}

function blockQuote(b: Block): string {
  switch (b.type) {
    case "markdown": case "callout": return firstLine(b.md);
    case "flow": return b.caption ? clip(b.caption) : firstLine(b.mermaid.replace(/^\s*(%%.*\n\s*)*\w[\w-]*( [A-Z]{2})?\s*\n/, ""));
    case "demo": return clip(b.caption ?? b.src);
    case "before-after": return clip(b.caption ?? b.after.caption ?? b.before.caption ?? "");
    case "data-model": return clip(b.entities.map((e) => e.name).join(", "));
    case "api": return clip(b.endpoints.map((e) => `${e.method} ${e.path}`).join(", "));
    case "steps": return clip(b.steps[0]?.title ?? "");
    case "questions": return clip(b.questions[0]?.q ?? "");
    case "checklist": return clip(b.items[0] ?? "");
    case "files": return clip((b.paths ?? Object.keys(b.notes)).join(", "));
    case "diff": {
      const l = b.hunks.flatMap((h) => h.lines).find((x) => x.t !== " ");
      return l ? clip(`${l.t} ${l.s}`) : b.range ? `${b.file}:${b.range[0]}-${b.range[1]}` : b.file;
    }
    case "code": return firstLine(b.code) || (b.file ?? "");
  }
}

/** Human label + one quoted line of context for a comment anchor. */
export function anchorContext(doc: Doc, a: Anchor): { label: string; quote: string } {
  const sec = a.section ? doc.sections.find((s) => s.id === a.section) : undefined;
  const blk = a.block ? findBlock(doc, a.block) : undefined;
  const parts: string[] = [];
  if (sec) parts.push(sec.title);
  else if (blk && a.block?.startsWith("overview-")) parts.push("Overview");
  else if (a.section) parts.push(a.section);
  if (blk) {
    const file = blk.type === "diff" ? blk.file : blk.type === "code" ? blk.file : undefined;
    parts.push(`${BLOCK_NAME[blk.type]}${file && !a.file ? ` ${file}` : ""}`);
  } else if (a.block) parts.push(a.block);
  if (a.file) parts.push(a.line != null ? `${a.file}:${a.line}` : a.file);
  const label = parts.join(" › ") || doc.title || "Document";

  let quote = "";
  if (a.file && a.line != null) {
    const l = lineText(doc, a.file, a.line);
    if (l) quote = clip(`${l.t === " " ? "" : l.t + " "}${l.s.trim()}`);
  } else if (blk) quote = blockQuote(blk);
  else if (sec) quote = firstLine(sec.summary);
  else if (!a.section && !a.block && !a.file) quote = clip(doc.tldr);
  return { label, quote };
}

const anchorLine = (a: Anchor) =>
  (["section", "block", "file", "line"] as const).filter((k) => a[k] != null).map((k) => `${k}=${a[k]}`).join(" ");

/**
 * The text a reader pastes back:
 *
 *   # Feedback: <title>
 *   review · head 4f680ea · 2 comments
 *
 *   ## 1. <section › block › file:line>
 *   anchor: section=<id> block=<id> file=<path> line=<n>
 *   > <one line of context>
 *
 *   <comment>
 */
export function feedbackMarkdown(doc: Doc, comments: Pick<Comment, "anchor" | "body" | "author">[]): string {
  const head = [doc.kind, doc.meta.head && `head ${doc.meta.head}`, `${comments.length} comment${comments.length === 1 ? "" : "s"}`];
  const authors = [...new Set(comments.map((c) => c.author).filter((x) => x && x !== "reader" && x !== "anonymous"))];
  if (authors.length) head.push(`from ${authors.join(", ")}`);
  const out = [`# Feedback: ${doc.title || "(untitled)"}`, head.filter(Boolean).join(" · "), ""];
  comments.forEach((c, i) => {
    const { label, quote } = anchorContext(doc, c.anchor);
    out.push(`## ${i + 1}. ${label}`);
    const al = anchorLine(c.anchor);
    if (al) out.push(`anchor: ${al}`);
    if (quote) out.push(`> ${quote}`);
    out.push("", c.body.trim(), "");
  });
  return out.join("\n").replace(/\n+$/, "\n");
}

export interface ParsedFeedback { anchor: Anchor; body: string; author?: string }

/** Best-effort parse of `feedbackMarkdown` output (also after a chat app mangled the whitespace a bit). */
export function parseFeedback(text: string, doc?: Doc): ParsedFeedback[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const from = /·\s*from\s+(.+?)\s*$/m.exec(lines.slice(0, 5).join("\n"))?.[1];
  const author = from && !from.includes(",") ? from : undefined;
  const out: ParsedFeedback[] = [];
  let cur: { label: string; anchor: Anchor | null; body: string[]; inQuote: boolean } | null = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n").trim();
    if (body) {
      let anchor = cur.anchor;
      if (!anchor) {
        const title = cur.label.split(" › ")[0].trim();
        const s = doc?.sections.find((x) => x.title === title);
        anchor = s ? { section: s.id } : {};
      }
      out.push({ anchor, body, ...(author ? { author } : {}) });
    }
    cur = null;
  };
  for (const raw of lines) {
    const h = /^\s*#{2,3}\s+\d+[.)]\s*(.*)$/.exec(raw);
    if (h) { flush(); cur = { label: h[1], anchor: null, body: [], inQuote: true }; continue; }
    if (!cur) continue;
    const a = /^\s*anchor:\s*(.*)$/i.exec(raw);
    if (a && !cur.anchor && !cur.body.some((l) => l.trim())) { cur.anchor = parseAnchor(a[1]); continue; }
    // the quoted context sits right after the heading/anchor; quotes later on are the reader's own
    if (cur.inQuote && /^\s*>/.test(raw)) continue;
    if (cur.inQuote && !raw.trim()) continue;
    cur.inQuote = false;
    cur.body.push(raw);
  }
  flush();
  return out;
}

function parseAnchor(s: string): Anchor {
  const a: Anchor = {};
  for (const m of s.matchAll(/(section|block|file|line)=(\S+)/g)) {
    if (m[1] === "line") { const n = Number(m[2]); if (Number.isInteger(n)) a.line = n; }
    else a[m[1] as "section" | "block" | "file"] = m[2];
  }
  return a;
}
