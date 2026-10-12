// What the build injects (virtual module "artifact:registry"): artifact.json, data/*.json, and the evidence the
// source references, already parsed/encoded. Components read it through these helpers.
import registry from "artifact:registry";

export interface Source { label: string; href?: string; kind?: string; from?: string }
export interface Meta {
  title: string; kind?: string; audience?: string; summary?: string; created?: string; tour?: string[]; download?: boolean; host?: { download?: boolean }; timeZone?: string; repo?: string; header?: "compact" | "full"; shell?: "bare" | "doc"; asOf?: string; width?: "narrow" | "normal" | "wide" | "full";
  sources?: (string | Source)[];
}
export interface PatchLine { t: " " | "+" | "-"; s: string }
export interface PatchHunk { oldStart: number; newStart: number; lines: PatchLine[]; ctx?: string }
export interface PatchFile {
  path: string; oldPath?: string; change: "added" | "changed" | "removed";
  additions: number; deletions: number; binary: boolean; hunks: PatchHunk[];
}
export type Evidence =
  | { k: "patch"; files: PatchFile[] }
  | { k: "replay"; b64: string }
  | { k: "image" | "file"; url: string }
  | { k: "text"; text: string };
/** A decision found by rendering every page at build time (so other pages' decisions count in the progress). */
export interface DecisionMeta {
  id: string; question: string; recommended?: string; owner?: string; page: string;
  when?: { decision: string; is?: string | number | (string | number)[]; not?: string | number | (string | number)[]; answered?: boolean; unanswered?: boolean }[];
}
export interface Registry { meta: Meta; data: Record<string, unknown>; evidence: Record<string, Evidence>; decisions?: DecisionMeta[] }

const reg = registry as Registry;
export const meta = reg.meta;
export const decisions = reg.decisions ?? [];

const norm = (p: string) => p.replace(/^\.?\//, "");

export function getEvidence<K extends Evidence["k"]>(path: string, kind?: K): Extract<Evidence, { k: K }> {
  const e = reg.evidence[norm(path)];
  if (!e) throw new Error(`evidence not found: ${path} (is it under evidence/ and referenced as a string literal?)`);
  if (kind && e.k !== kind) throw new Error(`${path} is ${e.k}, expected ${kind}`);
  return e as never;
}

/** data/<name>.json, parsed. */
export function useData<T = unknown>(name: string): T {
  const key = norm(name).replace(/^data\//, "").replace(/\.json$/, "");
  if (!(key in reg.data)) throw new Error(`no data/${key}.json (have: ${Object.keys(reg.data).join(", ") || "none"})`);
  return reg.data[key] as T;
}

/** An image reference: evidence path (resolved to its inlined data URI), or a data:/http(s) URL as is. */
export function imageSrc(src: string): string {
  if (/^(data:|https?:|blob:)/.test(src)) return src;
  const e = reg.evidence[norm(src)];
  if (!e || !("url" in e)) throw new Error(`image not found: ${src} (put it under evidence/ and reference it as a string literal)`);
  return e.url;
}
