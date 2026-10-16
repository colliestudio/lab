import { describe, expect, it } from 'vitest';
import { initProblems, parseStream, transcriptMarkdown } from './stream';

const L = (o: unknown) => JSON.stringify(o);
const init = (tools = ['mcp__canvas__canvas_help'], extra: object = {}) => L({ type: 'system', subtype: 'init', model: 'm', tools, mcp_servers: [{ name: 'canvas', status: 'connected' }], plugins: [], skills: [], slash_commands: [], ...extra });
const use = (id: string, name = 'mcp__canvas__canvas_do', msg = 'msg1', usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }) =>
  L({ type: 'assistant', message: { id: msg, usage, content: [{ type: 'tool_use', id, name, input: { command: 'board.add' } }] } });
const res = (id: string, text: string, is_error = false) => L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: [{ type: 'text', text }] }] } });

describe('parseStream', () => {
  it('pairs tool_use with tool_result and flags errors, undescribed and no-ops', () => {
    const t = parseStream([init(), use('a'), res('a', '{"changed": 1}'), use('b', undefined, 'msg2'), res('b', 'bad args', true), use('c', undefined, 'msg3'), res('c', '(no description for this command yet)'), use('d', undefined, 'msg4'), res('d', '{"changed": 0}')]);
    expect(t.calls.map((c) => [c.done, c.error, c.undescribed, c.noop])).toEqual([[true, false, false, false], [true, true, false, false], [true, false, true, false], [true, false, false, true]]);
    expect(t.calls[1].text).toBe('bad args');
  });
  it('counts usage once per message id', () => {
    const t = parseStream([use('a'), use('b'), res('a', 'x'), use('c', undefined, 'msg2')]);
    expect(t.usage).toEqual({ in: 20, out: 10, cacheRead: 200, cacheWrite: 40 });
  });
  it('ignores blank and cut-off lines but counts them', () => {
    const t = parseStream([init(), '', use('a'), '{"type":"assistant","mess']);
    expect(t.parseErrors).toBe(1);
    expect(t.calls).toHaveLength(1);
  });
  it('a killed run: no result, call without a result stays open', () => {
    const t = parseStream([init(), use('a')]);
    expect(t.result).toBeUndefined();
    expect(t.calls[0].done).toBe(false);
    expect(transcriptMarkdown(t)).toContain('cut off');
  });
  it('reads the result event: totals, denials', () => {
    const t = parseStream([L({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, num_turns: 3, total_cost_usd: 0.5, usage: { input_tokens: 7, output_tokens: 8 }, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'ls' } }] })]);
    expect(t.result).toMatchObject({ subtype: 'success', durationMs: 1234, turns: 3, costUsd: 0.5 });
    expect(t.usage.in).toBe(7);
    expect(t.permissionDenials).toEqual([{ tool: 'Bash', input: { command: 'ls' } }]);
  });
  it('keeps assistant text once even when the message repeats', () => {
    const m = L({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }] } });
    expect(parseStream([m, m]).texts).toEqual(['Hello']);
  });
});

describe('initProblems', () => {
  it('accepts only canvas tools with the canvas server connected', () => {
    expect(initProblems(parseStream([init()]).init)).toEqual([]);
  });
  it('flags foreign tools, plugins, a missing server and no init', () => {
    expect(initProblems(parseStream([init(['mcp__canvas__x', 'Bash'])]).init)[0]).toMatch(/Bash/);
    expect(initProblems(parseStream([init(undefined, { plugins: [{ name: 'devteam' }] })]).init)[0]).toMatch(/devteam/);
    expect(initProblems(parseStream([init(undefined, { mcp_servers: [{ name: 'canvas', status: 'failed' }] })]).init)[0]).toMatch(/failed/);
    expect(initProblems(parseStream([init(undefined, { skills: ['artifact', 'loop'] })]).init, ['artifact'])[0]).toMatch(/artifact/);
    expect(initProblems(parseStream([init(undefined, { plugins: [{ name: 'b', path: 'builtin' }] })]).init)).toEqual([]);
    expect(initProblems(undefined)).toEqual(['no init event']);
  });
});
