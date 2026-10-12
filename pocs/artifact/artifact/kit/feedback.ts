// Reader answers to <Decision>s (the async "grill me"): the types, the context the host provides, and the pure helpers.
import { createContext, isValidElement, useContext, type ReactNode } from "react";
import type { DecisionMeta } from "./registry.ts";

export interface Answer {
  /** the option key ("a", "b"…), or "other" (own answer in `custom`), or "unsure" (not sure / discuss) */
  choice: string;
  /** the chosen option's text, the reader's own text, or "not sure / discuss" */
  label: string;
  custom?: string;
  note?: string;
  /** the chosen option was the recommended one */
  rec?: boolean;
  at: string;
}
export interface FeedbackCtxValue {
  /** true when a host collects answers; without one (static render) decisions show as plain lists */
  interactive: boolean;
  answers: Record<string, Answer>;
  answer(id: string, a: Answer | null): void;
}
export const FeedbackCtx = createContext<FeedbackCtxValue>({ interactive: false, answers: {}, answer: () => {} });
export const useAnswer = (id: string): Answer | undefined => useContext(FeedbackCtx).answers[id];
/** All answers so far, by decision id: `const answers = useAnswers(); answers.d1?.choice` */
export const useAnswers = () => useContext(FeedbackCtx).answers;

export const keyOfIndex = (i: number) => String.fromCharCode(97 + i);

/** Plain text of a React node (labels may be elements). */
export function nodeText(n: ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(nodeText).join("");
  if (isValidElement(n)) return nodeText((n.props as { children?: ReactNode }).children);
  return "";
}

export type Want = string | number | (string | number)[];
/** Does the answer match `want`: an option key ("a"), its label (case-insensitive), "other" or "unsure"? */
export function matchesAnswer(a: Answer | undefined, want: Want | undefined): boolean {
  if (!a || want == null) return false;
  return (Array.isArray(want) ? want : [want]).some((w) => {
    const s = String(w).toLowerCase();
    return a.choice.toLowerCase() === s || a.label.toLowerCase() === s;
  });
}

export interface DecisionRow {
  id: string; question: string; recommended?: string; owner?: string; answer?: Answer;
  /** the page it lives on (multi-page artifacts) */
  page?: string; pageTitle?: string;
}

/** The conditions of the `<When>`s a decision sits inside (collected at build time so other pages' decisions are known). */
export type Cond = NonNullable<DecisionMeta["when"]>[number];
export const WhenCtx = createContext<Cond[]>([]);

/** Does a `<When>` condition hold for the answers given? */
export function condHolds(c: Cond, answers: Record<string, Answer>): boolean {
  const a = answers[c.decision];
  return (c.is == null || matchesAnswer(a, c.is)) && (c.not == null || (!!a && !matchesAnswer(a, c.not))) && (!c.answered || !!a) && (!c.unanswered || !a);
}
export const reachable = (d: { when?: Cond[] }, answers: Record<string, Answer>) => (d.when ?? []).every((c) => condHolds(c, answers));

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/**
 * Markdown an agent can apply: one bullet per decision with its id, the chosen option (and key), and the note.
 * When decisions live on several pages they are grouped under the page title and the bullet names the page id.
 */
export function decisionsMarkdown(title: string, rows: DecisionRow[]): string {
  const lines = [`# Decisions on "${title}"`, ""];
  const pages = [...new Set(rows.map((r) => r.page).filter(Boolean))];
  const multi = pages.length > 1;
  let last: string | undefined = "";
  for (const r of rows) {
    if (multi && r.page !== last) { lines.push(`## ${r.pageTitle ?? r.page} (page: ${r.page})`, ""); last = r.page; }
    lines.push(`- **${r.id}**${multi && r.page ? ` (page: ${r.page})` : ""} — ${oneLine(r.question)}`);
    const a = r.answer;
    if (!a) lines.push("  - answer: (not decided)");
    else if (a.choice === "unsure") lines.push("  - answer: not sure / discuss");
    else if (a.choice === "other") lines.push(`  - answer: own answer: ${oneLine(a.custom ?? a.label)}`);
    else lines.push(`  - answer: ${oneLine(a.label)} [${a.choice}]${a.rec ? " (the recommended option)" : r.recommended ? ` (differs from the recommendation: ${oneLine(r.recommended)})` : ""}`);
    if (a?.note) lines.push(`  - note: ${oneLine(a.note)}`);
    if (multi) lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
