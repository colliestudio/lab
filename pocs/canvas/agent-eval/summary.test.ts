import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from './grade';
import { parseStream } from './stream';
import { compareTable, loadRuns, summarize, summaryMarkdown, type Meta } from './summary';

const L = (o: unknown) => JSON.stringify(o);
const meta = (run: string, job = 'notes', more: Partial<Meta> = {}): Meta => ({ run, job, head: 'abc1234', dirty: false, model: 'claude-x', startedAt: run, durationMs: 5000, ...more });
const use = (id: string, command: string, msg: string) => L({ type: 'assistant', message: { id: msg, usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: 'tool_use', id, name: 'mcp__canvas__canvas_do', input: { command } }] } });
const res = (id: string, text: string, is_error = false) => L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: text }] } });
const transcript = () =>
  parseStream([use('a', 'board.add', 'm1'), res('a', 'ok'), use('b', 'storm.add', 'm2'), res('b', '(no description for this command yet)'), use('c', 'board.add', 'm3'), res('c', 'bad', true), L({ type: 'result', subtype: 'success', duration_ms: 9000, num_turns: 4, total_cost_usd: 0.25 })]);
const checks = [check('a', 'first', true, 'ok'), check('b', 'second', false, '1 of 2')];

describe('summary', () => {
  it('has the fields of a run', () => {
    const s = summarize(transcript(), checks, meta('r1'));
    expect(s).toMatchObject({ job: 'notes', passed: 1, total: 2, pass: false, toolCalls: 3, errors: 1, undescribed: 1, endReason: 'done', durationMs: 9000, turns: 4, costUsd: 0.25 });
    expect(s.perTool).toEqual({ 'canvas_do board.add': 2, 'canvas_do storm.add': 1 });
  });
  it('end reason: harness stop wins, budget from the result', () => {
    expect(summarize(transcript(), checks, meta('r', 'notes', { stoppedBy: 'timeout' })).endReason).toBe('timeout');
    expect(summarize(parseStream([L({ type: 'result', subtype: 'error_max_budget_usd' })]), checks, meta('r')).endReason).toBe('budget');
  });
  it('markdown has one line per check', () => {
    const md = summaryMarkdown(summarize(transcript(), checks, meta('r1')));
    expect(md.split('\n').filter((l) => l.startsWith('- ['))).toEqual(['- [x] first (ok)', '- [ ] second (1 of 2)']);
  });
  it('compare groups by job and orders by time', () => {
    const mk = (run: string, job: string) => summarize(transcript(), checks, meta(run, job));
    const rows = compareTable([mk('2', 'storm'), mk('3', 'notes'), mk('1', 'notes')]).split('\n').slice(2);
    expect(rows.map((r) => r.split(' | ').slice(0, 2).join(' '))).toEqual(['| notes 1', '| notes 3', '| storm 2']);
  });
  it('loadRuns skips dirs without a summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ae-sum-'));
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'b', 'summary.json'), JSON.stringify(summarize(transcript(), checks, meta('b'))));
    expect(loadRuns(dir).map((s) => s.run)).toEqual(['b']);
    rmSync(dir, { recursive: true });
  });
});
