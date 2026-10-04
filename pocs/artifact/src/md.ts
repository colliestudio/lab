// `recap md`: GitHub comment fallback (SPEC §4). Headline, risk, ask, the map as Mermaid, sections, link.

import type { Change, Doc } from "./model.ts";

export interface MdOptions { link?: string }

export const LINK_PLACEHOLDER = "<!-- recap:link -->";

export function renderMarkdown(doc: Doc, opts: MdOptions = {}): string {
  const out: string[] = [];
  const kindLabel = doc.kind === "plan" ? "Plan" : "Review";
  out.push(`### ${kindLabel}: ${doc.title || "(untitled)"}`, "");
  if (doc.tldr) out.push(`> ${doc.tldr}`, "");

  const facts: string[] = [];
  if (doc.status) facts.push(`**Status:** ${doc.status}`);
  if (doc.risk) facts.push(`**Risk:** ${doc.risk.level.toUpperCase()}${doc.risk.why ? ` (${doc.risk.why})` : ""}`);
  if (doc.ask) facts.push(`**Ask:** ${doc.ask}`);
  if (doc.stats) facts.push(`**Diff:** ${doc.stats.files} files, +${doc.stats.additions} −${doc.stats.deletions}`);
  if (doc.planLink) {
    const p = doc.planLink;
    facts.push(`**Plan:** ${p.title || p.src}: ${p.done.length} done, ${p.notDone.length} not done, ${p.deferred.length} deferred, ${p.unplanned.length} unplanned`);
  }
  if (facts.length) out.push(facts.map((f) => `- ${f}`).join("\n"), "");

  if (doc.questions.length) {
    out.push("**Decisions needed**", "");
    for (const q of doc.questions) {
      out.push(`- ${q.q}${q.options?.length ? ` (${q.options.join(" / ")})` : ""}${q.recommend ? `; recommend **${q.recommend}**` : ""}${q.why ? `: ${q.why}` : ""}`);
    }
    out.push("");
  }

  if (doc.map.nodes.length) out.push("```mermaid", mapToMermaid(doc), "```", "");

  if (doc.sections.length) {
    out.push("<details><summary>Sections</summary>", "");
    for (const s of doc.sections) {
      out.push(`- **${s.title}**${s.mechanical ? " _(mechanical)_" : ""}${s.summary ? `: ${oneLine(s.summary)}` : ""}`);
    }
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
