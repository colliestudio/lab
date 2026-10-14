// Markdown renderings of a doc (SPEC §4). One renderer for `recap md` and the viewer's "Copy as Markdown":
//   renderMarkdown(doc)               the whole doc, readable as plain text (title, tl;dr, risk/ask, decisions, map
//                                     outline, sections with their blocks, key diffs as fenced `diff`)
//   renderMarkdown(doc, {section})    one section
//   renderSummary(doc, {link})        the short GitHub comment (headline + Mermaid map + section list + link)
// Code follows the doc's code level: a doc stripped by `--code none` renders diff/code blocks as placeholders.
// No Node APIs: the viewer bundles this file.

import type { Block, Change, Doc, Hunk, Question, Section, Shot } from "./model.ts";

export interface MdOptions {
  /** Only this section (id). */
  section?: string;
}

const KIND = { plan: "Plan", review: "Review" } as const;
const TONE = { info: "Note", warn: "Warning", risk: "Risk", decision: "Decision" } as const;
const CODE_NOTE = { key: "key changes only", none: "not included", full: "" } as const;

export function renderMarkdown(doc: Doc, opts: MdOptions = {}): string {
  if (opts.section) {
    const s = doc.sections.find((x) => x.id === opts.section);
    if (!s) throw new Error(`no section "${opts.section}"`);
    return join([`_From the ${doc.kind} "${doc.title}"_`, renderSection(doc, s, true)]);
  }
  const parts: string[] = [`# ${KIND[doc.kind]}: ${doc.title || "(untitled)"}`];
  if (doc.tldr) parts.push(quote(doc.tldr));
  parts.push(facts(doc).map((f) => `- ${f}`).join("\n"));
  if (doc.questions.length) parts.push("## Decisions needed", doc.questions.map((q, i) => `${i + 1}. ${question(q)}`).join("\n"));
  if (doc.map.nodes.length) parts.push("## Map", mapOutline(doc));
  // overview: questions are already "Decisions needed"
  const ov = (doc.overviewBlocks ?? []).filter((b) => b.type !== "questions");
  if (ov.length) parts.push(...ov.map((b) => renderBlock(doc, b)));
  else if (doc.overview) parts.push(doc.overview.trim());
  const secs = [...doc.sections.filter((s) => !s.mechanical), ...doc.sections.filter((s) => s.mechanical)];
  for (const s of secs) parts.push(renderSection(doc, s, false));
  return join(parts);
}

function facts(doc: Doc): string[] {
  const f: string[] = [];
  if (doc.risk) f.push(`**Risk:** ${doc.risk.level}${doc.risk.why ? `: ${doc.risk.why}` : ""}`);
  if (doc.ask) f.push(`**Ask:** ${doc.ask}`);
  if (doc.status) f.push(`**Status:** ${doc.status}`);
  if (doc.goal && doc.goal !== doc.tldr) f.push(`**Goal:** ${doc.goal}`);
  const m = doc.meta;
  if (m.base || m.head) f.push(`**Range:** ${[m.repo, `${m.base ?? "?"}...${m.head ?? "HEAD"}`].filter(Boolean).join(" ")}`);
  if (m.pr) f.push(`**PR:** ${m.pr}`);
  if (doc.stats) f.push(`**Diff:** ${doc.stats.files} files, +${doc.stats.additions} −${doc.stats.deletions}`);
  if (doc.codeLevel && doc.codeLevel !== "full") f.push(`**Code:** ${CODE_NOTE[doc.codeLevel]}`);
  if (doc.planLink) {
    const p = doc.planLink;
    f.push(`**Plan:** ${p.title || p.src}: ${p.done.length} done, ${p.notDone.length} not done, ${p.deferred.length} deferred, ${p.unplanned.length} unplanned`);
  }
  return f;
}

const question = (q: Question) =>
  `${q.q}${q.options?.length ? ` (${q.options.join(" / ")})` : ""}${q.recommend ? `; recommend **${q.recommend}**` : ""}${q.why ? `: ${q.why}` : ""}`;

/** Areas grouped, each with its change and section; then edges as `A → B: label`. */
export function mapOutline(doc: Doc): string {
  const label = (id: string) => doc.map.nodes.find((n) => n.id === id)?.label ?? id;
  const node = (n: Doc["map"]["nodes"][number]) => {
    const sec = n.section && doc.sections.find((s) => s.id === n.section);
    const bits = [n.mechanical ? "mechanical" : CHANGE[n.change], sec && sec.title !== n.label ? `see "${sec.title}"` : ""].filter(Boolean);
    return `**${n.label}** (${bits.join(", ")})${n.note ? `: ${n.note}` : ""}`;
  };
  const out: string[] = [];
  for (const g of doc.map.groups) {
    const members = doc.map.nodes.filter((n) => n.group === g.id);
    if (!members.length) continue;
    out.push(`- ${g.label}`, ...members.map((n) => `  - ${node(n)}`));
  }
  for (const n of doc.map.nodes) if (!n.group || !doc.map.groups.some((g) => g.id === n.group)) out.push(`- ${node(n)}`);
  if (doc.map.edges.length) {
    out.push("", "Connections:");
    for (const e of doc.map.edges) out.push(`- ${label(e.from)} → ${label(e.to)}${e.label ? `: ${e.label}` : ""}${e.change && e.change !== "unchanged" ? ` (${CHANGE[e.change]})` : ""}`);
  }
  return out.join("\n");
}

const CHANGE: Record<Change, string> = {
  added: "added", changed: "changed", removed: "removed", unchanged: "context", planned: "planned", deferred: "deferred",
};

function renderSection(doc: Doc, s: Section, alone: boolean): string {
  const node = doc.map.nodes.find((n) => n.section === s.id);
  const tags = [node && !node.mechanical ? CHANGE[node.change] : "", s.mechanical ? "mechanical" : ""].filter(Boolean);
  const parts = [`## ${s.title}${tags.length ? ` _(${tags.join(", ")})_` : ""}`];
  if (s.summary) parts.push(s.summary.trim());
  for (const b of s.blocks) if (alone || b.type !== "questions") parts.push(renderBlock(doc, b));
  return join(parts);
}

export function renderBlock(doc: Doc, b: Block): string {
  switch (b.type) {
    case "markdown": return b.md.trim();
    case "callout": return quote(`**${TONE[b.tone] ?? "Note"}:** ${b.md.trim()}`);
    case "flow": return join([fence("mermaid", b.mermaid), b.caption ? `_${b.caption}_` : ""]);
    case "demo": return `▶ recording: ${b.caption ?? b.src}${b.steps?.length ? ` (steps ${b.steps.join(", ")})` : ""} [${b.src}]`;
    case "before-after": {
      const shot = (s: Shot) =>
        [s.caption, s.demo ? `${s.demo}${s.step ? ` step ${s.step}` : ""}` : s.src].filter(Boolean).join(", ");
      return join([`◧ before / after${b.caption ? `: ${b.caption}` : ""}`, `- Before: ${shot(b.before)}\n- After: ${shot(b.after)}`]);
    }
    case "data-model":
      return b.entities.map((e) => [
        `- **${e.name}** (${CHANGE[e.change]})${e.note ? `: ${e.note}` : ""}`,
        ...e.fields.map((f) => `  - \`${f.name}${f.type ? `: ${f.type}` : ""}\` (${CHANGE[f.change]})${f.note ? `: ${f.note}` : ""}`),
      ].join("\n")).join("\n");
    case "api":
      return join(b.endpoints.map((e) => join([
        `- \`${e.method} ${e.path}\` (${CHANGE[e.change]})${e.summary ? `: ${e.summary}` : ""}`,
        e.request ? fence(/^\s*[{[]/.test(e.request) ? "json" : "", e.request, "  ") : "",
        e.response ? fence(/^\s*[{[]/.test(e.response) ? "json" : "", e.response, "  ") : "",
      ])));
    case "steps":
      return b.steps.map((s, i) => `${i + 1}. ${s.status === "done" ? "[x] " : s.status === "doing" ? "[~] " : ""}${s.title}${s.area ? ` _(${s.area})_` : ""}${s.detail ? `: ${oneLine(s.detail)}` : ""}`).join("\n");
    case "questions": return b.questions.map((q, i) => `${i + 1}. ${question(q)}`).join("\n");
    case "checklist": return b.items.map((x) => `- [ ] ${x}`).join("\n");
    case "files": {
      const paths = b.paths ?? (Object.keys(b.notes).length ? Object.keys(b.notes) : doc.files.map((f) => f.path));
      return paths.map((p) => {
        const f = doc.files.find((x) => x.path === p);
        return `- \`${p}\`${f ? ` +${f.additions} −${f.deletions}` : ""}${b.notes[p] ? `: ${b.notes[p]}` : ""}`;
      }).join("\n");
    }
    case "diff": {
      if (b.omitted || !b.hunks.length) return join([placeholder(doc, b.file, b.range), notes(b.notes)]);
      return join([`**\`${b.file}\`**`, fence("diff", b.hunks.map(hunkText).join("\n")), notes(b.notes)]);
    }
    case "code": {
      if (b.omitted) return join([placeholder(doc, b.file ?? "code", b.range), notes(b.notes ?? [])]);
      const start = b.start ?? 1;
      return join([b.file ? `**\`${b.file}\`**${start > 1 ? ` from line ${start}` : ""}` : "", fence(b.lang ?? "", b.code.replace(/\n$/, "")), notes(b.notes ?? [])]);
    }
  }
}

function placeholder(doc: Doc, file: string, range?: [number, number]): string {
  const url = doc.files.find((f) => f.path === file)?.url;
  return `**\`${file}\`**${range ? ` lines ${range[0]}-${range[1]}` : ""}: _code not included${url ? `; [view on GitHub](${url})` : ""}_`;
}

function notes(ns: { line: number; note: string }[]): string {
  return [...ns].sort((a, b) => a.line - b.line).map((n) => `- L${n.line}: ${n.note}`).join("\n");
}

const hunkText = (h: Hunk) => [h.header, ...h.lines.map((l) => l.t + l.s)].join("\n");

function fence(lang: string, body: string, indent = ""): string {
  const longest = Math.max(2, ...[...body.matchAll(/`{3,}/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return [`${f}${lang}`, ...body.replace(/\n$/, "").split("\n"), f].map((l) => indent + l).join("\n");
}

const quote = (s: string) => s.trim().split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
const join = (parts: string[]) => parts.filter((p) => p && p.trim()).map((p) => p.replace(/\s+$/, "")).join("\n\n") + "\n";

// ---- short form: the GitHub comment ----

export const LINK_PLACEHOLDER = "<!-- recap:link -->";

export function renderSummary(doc: Doc, opts: { link?: string } = {}): string {
  const out: string[] = [];
  out.push(`### ${KIND[doc.kind]}: ${doc.title || "(untitled)"}`, "");
  if (doc.tldr) out.push(`> ${doc.tldr}`, "");

  const f: string[] = [];
  if (doc.status) f.push(`**Status:** ${doc.status}`);
  if (doc.risk) f.push(`**Risk:** ${doc.risk.level.toUpperCase()}${doc.risk.why ? ` (${doc.risk.why})` : ""}`);
  if (doc.ask) f.push(`**Ask:** ${doc.ask}`);
  if (doc.stats) f.push(`**Diff:** ${doc.stats.files} files, +${doc.stats.additions} −${doc.stats.deletions}`);
  if (doc.planLink) {
    const p = doc.planLink;
    f.push(`**Plan:** ${p.title || p.src}: ${p.done.length} done, ${p.notDone.length} not done, ${p.deferred.length} deferred, ${p.unplanned.length} unplanned`);
  }
  if (f.length) out.push(f.map((x) => `- ${x}`).join("\n"), "");

  if (doc.questions.length) out.push("**Decisions needed**", "", ...doc.questions.map((q) => `- ${question(q)}`), "");
  if (doc.map.nodes.length) out.push("```mermaid", mapToMermaid(doc), "```", "");
  if (doc.sections.length) {
    out.push("<details><summary>Sections</summary>", "");
    for (const s of doc.sections) out.push(`- **${s.title}**${s.mechanical ? " _(mechanical)_" : ""}${s.summary ? `: ${oneLine(s.summary)}` : ""}`);
    out.push("", "</details>", "");
  }
  out.push(opts.link ? `**[Open the visual ${doc.kind}](${opts.link})**` : `**Open the visual ${doc.kind}:** ${LINK_PLACEHOLDER}`);
  return out.join("\n") + "\n";
}

const STYLE: Record<Change, string> = {
  added: "fill:#dcfce7,stroke:#16a34a,color:#14532d",
  changed: "fill:#fef3c7,stroke:#d97706,color:#78350f",
  removed: "fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-dasharray:4 2",
  unchanged: "fill:#f4f4f5,stroke:#a1a1aa,color:#52525b",
  planned: "fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e,stroke-dasharray:4 2",
  deferred: "fill:#fafafa,stroke:#a1a1aa,color:#71717a,stroke-dasharray:2 2",
};

export function mapToMermaid(doc: Doc): string {
  const id = (s: string) => "n_" + s.replace(/[^A-Za-z0-9_]/g, "_");
  const q = (s: string) => `"${s.replace(/"/g, "#quot;")}"`;
  const lines = ["flowchart LR"];
  const node = (n: Doc["map"]["nodes"][number]) => {
    const label = n.mechanical ? `${n.label} (mechanical)` : n.label;
    const shape = n.kind === "db" ? `[(${q(label)})]` : n.kind === "queue" ? `[/${q(label)}/]` : n.kind === "external" ? `{{${q(label)}}}` : `[${q(label)}]`;
    return `${id(n.id)}${shape}:::${n.mechanical ? "mechanical" : n.change}`;
  };
  for (const g of doc.map.groups) {
    const members = doc.map.nodes.filter((n) => n.group === g.id);
    if (!members.length) continue;
    lines.push(`  subgraph ${id("g_" + g.id)}[${q(g.label)}]`);
    for (const n of members) lines.push(`    ${node(n)}`);
    lines.push("  end");
  }
  for (const n of doc.map.nodes) if (!n.group || !doc.map.groups.some((g) => g.id === n.group)) lines.push(`  ${node(n)}`);
  for (const e of doc.map.edges) {
    const arrow = e.change === "removed" ? "-.-x" : e.change === "deferred" ? "-.->" : e.change === "added" || e.change === "planned" ? "==>" : "-->";
    lines.push(`  ${id(e.from)} ${arrow}${e.label ? `|${q(e.label)}|` : ""} ${id(e.to)}`);
  }
  for (const [c, style] of Object.entries(STYLE)) lines.push(`  classDef ${c} ${style}`);
  lines.push(`  classDef mechanical fill:#fafafa,stroke:#d4d4d8,color:#a1a1aa`);
  return lines.join("\n");
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 157) + "…" : t;
}
