// `recap check` (SPEC §5): structural errors fail; style/budget issues and parse warnings are warnings,
// except YAML that parsed into the wrong shape (unknown keys, mappings for strings): those fail, since they lose content silently;
// and invalid `level=` attrs (e.g. the old 0-3 numbering), which fail so they don't silently fall back to the default level.

import type { Block } from "./model.ts";
import type { Bundle } from "./parse/bundle.ts";
import { LEVEL_HINT, QUOTE_HINT } from "./parse/doc.ts";

export interface CheckResult { errors: string[]; warnings: string[] }

export const BUDGET = { mapNodes: 12, sections: 8, diffLines: 150 };

export function checkBundle(b: Bundle): CheckResult {
  const { doc, files } = b;
  const isError = (w: string) => w.endsWith(QUOTE_HINT) || w.endsWith(LEVEL_HINT);
  const errors: string[] = doc.warnings.filter(isError);
  const warnings: string[] = doc.warnings.filter((w) => !isError(w));

  // headline
  if (!doc.title) errors.push("frontmatter: title missing");
  if (!doc.tldr) errors.push(`frontmatter: ${doc.kind === "plan" ? "goal/tldr" : "tldr"} missing`);
  else if (sentences(doc.tldr) > 1) warnings.push("tldr should be one sentence");
  if (doc.kind === "review" && !doc.risk) warnings.push("frontmatter: risk missing");
  if (doc.kind === "review" && !doc.ask) warnings.push("frontmatter: ask missing");

  // map ↔ sections
  const sectionIds = new Set(doc.sections.map((s) => s.id));
  const nodeIds = new Set(doc.map.nodes.map((n) => n.id));
  if (doc.map.nodes.length === 0) errors.push("map: missing or has no nodes");
  for (const n of doc.map.nodes) {
    if (n.section && !sectionIds.has(n.section)) errors.push(`map node "${n.id}": section "${n.section}" does not exist`);
    if (!n.section && n.change !== "unchanged") warnings.push(`map node "${n.id}" (${n.change}) has no section`);
  }
  for (const e of doc.map.edges) {
    for (const end of [e.from, e.to]) if (!nodeIds.has(end)) errors.push(`map edge ${e.from}→${e.to}: unknown node "${end}"`);
  }
  for (const s of doc.sections) {
    if (!doc.map.nodes.some((n) => n.section === s.id)) warnings.push(`section "${s.id}" is not linked from any map node`);
  }

  // budgets
  if (doc.map.nodes.length > BUDGET.mapNodes) warnings.push(`map has ${doc.map.nodes.length} nodes (budget ${BUDGET.mapNodes})`);
  const main = doc.sections.filter((s) => !s.mechanical).length;
  if (main > BUDGET.sections) warnings.push(`${main} sections (budget ${BUDGET.sections}, mechanical ones not counted)`);

  // blocks
  for (const blk of doc.overviewBlocks) checkBlock(blk, `overview block "${blk.id}"`, files.has.bind(files), errors, warnings);
  for (const img of images(doc.overviewBlocks.map((b) => ("md" in b ? b.md : "")).join("\n"))) {
    if (!/^[a-z]+:\/\//i.test(img) && !files.has(img)) warnings.push(`overview: image "${img}" not in bundle`);
  }
  for (const s of doc.sections) {
    for (const blk of s.blocks) {
      const where = `section "${s.id}" block "${blk.id}"`;
      checkBlock(blk, where, files.has.bind(files), errors, warnings);
    }
    for (const img of images(s.summary + "\n" + s.blocks.map((b) => ("md" in b ? b.md : "")).join("\n"))) {
      if (!/^[a-z]+:\/\//i.test(img) && !files.has(img)) warnings.push(`section "${s.id}": image "${img}" not in bundle`);
    }
  }

  // unfinished scaffold
  const todo = findTodos(b);
  for (const t of todo) errors.push(`TODO left: ${t}`);

  // patch present but parse warnings mention it
  if (doc.kind === "review" && !files.has("changes.patch")) warnings.push("no changes.patch (run `recap collect`)");

  return { errors: uniq(errors), warnings: uniq(warnings) };
}

function checkBlock(blk: Block, where: string, has: (p: string) => boolean, errors: string[], warnings: string[]) {
  switch (blk.type) {
    case "diff": {
      if (!blk.file || blk.hunks.length === 0) errors.push(`${where}: diff does not resolve (file "${blk.file}")`);
      const n = blk.hunks.reduce((k, h) => k + h.lines.length + 1, 0);
      if (n > BUDGET.diffLines) warnings.push(`${where}: diff is ${n} lines (budget ${BUDGET.diffLines}); pick hunks= or lines=`);
      break;
    }
    case "code": {
      const n = blk.code.replace(/\n$/, "").split("\n").length;
      if (!blk.code.trim()) errors.push(`${where}: empty code block`);
      else if (n > BUDGET.diffLines) warnings.push(`${where}: code is ${n} lines (budget ${BUDGET.diffLines}); pick lines=`);
      break;
    }
    case "demo":
      if (!has(blk.src)) errors.push(`${where}: demo file "${blk.src}" not in bundle`);
      break;
    case "before-after":
      for (const shot of [blk.before, blk.after]) {
        if (shot.src && !has(shot.src)) errors.push(`${where}: image "${shot.src}" not in bundle`);
        if (shot.demo && !has(shot.demo)) errors.push(`${where}: demo "${shot.demo}" not in bundle`);
        if (!shot.src && !shot.demo) errors.push(`${where}: shot needs src or demo`);
      }
      break;
    case "flow":
      if (!blk.mermaid) errors.push(`${where}: empty flow`);
      break;
  }
}

/** TODO markers in the headline fields, map labels, summaries and markdown. */
function findTodos(b: Bundle): string[] {
  const d = b.doc;
  const out: string[] = [];
  const t = (v: string | undefined, where: string) => { if (v && /\bTODO\b/.test(v)) out.push(where); };
  t(d.title, "title"); t(d.tldr, "tldr"); t(d.ask, "ask"); t(d.risk?.why, "risk_why"); t(d.meta.author, "author");
  t(d.overview, "overview");
  for (const blk of d.overviewBlocks) if ("md" in blk && blk.type !== "markdown") t(blk.md, `overview block "${blk.id}"`);
  for (const n of d.map.nodes) { t(n.label, `map node "${n.id}" label`); t(n.note, `map node "${n.id}" note`); }
  for (const s of d.sections) {
    t(s.title, `section "${s.id}" title`);
    t(s.summary, `section "${s.id}" summary`);
    for (const blk of s.blocks) if ("md" in blk) t(blk.md, `section "${s.id}" block "${blk.id}"`);
  }
  return out;
}

function sentences(s: string): number {
  return s.trim().split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean).length;
}

function images(md: string): string[] {
  return [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]);
}

function uniq(a: string[]): string[] {
  return [...new Set(a)];
}
