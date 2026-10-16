import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from './grade';
import type { Transcript, Usage } from './stream';

export type EndReason = 'done' | 'timeout' | 'budget' | 'interrupted' | 'harness-error';

export interface Meta {
  run: string;
  job: string;
  head: string;
  dirty: boolean;
  model: string;
  startedAt: string;
  durationMs: number;
  /** Set by the session when it stopped the run itself. */
  stoppedBy?: 'timeout' | 'interrupted' | 'harness-error';
  note?: string;
  /** Set when a stored run was graded again: when, and with which code. */
  regraded?: { at: string; head: string };
}

export interface Summary {
  run: string;
  job: string;
  head: string;
  dirty: boolean;
  model: string;
  startedAt: string;
  passed: number;
  total: number;
  pass: boolean;
  checks: Check[];
  toolCalls: number;
  /** Tool results with is_error plus permission denials. */
  errors: number;
  denied: number;
  undescribed: number;
  noops: number;
  /** Calls with no result (the run was cut off). */
  cutOff: number;
  perTool: Record<string, number>;
  tokens: Usage;
  costUsd?: number;
  durationMs: number;
  turns?: number;
  endReason: EndReason;
  note?: string;
  regraded?: { at: string; head: string };
}

export function summarize(t: Transcript, checks: Check[], meta: Meta): Summary {
  const perTool: Record<string, number> = {};
  for (const c of t.calls) {
    const key = c.name.replace(/^mcp__canvas__/, '');
    const cmd = key === 'canvas_do' && c.input && typeof (c.input as any).command === 'string' ? `canvas_do ${(c.input as any).command}` : key;
    perTool[cmd] = (perTool[cmd] ?? 0) + 1;
  }
  const counted = checks.filter((c) => !c.info);
  const passed = counted.filter((c) => c.pass).length;
  const sub = t.result?.subtype ?? '';
  const endReason: EndReason = meta.stoppedBy ?? (sub === 'error_max_budget_usd' ? 'budget' : 'done');
  return {
    run: meta.run,
    job: meta.job,
    head: meta.head,
    dirty: meta.dirty,
    model: t.init?.model ?? meta.model,
    startedAt: meta.startedAt,
    passed,
    total: counted.length,
    pass: counted.length > 0 && passed === counted.length,
    checks,
    toolCalls: t.calls.length,
    errors: t.calls.filter((c) => c.error).length + t.permissionDenials.length,
    denied: t.permissionDenials.length,
    undescribed: t.calls.filter((c) => c.undescribed).length,
    noops: t.calls.filter((c) => c.noop).length,
    cutOff: t.calls.filter((c) => !c.done).length,
    perTool,
    tokens: t.usage,
    costUsd: t.result?.costUsd,
    durationMs: t.result?.durationMs ?? meta.durationMs,
    turns: t.result?.turns,
    endReason,
    note: meta.note,
    ...(meta.regraded ? { regraded: meta.regraded } : {}),
  };
}

const k = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : String(n));
const tok = (u: Usage) => `${k(u.in + u.cacheRead + u.cacheWrite)} in (${k(u.cacheRead)} cached) / ${k(u.out)} out`;

export function summaryLine(s: Summary): string {
  return `${s.job}: ${s.pass ? 'PASS' : 'FAIL'} ${s.passed}/${s.total}, ${s.toolCalls} calls, ${s.errors} errors, ${tok(s.tokens)}, ${s.costUsd !== undefined ? '$' + s.costUsd.toFixed(2) + ', ' : ''}${Math.round(s.durationMs / 1000)}s, ${s.endReason}`;
}

export function summaryMarkdown(s: Summary): string {
  const tools = Object.entries(s.perTool)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n} x${c}`)
    .join(', ');
  return [
    `# ${s.job} ${s.run}`,
    '',
    `${s.pass ? 'PASS' : 'FAIL'} ${s.passed}/${s.total} | ${s.model} | head ${s.head}${s.dirty ? '+dirty' : ''} | ${s.endReason}`,
    '',
    ...s.checks.map((c) => `- ${c.info ? '[i]' : c.pass ? '[x]' : '[ ]'} ${c.label}${c.info ? (c.pass ? ' (info: yes)' : ' (info: no)') : ''} (${c.detail})`),
    '',
    `Tool calls ${s.toolCalls}, errors ${s.errors} (denied ${s.denied}), undescribed ${s.undescribed}, no-ops ${s.noops}, cut off ${s.cutOff ?? 0}`,
    `Tokens ${tok(s.tokens)}${s.costUsd !== undefined ? `, $${s.costUsd.toFixed(2)}` : ''}, ${Math.round(s.durationMs / 1000)}s${s.turns ? `, ${s.turns} turns` : ''}`,
    `Tools: ${tools || 'none'}`,
    ...(s.note ? ['', s.note] : []),
    '',
  ].join('\n');
}

export function compareTable(runs: Summary[]): string {
  const rows = runs
    .slice()
    .sort((a, b) => (a.job === b.job ? a.startedAt.localeCompare(b.startedAt) : a.job.localeCompare(b.job)))
    .map((s) => `| ${s.job} | ${s.run} | ${s.head}${s.dirty ? '+' : ''}${s.regraded ? ` (regraded ${s.regraded.head})` : ''} | ${s.model} | ${s.pass ? 'PASS' : 'FAIL'} ${s.passed}/${s.total} | ${s.toolCalls} | ${s.errors} | ${s.noops ?? '-'} | ${s.undescribed} | ${tok(s.tokens)} | ${s.costUsd !== undefined ? s.costUsd.toFixed(2) : '-'} | ${Math.round(s.durationMs / 1000)} | ${s.endReason} |`);
  return ['| job | run | head | model | checks | calls | errors | no-ops | undescribed | tokens | $ | s | end |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

export function loadRuns(resultsDir: string): Summary[] {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .sort()
    .flatMap((d) => {
      const f = join(resultsDir, d, 'summary.json');
      return existsSync(f) ? [JSON.parse(readFileSync(f, 'utf8')) as Summary] : [];
    });
}
