// The review comment model and its pure helpers (no React, no registry: usable from tests and scripts).
import type { Answer } from "./feedback.ts";

export type Severity = "blocking" | "should-fix" | "question" | "nit" | "praise";
export const SEVERITIES: Severity[] = ["blocking", "should-fix", "question", "nit", "praise"];

export interface ReviewComment {
  id: string; file: string; line?: number; range?: [number, number]; severity: Severity; body: string;
  /** replacement code for the commented lines */
  suggestion?: string; evidence?: string;
  /** id (or label) of an earlier reviewer's comment this repeats */
  dupOf?: string;
}
/** An author's note on the diff (requester mode): where to look and why. */
export interface AuthorNote { file: string; line?: number; range?: [number, number]; body: string }

export const span = (c: { line?: number; range?: [number, number] }): [number, number] => (c.range ?? [c.line ?? 0, c.line ?? 0]);
export const where = (c: ReviewComment) => { const [a, b] = span(c); return a ? `${c.file}:${a}${b !== a ? `-${b}` : ""}` : c.file; };


export type CommentStatus = "undecided" | "keep" | "edit" | "drop";
export const key = (id: string) => "rc:" + id;
export function statusOf(c: ReviewComment, answers: Record<string, Answer>): { status: CommentStatus; body: string } {
  const a = answers[key(c.id)];
  const status = (a?.choice as CommentStatus | undefined) ?? "undecided";
  return { status, body: status === "edit" ? a?.custom ?? c.body : c.body };
}
/** Comment counts by severity (dropped ones excluded when `answers` is given). */
export function countBySeverity(list: ReviewComment[], answers?: Record<string, Answer>): Record<Severity, number> {
  const out = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const c of list) if (!answers || statusOf(c, answers).status !== "drop") out[c.severity]++;
  return out;
}

/** GitHub-ready Markdown of the kept and edited comments, grouped by file. */
export function reviewMarkdown(o: { title?: string; summary?: string; verdict?: string; comments: ReviewComment[]; answers: Record<string, Answer> }): string {
  const used = o.comments.map((c) => ({ c, ...statusOf(c, o.answers) })).filter((x) => x.status === "keep" || x.status === "edit");
  const L: string[] = [];
  if (o.title) L.push(`## Review: ${o.title}`, "");
  if (o.verdict) L.push(`**Verdict:** ${o.verdict}`, "");
  if (o.summary) L.push(o.summary.trim(), "");
  const counts = countBySeverity(used.map((x) => x.c));
  const cs = SEVERITIES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  if (cs.length) L.push(`${used.length} comments: ${cs.join(", ")}`, "");
  const files = [...new Set(used.map((x) => x.c.file))];
  for (const f of files) {
    L.push(`### \`${f}\``, "");
    for (const x of used.filter((u) => u.c.file === f)) {
      const [a, b] = span(x.c);
      L.push(`- ${a ? `**L${a}${b !== a ? `-${b}` : ""}**` : "**file**"} (${x.c.severity}) ${x.body.trim().replace(/\n/g, "\n  ")}`);
      if (x.c.suggestion != null) L.push("", "  ```suggestion", ...x.c.suggestion.split("\n").map((l) => "  " + l), "  ```");
    }
    L.push("");
  }
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
/** One comment as a standalone GitHub comment body. */
export function commentMarkdown(c: ReviewComment, body = c.body): string {
  return `${body.trim()}${c.suggestion != null ? `\n\n\`\`\`suggestion\n${c.suggestion}\n\`\`\`` : ""}\n`;
}

