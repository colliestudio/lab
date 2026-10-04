// `recap collect`: git diff → changes.patch + a doc.md scaffold for the authoring agent to rewrite.
// The scaffold is deliberately full of TODOs so `recap check` fails until it's written.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { Change, FileChange, NodeKind } from "./model.ts";
import { parsePatch, mechanicalReason } from "./parse/patch.ts";
import { slugify } from "./parse/doc.ts";

export interface CollectOptions {
  base: string;
  head?: string;            // default HEAD
  repo?: string;            // default cwd
  out: string;              // bundle dir
  force?: boolean;          // overwrite an existing doc.md
}

export interface CollectResult { patchPath: string; docPath?: string; files: number; docKept: boolean }

export function collect(o: CollectOptions): CollectResult {
  const repo = resolve(o.repo ?? ".");
  const head = o.head ?? "HEAD";
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });

  const patch = git("diff", "--find-renames", "--binary", "--no-color", "--no-ext-diff", `${o.base}...${head}`);
  const out = resolve(o.out);
  if (existsSync(out) && !statSync(out).isDirectory()) throw new Error(`${o.out} exists and is not a directory (unpack it first)`);
  mkdirSync(out, { recursive: true });
  const patchPath = join(out, "changes.patch");
  writeFileSync(patchPath, patch);

  const files = parsePatch(patch);
  const docPath = join(out, "doc.md");
  if (existsSync(docPath) && !o.force) return { patchPath, files: files.length, docKept: true };

  let repoName: string | undefined;
  try {
    const url = git("remote", "get-url", "origin").trim();
    repoName = /[:/]([^/:]+\/[^/]+?)(\.git)?$/.exec(url)?.[1];
  } catch { /* no remote */ }
  let headName = head;
  try { if (head === "HEAD") headName = git("rev-parse", "--abbrev-ref", "HEAD").trim(); } catch { /* detached */ }

  writeFileSync(docPath, scaffold(files, { repo: repoName, base: o.base, head: headName }));
  return { patchPath, docPath, files: files.length, docKept: false };
}

interface Area { id: string; label: string; prefix: string; files: FileChange[] }

const CONTAINERS = new Set(["src", "lib", "packages", "apps", "internal", "pkg", "cmd", "services", "app", "modules", "crates"]);

/** Group files into top-level areas: first path segment, or two for container dirs like src/ or packages/. */
export function groupAreas(files: FileChange[], maxNodes = 11): { areas: Area[]; mechanical: FileChange[] } {
  const mechanical = files.filter((f) => f.mechanical);
  const byKey = new Map<string, FileChange[]>();
  for (const f of files.filter((f) => !f.mechanical)) {
    const seg = f.path.split("/");
    const key = seg.length === 1 ? "(root)" : CONTAINERS.has(seg[0]) && seg.length > 2 ? `${seg[0]}/${seg[1]}` : seg[0];
    byKey.set(key, [...(byKey.get(key) ?? []), f]);
  }
  let areas: Area[] = [...byKey.entries()]
    .sort((a, b) => churn(b[1]) - churn(a[1]))
    .map(([key, fs]) => ({ id: slugify(key === "(root)" ? "root" : key), label: key === "(root)" ? "Root files" : key, prefix: key, files: fs }));
  if (areas.length > maxNodes) {
    const rest = areas.slice(maxNodes - 1);
    areas = [...areas.slice(0, maxNodes - 1), { id: "other", label: "Other", prefix: "", files: rest.flatMap((a) => a.files) }];
  }
  return { areas, mechanical };
}

function churn(fs: FileChange[]) {
  return fs.reduce((n, f) => n + f.additions + f.deletions + 1, 0);
}

function areaChange(fs: FileChange[]): Change {
  if (fs.every((f) => f.change === "added")) return "added";
  if (fs.every((f) => f.change === "removed")) return "removed";
  return "changed";
}

function guessKind(prefix: string, fs: FileChange[]): NodeKind {
  const p = prefix.toLowerCase();
  if (/(^|\/)(web|ui|frontend|client|components|pages|viewer|app)$/.test(p) || fs.every((f) => /\.(tsx|jsx|vue|svelte|css|html)$/.test(f.path))) return "ui";
  if (/migrat|schema|db|store|sql/.test(p) || fs.every((f) => /\.sql$/.test(f.path))) return "db";
  if (/(^|\/)api$|routes|handlers/.test(p)) return "api";
  if (/docs?$/.test(p) || fs.every((f) => /\.(md|mdx|txt)$/.test(f.path))) return "doc";
  if (/worker|jobs?|cron/.test(p)) return "job";
  if (p === "(root)" || /config|deploy|infra|\.github/.test(p)) return "config";
  return "module";
}

export function scaffold(files: FileChange[], meta: { repo?: string; base: string; head: string }): string {
  const { areas, mechanical } = groupAreas(files);
  const nodes: Record<string, unknown>[] = areas.map((a) => ({
    id: a.id, label: a.label, kind: guessKind(a.prefix, a.files), change: areaChange(a.files), section: a.id,
    ...(a.prefix ? { files: [`${a.prefix === "(root)" ? "*" : a.prefix + "/**"}`] } : {}),
  }));
  if (mechanical.length) nodes.push({ id: "mechanical", label: "Mechanical changes", kind: "config", change: "changed", mechanical: true, section: "mechanical" });

  const fm = {
    kind: "review",
    title: "TODO: what changed, in a few words",
    tldr: "TODO: one sentence: what changed and why it matters.",
    status: "draft",
    risk: "medium",
    risk_why: "TODO: what could break, and how badly",
    ask: "TODO: what the reader should do (approve / check X)",
    ...(meta.repo ? { repo: meta.repo } : {}),
    base: meta.base,
    head: meta.head,
    author: "TODO",
    date: localDate(),
  };

  const out: string[] = [];
  out.push("---", YAML.stringify(fm).trim(), "---", "");
  out.push(
    "<!-- Scaffold from `recap collect`. Rewrite it: merge/rename map nodes into real components, add edges",
    "     (calls / data flow), order sections by what must be understood first, add flow/data-model/api/diff",
    "     blocks where they help. `recap check` fails while TODOs remain. Format: SPEC.md §3. -->",
    "",
  );
  const flow = (v: unknown) => YAML.stringify(v, { collectionStyle: "flow", lineWidth: 0 }).trim();
  out.push("```map", "groups: []", "nodes:", ...nodes.map((n) => `  - ${flow(n)}`), "edges: []", "```", "");
  out.push("TODO: two or three sentences of overview: the shape of the change before the details.", "");

  for (const a of areas) {
    out.push(`## ${a.label} {#${a.id}}`, "");
    out.push(`TODO: one or two sentences: what changed in ${a.label} and why.`, "");
    out.push(filesBlock(a.files), "");
  }
  if (mechanical.length) {
    out.push("## Mechanical changes {#mechanical .mechanical}", "");
    out.push("Lockfiles, generated files, renames and formatting; no behaviour change expected.", "");
    out.push(filesBlock(mechanical, true), "");
  }
  return out.join("\n");
}

function filesBlock(fs: FileChange[], withReason = false): string {
  const notes: Record<string, string> = {};
  for (const f of fs) notes[f.path] = withReason ? (mechanicalReason(f) ?? "") : "";
  return ["```files", YAML.stringify({ paths: fs.map((f) => f.path), ...(withReason ? { notes } : {}) }).trim(), "```"].join("\n");
}

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
