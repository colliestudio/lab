// doc.md → Doc (SPEC §3). Line scanner: frontmatter, `## ` sections, typed fences; everything else is markdown.
// Soft problems become doc.warnings; parseDoc never throws on bad input.

import YAML from "yaml";
import {
  FORMAT, type Block, type Change, type Doc, type DocMap, type FileChange, type Hunk, type Kind, type Level,
  type MapEdge, type MapNode, type NodeKind, type Question, type Section, type DiffNote,
} from "../model.ts";
import { parsePatch, patchStats } from "./patch.ts";
import { globToRe, isGlob } from "../glob.ts";

export interface ParseOptions {
  /** Default kind when frontmatter has none (e.g. from the bundle extension). */
  kind?: Kind;
}

export const BLOCK_TYPES = [
  "map", "callout", "flow", "demo", "before-after", "data-model", "api", "steps",
  "questions", "checklist", "files", "diff", "code",
] as const;
type BlockType = (typeof BLOCK_TYPES)[number];
const ALIASES: Record<string, BlockType> = { mermaid: "flow" };

const DEFAULT_LEVEL: Record<string, Level> = {
  markdown: 2, callout: 2, flow: 2, demo: 2, "before-after": 2, "data-model": 2, api: 2, steps: 2,
  questions: 0, checklist: 2, files: 3, diff: 3, code: 3,
};

const CHANGES: Change[] = ["added", "changed", "removed", "unchanged", "planned", "deferred"];
const NODE_KINDS: NodeKind[] = ["service", "module", "ui", "db", "api", "queue", "job", "external", "config", "doc"];

/**
 * Appended to warnings about YAML that parsed into the wrong shape (unknown keys, mappings where a string was
 * expected): almost always an unquoted `, ` or `: ` inside a flow `{ }` / `[ ]`. `recap check` treats these as errors.
 */
export const QUOTE_HINT = "(an unquoted \", \" or \": \" inside { } or [ ] splits a value; quote it)";

/** Allowed YAML keys per structured object (SPEC §3). */
const KEYS: Record<string, string[]> = {
  frontmatter: ["kind", "title", "tldr", "goal", "status", "risk", "risk_why", "ask", "repo", "base", "head", "pr", "plan", "author", "date"],
  map: ["groups", "nodes", "edges"],
  group: ["id", "label"],
  node: ["id", "label", "kind", "change", "group", "section", "mechanical", "note", "files"],
  edge: ["from", "to", "label", "change"],
  demo: ["src", "steps", "caption"],
  "before-after": ["before", "after", "caption"],
  shot: ["src", "demo", "step", "caption"],
  "data-model": ["entities"],
  entity: ["name", "change", "note", "fields"],
  field: ["name", "type", "change", "note"],
  api: ["endpoints"],
  endpoint: ["method", "path", "change", "summary", "request", "response"],
  steps: ["steps"],
  step: ["title", "detail", "status", "area"],
  questions: ["questions"],
  question: ["q", "question", "options", "recommend", "why"],
  files: ["notes", "paths"],
};

/** Allowed info-string attributes per block type (besides id and level). */
const ATTRS: Record<string, string[]> = {
  map: [], callout: ["tone"], flow: ["caption"], demo: ["src", "steps", "caption"], "before-after": [], "data-model": [],
  api: [], steps: [], questions: [], checklist: [], files: ["paths"], diff: ["file", "hunks", "lines"],
  code: ["lang", "file", "start", "lines"],
};

function checkKeys(v: unknown, kind: string, where: string, warn: (m: string) => void) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return;
  for (const k of Object.keys(v)) {
    if (!KEYS[kind].includes(k)) warn(`${where}: unknown key "${k}" ${QUOTE_HINT}`);
  }
}

/** A list of scalars; a mapping item means an unquoted `: ` or `, ` got parsed as YAML structure. */
function strList(v: unknown, where: string, warn: (m: string) => void): string[] {
  return asArray(v).map((x, i) => {
    if (x && typeof x === "object") {
      warn(`${where}: item ${i + 1} is not a string ${QUOTE_HINT}`);
      return Object.entries(x).map(([k, val]) => (val == null ? k : `${k}: ${String(val)}`)).join(", ");
    }
    return String(x);
  });
}

// ---------- scanner ----------

type Token =
  | { t: "h2"; line: number; title: string; attrs: Attrs }
  | { t: "fence"; line: number; type: BlockType; attrs: Attrs; body: string }
  | { t: "text"; line: number; text: string };

export interface Attrs { [k: string]: string }

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function scan(body: string, lineOffset: number, warn: (m: string) => void): Token[] {
  const lines = body.split("\n");
  const out: Token[] = [];
  let text: string[] = [];
  let textStart = 0;
  const flush = () => {
    if (text.some((l) => l.trim())) out.push({ t: "text", line: textStart + lineOffset, text: text.join("\n") });
    text = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const fence = fm[1];
      const info = fm[2].trim();
      const word = info.split(/\s+/)[0] ?? "";
      const type = (BLOCK_TYPES as readonly string[]).includes(word) ? (word as BlockType) : ALIASES[word];
      // find the closing fence
      let j = i + 1;
      // diff bodies: a context line ` ```` (a fenced Markdown file in the diff) must not close the block, so the
      // closing fence there takes exactly the opener's indent
      const indent = type === "diff" ? " ".repeat(/^ */.exec(line)![0].length) : " {0,3}";
      const closeRe = new RegExp(`^${indent}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      while (j < lines.length && !closeRe.test(lines[j])) j++;
      if (j >= lines.length) warn(`line ${i + 1 + lineOffset}: unclosed code fence`);
      if (type) {
        flush();
        out.push({
          t: "fence", line: i + 1 + lineOffset, type,
          attrs: parseAttrs(info.slice(word.length)),
          body: lines.slice(i + 1, j).join("\n"),
        });
      } else {
        if (!text.length) textStart = i + 1;
        text.push(...lines.slice(i, Math.min(j + 1, lines.length)));
      }
      i = j;
      continue;
    }
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h && !line.startsWith("###")) {
      flush();
      const { title, attrs } = splitHeadingAttrs(h[1]);
      out.push({ t: "h2", line: i + 1 + lineOffset, title, attrs });
      continue;
    }
    if (!text.length) textStart = i + 1;
    text.push(line);
  }
  flush();
  return out;
}

/** ` key=value key="quoted value" flag` → {key: value, flag: "true"} */
export function parseAttrs(s: string): Attrs {
  const attrs: Attrs = {};
  const re = /([\w.-]+)(?:=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const v = m[2] ?? m[3] ?? m[4];
    attrs[m[1]] = v === undefined ? "true" : m[2] !== undefined ? v.replace(/\\(.)/g, "$1") : v;
  }
  return attrs;
}

/** `Title {#id .mechanical key=v}` → title + attrs (id under "id", classes as "true"). */
function splitHeadingAttrs(s: string): { title: string; attrs: Attrs } {
  const m = /^(.*?)\s*\{([^}]*)\}\s*$/.exec(s);
  if (!m) return { title: s.trim(), attrs: {} };
  const attrs: Attrs = {};
  for (const tok of m[2].trim().split(/\s+/).filter(Boolean)) {
    if (tok.startsWith("#")) attrs.id = tok.slice(1);
    else if (tok.startsWith(".")) attrs[tok.slice(1)] = "true";
    else Object.assign(attrs, parseAttrs(tok));
  }
  return { title: m[1].trim(), attrs };
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[`*_~]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

// ---------- parseDoc ----------

export function parseDoc(md: string, patch?: string, opts: ParseOptions = {}): Doc {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  md = md.replace(/\r\n/g, "\n");

  // frontmatter
  let fm: Record<string, unknown> = {};
  let body = md;
  let bodyOffset = 0;
  const fmm = /^---\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(md);
  if (fmm) {
    try {
      const v = YAML.parse(fmm[1]);
      if (v && typeof v === "object" && !Array.isArray(v)) fm = v as Record<string, unknown>;
      else warn("frontmatter is not a YAML mapping");
    } catch (e) {
      warn(`frontmatter: invalid YAML (${(e as Error).message.split("\n")[0]})`);
    }
    body = md.slice(fmm[0].length);
    bodyOffset = fmm[0].split("\n").length - 1;
  } else {
    warn("no frontmatter");
  }

  for (const k of Object.keys(fm)) if (!KEYS.frontmatter.includes(k)) warn(`frontmatter: unrecognized key "${k}"`);

  const files: FileChange[] = patch ? parsePatch(patch) : [];
  const str = (k: string) => (fm[k] === undefined || fm[k] === null ? undefined : String(fm[k]));

  let kind: Kind = opts.kind ?? "review";
  if (fm.kind !== undefined) {
    if (fm.kind === "review" || fm.kind === "plan") kind = fm.kind;
    else warn(`frontmatter: kind "${String(fm.kind)}" is not review|plan`);
  }

  let risk: Doc["risk"];
  if (fm.risk !== undefined) {
    const r = fm.risk as unknown;
    const level = typeof r === "object" && r ? String((r as { level?: unknown }).level) : String(r);
    const why = typeof r === "object" && r ? (r as { why?: string }).why : str("risk_why");
    if (level === "low" || level === "medium" || level === "high") risk = { level, why };
    else warn(`frontmatter: risk "${level}" is not low|medium|high`);
  }

  const doc: Doc = {
    format: FORMAT,
    kind,
    title: str("title") ?? "",
    tldr: str("tldr") ?? str("goal") ?? "",
    ...(str("goal") !== undefined ? { goal: str("goal") } : {}),
    status: str("status"),
    risk,
    ask: str("ask"),
    meta: {
      repo: str("repo"), base: str("base"), head: str("head"), pr: str("pr"),
      plan: str("plan"), author: str("author"), date: str("date"),
    },
    stats: patch !== undefined ? patchStats(files) : undefined,
    map: { groups: [], nodes: [], edges: [] },
    overview: "",
    overviewBlocks: [],
    sections: [],
    files,
    questions: [],
    warnings,
  };
  dropUndefined(doc.meta);
  if (doc.risk) dropUndefined(doc.risk);

  // body
  const tokens = scan(body, bodyOffset, warn);
  let mapSeen = false;
  const overview: string[] = [];
  let section: (Section & { _counts: Record<string, number> }) | null = null;
  const sectionIds = new Set<string>();
  const blockIds = new Set<string>();
  const overviewCounts: Record<string, number> = {};

  const nextBlockId = (type: string, attrs: Attrs, line: number): string => {
    let id = attrs.id;
    if (!id) {
      const sid = section ? section.id : "overview";
      const counts = section ? section._counts : overviewCounts;
      counts[type] = (counts[type] ?? 0) + 1;
      id = `${sid}-${type}-${counts[type]}`;
    }
    if (blockIds.has(id)) {
      warn(`line ${line}: duplicate block id "${id}"`);
      let n = 2;
      while (blockIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    blockIds.add(id);
    return id;
  };

  for (const tok of tokens) {
    if (tok.t === "h2") {
      let id = tok.attrs.id || slugify(tok.title);
      if (sectionIds.has(id)) {
        warn(`line ${tok.line}: duplicate section id "${id}"`);
        let n = 2;
        while (sectionIds.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      sectionIds.add(id);
      section = { id, title: tok.title, summary: "", mechanical: tok.attrs.mechanical === "true", blocks: [], _counts: {} };
      doc.sections.push(section);
      continue;
    }

    if (tok.t === "text") {
      if (!section) {
        // overview; a leading `# Title` doubles as the title when frontmatter has none
        let text = tok.text;
        const h1 = /^\s*#\s+(.+)\s*$/m.exec(text);
        if (h1 && !overview.length && text.trimStart().startsWith("# ")) {
          if (!doc.title) doc.title = h1[1].trim();
          text = text.replace(h1[0], "");
        }
        if (text.trim()) {
          overview.push(text.trim());
          doc.overviewBlocks.push({ type: "markdown", id: nextBlockId("markdown", {}, tok.line), level: 1, md: text.trim() });
        }
        continue;
      }
      let text = tok.text.trim();
      if (!section.summary && section.blocks.length === 0) {
        const { first, rest } = firstParagraph(text);
        section.summary = first;
        text = rest;
      }
      if (text) section.blocks.push({ type: "markdown", id: nextBlockId("markdown", {}, tok.line), level: 2, md: text });
      continue;
    }

    // typed fence
    if (tok.type === "map") {
      if (mapSeen) { warn(`line ${tok.line}: more than one map block; ignored`); continue; }
      mapSeen = true;
      if (section) warn(`line ${tok.line}: map block should come before the first section`);
      doc.map = parseMap(tok.body, kind, tok.line, warn);
      continue;
    }

    const block = parseBlock(tok, doc.files, warn);
    if (!block) continue;
    if (block.type === "questions") doc.questions.push(...block.questions);
    block.id = nextBlockId(tok.type, tok.attrs, tok.line);
    if (!section) {
      if (block.level === 3) warn(`line ${tok.line}: ${tok.type} block in the overview is level 3; it belongs in a section`);
      doc.overviewBlocks.push(block);
      continue;
    }
    section.blocks.push(block);
  }

  doc.overview = overview.join("\n\n");
  if (!mapSeen) warn("no map block");
  if (!doc.title) warn("no title");

  // sections: mechanical when flagged or when every map node pointing at it is mechanical; mechanical go last
  for (const s of doc.sections) {
    const nodes = doc.map.nodes.filter((n) => n.section === s.id);
    if (!s.mechanical && nodes.length > 0 && nodes.every((n) => n.mechanical)) s.mechanical = true;
    if (!s.summary) warn(`section "${s.id}": no summary paragraph (first paragraph after the heading)`);
    delete (s as { _counts?: unknown })._counts;
  }
  doc.sections = [...doc.sections.filter((s) => !s.mechanical), ...doc.sections.filter((s) => s.mechanical)];
  return doc;
}

/** First paragraph of a markdown chunk (unless it starts with a heading, list, quote, table or fence). */
function firstParagraph(text: string): { first: string; rest: string } {
  if (/^(#|[-*+] |\d+[.)] |>|\||```|~~~|<)/.test(text)) return { first: "", rest: text };
  const m = /\n\s*\n/.exec(text);
  if (!m) return { first: text, rest: "" };
  return { first: text.slice(0, m.index).trim(), rest: text.slice(m.index).trim() };
}

function dropUndefined(o: object) {
  for (const k of Object.keys(o)) if ((o as Record<string, unknown>)[k] === undefined) delete (o as Record<string, unknown>)[k];
}

// ---------- map ----------

function parseMap(body: string, kind: Kind, line: number, warn: (m: string) => void): DocMap {
  const map: DocMap = { groups: [], nodes: [], edges: [] };
  const y = yamlBody(body, `line ${line}: map`, warn);
  if (!y || typeof y !== "object") { warn(`line ${line}: map block is empty or not a mapping`); return map; }
  const v = y as { groups?: unknown; nodes?: unknown; edges?: unknown };
  checkKeys(v, "map", `line ${line}: map`, warn);

  for (const g of asArray(v.groups)) {
    if (g && typeof g === "object" && "id" in g) {
      const gg = g as { id: unknown; label?: unknown };
      checkKeys(g, "group", `map group "${String(gg.id)}"`, warn);
      map.groups.push({ id: String(gg.id), label: String(gg.label ?? gg.id) });
    }
  }
  const ids = new Set<string>();
  for (const raw of asArray(v.nodes)) {
    if (!raw || typeof raw !== "object" || !("id" in raw)) { warn(`line ${line}: map node without id`); continue; }
    const r = raw as Record<string, unknown>;
    const id = String(r.id);
    checkKeys(r, "node", `map node "${id}"`, warn);
    if (ids.has(id)) { warn(`map: duplicate node id "${id}"`); continue; }
    ids.add(id);
    const node: MapNode = {
      id,
      label: String(r.label ?? id),
      change: toChange(r.change, kind === "plan" ? "planned" : "changed", `map node "${id}"`, warn),
    };
    if (r.kind !== undefined) {
      if (NODE_KINDS.includes(r.kind as NodeKind)) node.kind = r.kind as NodeKind;
      else warn(`map node "${id}": unknown kind "${String(r.kind)}"`);
    }
    if (r.group !== undefined) node.group = String(r.group);
    if (r.section !== undefined) node.section = String(r.section);
    if (r.mechanical) node.mechanical = true;
    if (r.note !== undefined) node.note = String(r.note);
    if (r.files !== undefined) node.files = strList(r.files, `map node "${id}" files`, warn);
    if (node.group && !map.groups.some((g) => g.id === node.group)) {
      warn(`map node "${id}": unknown group "${node.group}"`);
      map.groups.push({ id: node.group, label: node.group });
    }
    map.nodes.push(node);
  }
  for (const raw of asArray(v.edges)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.from === undefined || r.to === undefined) { warn(`map: edge without from/to`); continue; }
    const e: MapEdge = { from: String(r.from), to: String(r.to) };
    checkKeys(r, "edge", `map edge ${e.from}→${e.to}`, warn);
    if (r.label !== undefined) e.label = String(r.label);
    if (r.change !== undefined) e.change = toChange(r.change, "changed", `edge ${e.from}→${e.to}`, warn);
    for (const end of [e.from, e.to]) if (!ids.has(end)) warn(`map: edge ${e.from}→${e.to} references unknown node "${end}"`);
    map.edges.push(e);
  }
  return map;
}

function toChange(v: unknown, dflt: Change, where: string, warn: (m: string) => void): Change {
  if (v === undefined || v === null) return dflt;
  if (CHANGES.includes(v as Change)) return v as Change;
  warn(`${where}: unknown change "${String(v)}"`);
  return dflt;
}

// ---------- blocks ----------

function parseBlock(tok: Extract<Token, { t: "fence" }>, files: FileChange[], warn: (m: string) => void): Block | null {
  const where = `line ${tok.line}: ${tok.type}`;
  let level = DEFAULT_LEVEL[tok.type] ?? 2;
  if (tok.attrs.level !== undefined) {
    const n = Number(tok.attrs.level);
    if ([0, 1, 2, 3].includes(n)) level = n as Level;
    else warn(`${where}: level must be 0-3`);
  }
  const base = { id: "", level };
  const a = tok.attrs;
  for (const k of Object.keys(a)) {
    if (k !== "id" && k !== "level" && !(ATTRS[tok.type] ?? []).includes(k)) warn(`${where}: unknown attribute "${k}"`);
  }

  switch (tok.type) {
    case "callout": {
      const tone = a.tone ?? "info";
      if (!["info", "warn", "risk", "decision"].includes(tone)) warn(`${where}: unknown tone "${tone}"`);
      return { ...base, type: "callout", tone: (["info", "warn", "risk", "decision"].includes(tone) ? tone : "info") as "info", md: tok.body.trim() };
    }
    case "flow":
      return { ...base, type: "flow", mermaid: tok.body.trim(), ...(a.caption ? { caption: a.caption } : {}) };
    case "code":
      return parseCodeBlock(tok, base, files, warn);
    case "demo": {
      const y = obj(yamlBody(tok.body, where, warn));
      checkKeys(y, "demo", where, warn);
      const src = y.src ?? a.src;
      if (!src) { warn(`${where}: no src`); return null; }
      const steps = y.steps ?? (a.steps ? a.steps.split(",") : undefined);
      return {
        ...base, type: "demo", src: String(src),
        ...(steps !== undefined ? { steps: asArray(steps).map(Number).filter((n) => !Number.isNaN(n)) } : {}),
        ...(y.caption ?? a.caption ? { caption: String(y.caption ?? a.caption) } : {}),
      };
    }
    case "before-after": {
      const y = obj(yamlBody(tok.body, where, warn));
      checkKeys(y, "before-after", where, warn);
      const shot = (v: unknown, side: string) => {
        const s = obj(v);
        checkKeys(s, "shot", `${where} ${side}`, warn);
        return {
          ...(s.src !== undefined ? { src: String(s.src) } : {}),
          ...(s.demo !== undefined ? { demo: String(s.demo) } : {}),
          ...(s.step !== undefined ? { step: Number(s.step) } : {}),
          ...(s.caption !== undefined ? { caption: String(s.caption) } : {}),
        };
      };
      if (!y.before || !y.after) warn(`${where}: needs before and after`);
      return { ...base, type: "before-after", before: shot(y.before, "before"), after: shot(y.after, "after"), ...(y.caption ? { caption: String(y.caption) } : {}) };
    }
    case "data-model": {
      const y = yamlBody(tok.body, where, warn);
      if (!Array.isArray(y)) checkKeys(y, "data-model", where, warn);
      const list = Array.isArray(y) ? y : asArray(obj(y).entities);
      const entities = list.map((e) => {
        const o = obj(e);
        checkKeys(o, "entity", `${where} entity "${String(o.name ?? "?")}"`, warn);
        return {
          name: String(o.name ?? "?"),
          change: toChange(o.change, "changed", `${where} entity`, warn),
          ...(o.note !== undefined ? { note: String(o.note) } : {}),
          fields: asArray(o.fields).map((f) => {
            const fo = obj(f);
            checkKeys(fo, "field", `${where} field "${String(o.name ?? "?")}.${String(fo.name ?? "?")}"`, warn);
            return {
              name: String(fo.name ?? "?"),
              ...(fo.type !== undefined ? { type: String(fo.type) } : {}),
              change: toChange(fo.change, "unchanged", `${where} field`, warn),
              ...(fo.note !== undefined ? { note: String(fo.note) } : {}),
            };
          }),
        };
      });
      return { ...base, type: "data-model", entities };
    }
    case "api": {
      const y = yamlBody(tok.body, where, warn);
      if (!Array.isArray(y)) checkKeys(y, "api", where, warn);
      const list = Array.isArray(y) ? y : asArray(obj(y).endpoints);
      const endpoints = list.map((e) => {
        const o = obj(e);
        checkKeys(o, "endpoint", `${where} endpoint "${String(o.method ?? "GET")} ${String(o.path ?? "/")}"`, warn);
        return {
          method: String(o.method ?? "GET").toUpperCase(),
          path: String(o.path ?? "/"),
          change: toChange(o.change, "changed", `${where} endpoint`, warn),
          ...(o.summary !== undefined ? { summary: String(o.summary) } : {}),
          ...(o.request !== undefined ? { request: typeof o.request === "string" ? o.request : JSON.stringify(o.request, null, 2) } : {}),
          ...(o.response !== undefined ? { response: typeof o.response === "string" ? o.response : JSON.stringify(o.response, null, 2) } : {}),
        };
      });
      return { ...base, type: "api", endpoints };
    }
    case "steps": {
      const y = yamlBody(tok.body, where, warn);
      if (!Array.isArray(y)) checkKeys(y, "steps", where, warn);
      const list = Array.isArray(y) ? y : asArray(obj(y).steps);
      const steps = list.map((s) => {
        if (typeof s === "string") return { title: s };
        const o = obj(s);
        checkKeys(o, "step", `${where} step "${String(o.title ?? "?")}"`, warn);
        const status = o.status === undefined ? undefined : String(o.status);
        if (status && !["todo", "doing", "done"].includes(status)) warn(`${where}: unknown status "${status}"`);
        return {
          title: String(o.title ?? "?"),
          ...(o.detail !== undefined ? { detail: String(o.detail) } : {}),
          ...(status && ["todo", "doing", "done"].includes(status) ? { status: status as "todo" } : {}),
          ...(o.area !== undefined ? { area: String(o.area) } : {}),
        };
      });
      return { ...base, type: "steps", steps };
    }
    case "questions": {
      const y = yamlBody(tok.body, where, warn);
      if (!Array.isArray(y)) checkKeys(y, "questions", where, warn);
      const list = Array.isArray(y) ? y : asArray(obj(y).questions);
      const questions: Question[] = list.map((q) => {
        if (typeof q === "string") return { q };
        const o = obj(q);
        const qw = `${where} question "${String(o.q ?? o.question ?? "?")}"`;
        checkKeys(o, "question", qw, warn);
        return {
          q: String(o.q ?? o.question ?? "?"),
          ...(o.options !== undefined ? { options: strList(o.options, `${qw} options`, warn) } : {}),
          ...(o.recommend !== undefined ? { recommend: String(o.recommend) } : {}),
          ...(o.why !== undefined ? { why: String(o.why) } : {}),
        };
      });
      return { ...base, type: "questions", questions };
    }
    case "checklist": {
      const y = yamlBody(tok.body, where, warn);
      return { ...base, type: "checklist", items: strList(y, where, warn) };
    }
    case "files": {
      const y = yamlBody(tok.body, where, warn);
      const o = obj(y);
      // either {path: note, ...} or {notes: {...}, paths: [...]}
      const flat = !("notes" in o) && !("paths" in o);
      if (!flat) checkKeys(o, "files", where, warn);
      const rawNotes: Record<string, string> = {};
      for (const [k, v] of Object.entries(flat ? o : obj(o.notes))) rawNotes[k] = v == null ? "" : String(v);
      let rawPaths = flat ? undefined : o.paths !== undefined ? strList(o.paths, `${where} paths`, warn) : undefined;
      if (a.paths) rawPaths = a.paths.split(",").map((s) => s.trim()).filter(Boolean);
      // globs (`src/server/**`, `*.ts`) and directories expand against changes.patch; a file's own note wins
      const isFile = (p: string) => files.some((f) => f.path === p || f.oldPath === p);
      const pattern = (p: string) => isGlob(p) || (!isFile(p) && files.some((f) => f.path.startsWith(p.replace(/\/$/, "") + "/")));
      const expand = (p: string): string[] => {
        if (!pattern(p)) {
          if (files.length && !isFile(p)) warn(`${where}: "${p}" is not in changes.patch`);
          return [p];
        }
        const re = globToRe(p);
        const hit = files.filter((f) => re.test(f.path)).map((f) => f.path);
        if (!hit.length) warn(`${where}: glob "${p}" matches no file in changes.patch`);
        return hit;
      };
      const notes: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawNotes)) if (pattern(k)) for (const p of expand(k)) notes[p] ??= v;
      for (const [k, v] of Object.entries(rawNotes)) if (!pattern(k)) { expand(k); notes[k] = v; }
      const paths = rawPaths && [...new Set(rawPaths.flatMap(expand))];
      return { ...base, type: "files", notes, ...(paths ? { paths } : {}) };
    }
    case "diff":
      return parseDiffBlock(tok, base, files, warn);
  }
  return null;
}

const NOTE_RE = /^@(\d+):\s?(.*)$/;
/** `\@12: x` in a code body is the literal line `@12: x`, not a note. */
const ESCAPED_NOTE_RE = /^\\(@\d+:)/;

function parseDiffBlock(
  tok: Extract<Token, { t: "fence" }>, base: { id: string; level: Level }, files: FileChange[], warn: (m: string) => void,
): Block {
  const where = `line ${tok.line}: diff`;
  const notes: DiffNote[] = [];
  const raw: string[] = [];
  for (const l of tok.body.split("\n")) {
    const m = NOTE_RE.exec(l);
    if (m) notes.push({ line: +m[1], note: m[2].trim() });
    else raw.push(l);
  }
  const rawText = raw.join("\n").trim();
  const wanted = tok.attrs.hunks?.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);

  let file = tok.attrs.file ?? "";
  let hunks: Hunk[] = [];
  let change: Change = "changed";

  if (rawText) {
    // inline diff: full unified diff, or bare hunks (file from the attr)
    const full = /^(diff --git|--- )/m.test(rawText);
    if (!full && !file) warn(`${where}: bare hunks need a file= attribute`);
    const parsed = parsePatch(full ? rawText : `--- a/${file || "unknown"}\n+++ b/${file || "unknown"}\n${rawText}`);
    const f = parsed.find((p) => !file || p.path === file) ?? parsed[0];
    if (!f) warn(`${where}: could not parse the inline diff`);
    else {
      file = file || f.path;
      hunks = f.hunks;
      // prefer the change kind from changes.patch when the file is in it
      change = files.find((p) => p.path === file)?.change ?? f.change;
    }
  } else if (file) {
    const f = files.find((p) => p.path === file || p.oldPath === file);
    if (!f) warn(`${where}: file "${file}" not found in changes.patch`);
    else { hunks = f.hunks; change = f.change; file = f.path; }
  } else {
    warn(`${where}: empty diff block without file=`);
  }

  if (wanted?.length) {
    const bad = wanted.filter((n) => n > hunks.length);
    if (bad.length && hunks.length) warn(`${where}: hunks ${bad.join(",")} out of range (file has ${hunks.length})`);
    hunks = wanted.filter((n) => n <= hunks.length).map((n) => hunks[n - 1]);
  }
  if (tok.attrs.lines !== undefined && hunks.length) {
    const ranges = parseRanges(tok.attrs.lines, where, warn);
    const out: Hunk[] = [];
    for (const [a, b] of ranges) {
      const got = hunks.map((h) => sliceHunk(h, a, b)).filter((h): h is Hunk => !!h);
      if (!got.length) warn(`${where}: lines ${a}-${b} match no line of the shown hunks`);
      out.push(...got);
    }
    hunks = out.sort((x, y) => x.newStart - y.newStart || x.oldStart - y.oldStart);
  }
  for (const n of notes) {
    const hit = hunks.some((h) => h.lines.some((l) => l.new === n.line));
    if (!hit && hunks.length) warn(`${where}: note @${n.line} is outside the shown hunks`);
  }
  return { ...base, type: "diff", file, hunks, notes, change };
}

/** `163-199,250-260` or `42` → [[163,199],[250,260]] / [[42,42]]; bad parts warn and are skipped. */
function parseRanges(s: string, where: string, warn: (m: string) => void): [number, number][] {
  const out: [number, number][] = [];
  for (const part of s.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    const a = m ? +m[1] : NaN, b = m ? +(m[2] ?? m[1]) : NaN;
    if (!m || a < 1 || b < a) { warn(`${where}: bad lines= range "${part}" (want a-b, 1-based, a ≤ b)`); continue; }
    out.push([a, b]);
  }
  return out;
}

/**
 * The part of a hunk whose new-side lines fall in [a, b], with real line numbers and a rebuilt header.
 * A removed line belongs to the position of the next new-side line, so a replaced block stays together.
 */
export function sliceHunk(h: Hunk, a: number, b: number): Hunk | null {
  const pos: number[] = new Array(h.lines.length);
  let next = h.newStart + h.newLines;
  for (let i = h.lines.length - 1; i >= 0; i--) {
    if (h.lines[i].new !== undefined) next = h.lines[i].new!;
    pos[i] = h.lines[i].new ?? next;
  }
  const idx = h.lines.map((_, i) => i).filter((i) => pos[i] >= a && pos[i] <= b);
  if (!idx.length) return null;
  const first = idx[0];
  const lines = idx.map((i) => h.lines[i]);
  if (idx.length === h.lines.length) return h;
  const before = h.lines.slice(0, first);
  const oldLines = lines.filter((l) => l.old !== undefined).length;
  const newLines = lines.filter((l) => l.new !== undefined).length;
  const oldBefore = Math.max(0, h.oldStart - 1 + before.filter((l) => l.old !== undefined).length);
  const newBefore = Math.max(0, h.newStart - 1 + before.filter((l) => l.new !== undefined).length);
  const oldStart = oldLines ? oldBefore + 1 : oldBefore;
  const newStart = newLines ? newBefore + 1 : newBefore;
  const suffix = /^@@ [^@]* @@(.*)$/.exec(h.header)?.[1] ?? "";
  return { header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${suffix}`, oldStart, oldLines, newStart, newLines, lines };
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "ts", tsx: "tsx", mts: "ts", cts: "ts", js: "js", jsx: "jsx", mjs: "js", cjs: "js", json: "json", go: "go", py: "python",
  rs: "rust", rb: "ruby", java: "java", kt: "kotlin", swift: "swift", css: "css", scss: "scss", html: "html", vue: "vue",
  svelte: "svelte", sql: "sql", sh: "sh", bash: "sh", zsh: "sh", yml: "yaml", yaml: "yaml", toml: "toml", md: "md", mdx: "md",
};

function parseCodeBlock(
  tok: Extract<Token, { t: "fence" }>, base: { id: string; level: Level }, files: FileChange[], warn: (m: string) => void,
): Block {
  const where = `line ${tok.line}: code`;
  const a = tok.attrs;
  const notes: DiffNote[] = [];
  const body: string[] = [];
  for (const l of tok.body.split("\n")) {
    const m = NOTE_RE.exec(l);
    if (m) notes.push({ line: +m[1], note: m[2].trim() });
    else body.push(l.replace(ESCAPED_NOTE_RE, "$1"));
  }
  let code = body.join("\n");
  let start: number | undefined;
  if (a.start !== undefined) {
    const n = Number(a.start);
    if (Number.isInteger(n) && n >= 1) start = n;
    else warn(`${where}: start must be a line number ≥ 1`);
  }
  const ranges = a.lines !== undefined ? parseRanges(a.lines, where, warn) : [];
  if (ranges.length > 1) warn(`${where}: code takes one lines= range; using ${ranges[0].join("-")}`);
  const range = ranges[0];

  if (!code.trim() && a.file) {
    // fill from the new side of changes.patch
    const f = files.find((p) => p.path === a.file || p.oldPath === a.file);
    if (!f) warn(`${where}: empty body and "${a.file}" is not in changes.patch`);
    else {
      const byLine = new Map<number, string>();
      for (const h of f.hunks) for (const l of h.lines) if (l.new !== undefined) byLine.set(l.new, l.s);
      const nums = [...byLine.keys()];
      const [lo, hi] = range ?? [Math.min(...nums), Math.max(...nums)];
      const out: string[] = [];
      for (let n = lo; n <= hi; n++) {
        if (!byLine.has(n)) {
          warn(`${where}: line ${n} of "${f.path}" is not in changes.patch (only new files and changed regions are); ${out.length ? `showing ${lo}-${n - 1}` : "nothing to show"}`);
          break;
        }
        out.push(byLine.get(n)!);
      }
      if (start !== undefined && start !== lo) warn(`${where}: start= is ignored when the code comes from changes.patch`);
      code = out.join("\n");
      start = out.length ? lo : undefined;
    }
  } else if (range && start === undefined) {
    start = range[0];
  }

  const first = start ?? 1;
  const count = code.replace(/\n$/, "").split("\n").length;
  for (const n of notes) {
    if (code && (n.line < first || n.line >= first + count)) warn(`${where}: note @${n.line} is outside lines ${first}-${first + count - 1}`);
  }
  const lang = a.lang ?? (a.file ? LANG_BY_EXT[a.file.split(".").pop()!.toLowerCase()] : undefined);
  return {
    ...base, type: "code", code,
    ...(lang ? { lang } : {}), ...(a.file ? { file: a.file } : {}),
    ...(start !== undefined ? { start } : {}), ...(notes.length ? { notes } : {}),
  };
}

// ---------- helpers ----------

function yamlBody(body: string, where: string, warn: (m: string) => void): unknown {
  if (!body.trim()) return undefined;
  try {
    return YAML.parse(body);
  } catch (e) {
    warn(`${where}: invalid YAML (${(e as Error).message.split("\n")[0]})`);
    return undefined;
  }
}

function asArray(v: unknown): unknown[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
