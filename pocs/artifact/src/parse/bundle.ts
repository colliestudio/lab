// Bundles (SPEC §2): a directory `x.review/` or the same contents zipped into a file `x.review`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { Doc, Kind, PlanLink } from "../model.ts";
import { parseDoc } from "./doc.ts";

/** Read access to the files of a bundle; paths are bundle-relative with `/` separators. */
export interface BundleFiles {
  list(): string[];
  read(path: string): Uint8Array | undefined;
  has(path: string): boolean;
}

export interface Bundle {
  /** Absolute path of the bundle (dir or zip file). */
  path: string;
  type: "dir" | "zip";
  doc: Doc;
  files: BundleFiles;
}

export interface LoadOptions {
  /** Resolve `plan:` and fill doc.planLink (default true). */
  linkPlan?: boolean;
}

export async function loadBundle(path: string, opts: LoadOptions = {}): Promise<Bundle> {
  return loadBundleSync(path, opts);
}

export function loadBundleSync(path: string, opts: LoadOptions = {}): Bundle {
  let abs = resolve(path);
  // a path to doc.md inside a dir bundle is fine too
  if (basename(abs) === "doc.md" && statSync(abs).isFile()) abs = dirname(abs);
  const files = openFiles(abs);
  const type = statSync(abs).isDirectory() ? "dir" : "zip";

  const md = files.read("doc.md");
  if (!md) throw new Error(`${path}: not a bundle (no doc.md)`);
  const patch = files.read("changes.patch");
  const doc = parseDoc(text(md), patch ? text(patch) : undefined, { kind: kindFromPath(abs) });

  if (opts.linkPlan !== false && doc.kind === "review" && doc.meta.plan && !/^[a-z]+:\/\//i.test(doc.meta.plan)) {
    const planPath = resolvePlanPath(abs, doc.meta.plan);
    if (!planPath) doc.warnings.push(`plan "${doc.meta.plan}" not found`);
    else {
      try {
        const plan = loadBundleSync(planPath, { linkPlan: false });
        doc.planLink = linkPlan(doc, plan.doc, doc.meta.plan);
      } catch (e) {
        doc.warnings.push(`plan "${doc.meta.plan}": ${(e as Error).message}`);
      }
    }
  }
  return { path: abs, type, doc, files };
}

/** Open a dir (lazy reads) or zip (in memory) as BundleFiles. Throws if the path doesn't exist. */
export function openFiles(abs: string): BundleFiles {
  const st = statSync(abs);
  if (st.isDirectory()) return dirFiles(abs);
  return zipFiles(readFileSync(abs));
}

function dirFiles(root: string): BundleFiles {
  const full = (p: string) => {
    const f = normalize(join(root, p));
    if (!f.startsWith(root + sep)) return undefined; // no escaping the bundle
    return f;
  };
  return {
    list: () => walk(root),
    has: (p) => {
      const f = full(p);
      return !!f && existsSync(f) && statSync(f).isFile();
    },
    read: (p) => {
      const f = full(p);
      if (!f || !existsSync(f) || !statSync(f).isFile()) return undefined;
      return new Uint8Array(readFileSync(f));
    },
  };
}

export function zipFiles(data: Uint8Array): BundleFiles {
  let entries = unzipSync(data);
  // tolerate a zip with one top-level folder (`x.review/doc.md`)
  if (!entries["doc.md"]) {
    const top = Object.keys(entries).find((k) => /^[^/]+\/doc\.md$/.test(k));
    if (top) {
      const prefix = top.slice(0, -"doc.md".length);
      entries = Object.fromEntries(
        Object.entries(entries).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]),
      );
    }
  }
  const map = new Map(Object.entries(entries).filter(([k]) => !k.endsWith("/")));
  return {
    list: () => [...map.keys()].sort(),
    has: (p) => map.has(p),
    read: (p) => map.get(p),
  };
}

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (e.name === ".DS_Store") continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

/** Zip the files of a bundle (dir or zip) into a Uint8Array. */
export function packFiles(files: BundleFiles): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const p of files.list()) entries[p] = files.read(p)!;
  return zipSync(entries, { level: 6 });
}

function kindFromPath(p: string): Kind | undefined {
  if (/\.plan\/?$/.test(p)) return "plan";
  if (/\.review\/?$/.test(p)) return "review";
  return undefined;
}

/** A zip plan bigger than this is not read (a hostile `plan: /dev/zero` or huge file would hang the process). */
const MAX_PLAN_ZIP = 100 * 1024 * 1024;

/**
 * `plan:` is relative to the bundle (so `../x.plan` = sibling); fall back to relative to its parent dir.
 * Only a dir with doc.md or a regular file under MAX_PLAN_ZIP counts (no devices, fifos, huge files).
 * Local use only: the hosted server parses uploads with linkPlan: false.
 */
function resolvePlanPath(bundleAbs: string, plan: string): string | undefined {
  for (const c of [resolve(bundleAbs, plan), resolve(dirname(bundleAbs), plan)]) {
    let st;
    try { st = statSync(c); } catch { continue; }
    if (st.isDirectory() ? existsSync(join(c, "doc.md")) : st.isFile() && st.size <= MAX_PLAN_ZIP) return c;
  }
  return undefined;
}

/**
 * Match plan and review map nodes by id. Context (unchanged) and mechanical nodes don't count as work; deferred
 * nodes (in the plan, or marked deferred in the review) are reported apart and never count as "not done".
 */
export function linkPlan(review: Doc, plan: Doc, src: string): PlanLink {
  const isWork = (n: { change: string; mechanical?: boolean }) => n.change !== "unchanged" && !n.mechanical;
  const isDone = (n?: { change: string }) => !!n && n.change !== "unchanged" && n.change !== "deferred";
  const reviewById = new Map(review.map.nodes.map((n) => [n.id, n]));
  const planWork = plan.map.nodes.filter(isWork);
  const planIds = new Set(planWork.map((n) => n.id));
  const done: string[] = [], notDone: string[] = [], deferred: string[] = [];
  for (const n of planWork) {
    const r = reviewById.get(n.id);
    if (isDone(r)) done.push(n.id);
    else if (n.change === "deferred" || r?.change === "deferred") deferred.push(n.id);
    else notDone.push(n.id);
  }
  const unplanned = review.map.nodes.filter((n) => isWork(n) && n.change !== "deferred" && !planIds.has(n.id)).map((n) => n.id);
  return { src, title: plan.title, done, notDone, deferred, unplanned };
}

function text(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
