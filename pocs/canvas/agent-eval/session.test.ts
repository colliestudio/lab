import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from './run';
import { alive, claudeArgs, childEnv, freePort, regrade, runJob, root, type Options } from './session';

const fake = join(root, 'agent-eval', 'fixtures', 'fake-claude.mjs');
let results: string;
const opts = (more: Partial<Options> = {}): Options => ({ budget: 1, timeoutS: 60, keep: false, resultsDir: results, ...more });
const scratchDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('canvas-eval-'));
const saved = { ...process.env };

beforeAll(() => {
  results = mkdtempSync(join(tmpdir(), 'ae-results-'));
  process.env.CLAUDE_BIN = fake;
  execFileSync('chmod', ['+x', fake]);
});
afterAll(() => {
  process.env = saved;
  rmSync(results, { recursive: true, force: true });
});

describe('session with a fake claude', () => {
  it('runs a job: files written, board graded, bridge port free, scratch dir gone', async () => {
    const before = scratchDirs();
    const s = await runJob('notes', opts());
    expect(s.endReason).toBe('done');
    expect(s.toolCalls).toBe(1);
    expect(s.checks.length).toBe(4);
    const dir = join(results, s.run);
    for (const f of ['prompt.txt', 'cmd.json', 'stream.jsonl', 'transcript.md', 'claude.stderr', 'bridge.log', 'board.canvas', 'activity.json', 'grade.json', 'summary.json', 'summary.md']) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(readFileSync(join(dir, 'board.canvas'), 'utf8')).toContain('Fake note');
    const cmd = JSON.parse(readFileSync(join(dir, 'cmd.json'), 'utf8'));
    expect(cmd.args).toContain('--strict-mcp-config');
    expect(cmd.args[cmd.args.indexOf('--tools') + 1]).toBe('');
    const port = cmd.port as number;
    await expect(fetch(`http://127.0.0.1:${port}/status`)).rejects.toThrow();
    expect(scratchDirs()).toEqual(before);
    // regrading the stored run reproduces the stored grade
    const stored = readFileSync(join(dir, 'grade.json'), 'utf8');
    regrade(dir);
    expect(readFileSync(join(dir, 'grade.json'), 'utf8')).toBe(stored);
  }, 60000);

  it('a hanging claude is stopped at the timeout, with its children', async () => {
    const pidfile = join(results, 'pids.json');
    const s = await runJob('smoke', opts({ timeoutS: 3, env: { FAKE_HANG: '1', FAKE_PIDFILE: pidfile } }));
    expect(s.endReason).toBe('timeout');
    const pids = JSON.parse(readFileSync(pidfile, 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pids.claude)).toBe(false);
    expect(alive(pids.child)).toBe(false);
  }, 60000);

  it('a foreign tool in init is a harness error: claude killed, nothing graded', async () => {
    const pidfile = join(results, 'pids2.json');
    const s = await runJob('notes', opts({ env: { FAKE_HANG: '1', FAKE_TOOLS: 'Bash', FAKE_PIDFILE: pidfile } }));
    expect(s.endReason).toBe('harness-error');
    expect(s.checks).toEqual([]);
    expect(s.note).toMatch(/Bash/);
    const pids = JSON.parse(readFileSync(pidfile, 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pids.claude)).toBe(false);
  }, 60000);

  it('a missing claude binary is a harness error and leaves nothing', async () => {
    process.env.CLAUDE_BIN = '/nonexistent/claude';
    try {
      const s = await runJob('smoke', opts());
      expect(s.endReason).toBe('harness-error');
    } finally {
      process.env.CLAUDE_BIN = fake;
    }
  }, 60000);
});

describe('Ctrl-C', () => {
  it('SIGINT mid-run stops claude, its children and the bridge, and exits 130', async () => {
    const pidfile = join(results, 'pids3.json');
    const cli = spawn(process.execPath, ['--import', 'tsx', 'agent-eval/run.ts', 'smoke'], { cwd: root, env: { ...process.env, AGENT_EVAL_RESULTS: results, FAKE_HANG: '1', FAKE_PIDFILE: pidfile }, stdio: 'ignore' });
    const code = new Promise<number | null>((r) => cli.on('exit', (c) => r(c)));
    for (let i = 0; i < 200 && !existsSync(pidfile); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500));
    cli.kill('SIGINT');
    expect(await code).toBe(130);
    const pids = JSON.parse(readFileSync(pidfile, 'utf8'));
    expect(alive(pids.claude)).toBe(false);
    expect(alive(pids.child)).toBe(false);
    const runs = readdirSync(results).filter((d) => d.endsWith('-smoke'));
    const last = JSON.parse(readFileSync(join(results, runs[runs.length - 1], 'summary.json'), 'utf8'));
    expect(last.endReason).toBe('interrupted');
  }, 60000);
});

describe('pieces', () => {
  it('never picks a port in 5190-5279', async () => {
    for (let i = 0; i < 20; i++) {
      const p = await freePort();
      expect(p < 5190 || p > 5279).toBe(true);
    }
  });
  it('claude args: canvas MCP only, no built-in tools, model only when given', () => {
    const a = claudeArgs('hi', '/x/mcp.json', { budget: 2 });
    expect(a).toEqual(expect.arrayContaining(['--strict-mcp-config', '--allowedTools', 'mcp__canvas__*', '--no-session-persistence']));
    expect(a).not.toContain('--model');
    expect(claudeArgs('hi', '/x', { budget: 2, model: 'sonnet' })).toEqual(expect.arrayContaining(['--model', 'sonnet']));
  });
  it('child env drops nested-session variables but keeps the OAuth token', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'x';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 't';
    const { env, dropped } = childEnv({ A: 'b' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('t');
    expect(env.A).toBe('b');
    expect(dropped).toContain('CLAUDECODE');
  });
  it('parses the command line', () => {
    expect(parseArgs(['all', '--model', 'sonnet', '--budget', '3']).jobs).toEqual(['notes', 'storm', 'proto']);
    expect(parseArgs(['--grade', '/x', '--job', 'proto'])).toMatchObject({ mode: 'grade', target: '/x', job: 'proto' });
    expect(() => parseArgs(['nope'])).toThrow(/unknown job/);
    expect(() => parseArgs([])).toThrow(/usage/);
  });
});
