import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, openSync, closeSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDoc, type Check } from './grade';
import { JOBS } from './jobs';
import { initProblems, parseStream, transcriptMarkdown } from './stream';
import { summarize, summaryMarkdown, type Meta, type Summary } from './summary';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const RESULTS = join(root, 'agent-eval', 'results');

export interface Options {
  model?: string;
  /** Max spend per job (USD), passed as --max-budget-usd. */
  budget: number;
  timeoutS: number;
  /** Keep the scratch dir under /tmp. */
  keep: boolean;
  /** Results parent folder (tests use their own). */
  resultsDir?: string;
  /** Isolation flag set, see ISOLATION. */
  isolation?: string;
  /** Extra env for the claude child (e.g. ENABLE_TOOL_SEARCH). */
  env?: Record<string, string>;
}

/**
 * Flags that keep Alex's own setup (plugins, hooks, skills, CLAUDE.md) out of the agent. Chosen by
 * probe, see the task notes. `--bare` is not an option: it never reads OAuth.
 */
export const ISOLATION: Record<string, string[]> = {
  sources: ['--setting-sources', ''],
  safe: ['--safe-mode'],
  restricted: ['--restricted', '--setting-sources', ''],
};
export const DEFAULT_ISOLATION = 'safe';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Alex's demo bridges and dev servers live in 5190-5279; never land there. */
export async function freePort(): Promise<number> {
  for (;;) {
    const p = await new Promise<number>((r, j) => {
      const s = net.createServer();
      s.on('error', j);
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => r(port));
      });
    });
    if (p < 5190 || p > 5279) return p;
  }
}

async function until(cond: () => Promise<boolean> | boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const claudeBin = () => process.env.CLAUDE_BIN ?? 'claude';

/** Child env: auth passes through; nested-session variables of a Claude session running us do not. */
export function childEnv(extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; dropped: string[] } {
  const env = { ...process.env };
  const dropped: string[] = [];
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_OAUTH_TOKEN')) {
      delete env[k];
      dropped.push(k);
    }
  }
  return { env: { ...env, ...extra }, dropped };
}

export function mcpConfig(bridgeUrl: string) {
  const loader = pathToFileURL(createRequire(join(root, 'package.json')).resolve('tsx')).href;
  return { mcpServers: { canvas: { type: 'stdio', command: process.execPath, args: ['--import', loader, join(root, 'bridge', 'mcp.ts')], env: { CANVAS_BRIDGE: bridgeUrl, CANVAS_AS: 'Agent' } } } };
}

export function claudeArgs(prompt: string, mcpFile: string, o: Pick<Options, 'model' | 'budget' | 'isolation'>): string[] {
  const iso = ISOLATION[o.isolation ?? DEFAULT_ISOLATION];
  if (!iso) throw new Error(`unknown isolation set ${o.isolation}`);
  return [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpFile, '--strict-mcp-config',
    '--tools', '',
    '--allowedTools', 'mcp__canvas__*',
    '--disallowedTools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--max-budget-usd', String(o.budget),
    ...iso,
    ...(o.model ? ['--model', o.model] : []),
  ];
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

const gitInfo = () => {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  try {
    return { head: git('rev-parse', '--short', 'HEAD'), dirty: git('status', '--porcelain').length > 0 };
  } catch {
    return { head: 'unknown', dirty: false };
  }
};

/** Everything a run has started and must stop. */
interface Live {
  claude?: ChildProcess;
  bridge?: ChildProcess;
  stopRequested?: Meta['stoppedBy'];
  stopClaude(reason: NonNullable<Meta['stoppedBy']>): void;
  killClaude(): void;
}
const live = new Set<Live>();

/** Ask every running job to stop (Ctrl-C). */
export function interruptAll() {
  for (const l of live) l.stopClaude('interrupted');
}

// Last resort when the process dies without cleanup: kill what we started (sync only).
process.on('exit', () => {
  for (const l of live) {
    if (l.claude?.pid) try { process.kill(-l.claude.pid, 'SIGKILL'); } catch {}
    if (l.bridge?.pid) try { process.kill(l.bridge.pid, 'SIGKILL'); } catch {}
  }
});

function waitExit(p: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r(true);
    const t = setTimeout(() => r(false), ms);
    p.once('exit', () => (clearTimeout(t), r(true)));
  });
}

export async function runJob(jobId: string, o: Options): Promise<Summary> {
  const job = JOBS[jobId];
  if (!job) throw new Error(`unknown job ${jobId}; known: ${Object.keys(JOBS).join(', ')}`);
  const run = `${stamp()}-${job.id}`;
  const out = join(o.resultsDir ?? RESULTS, run);
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), `canvas-eval-${job.id}-`));
  const board = join(scratch, 'board.canvas');
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const l: Live = {
    stopClaude(reason) {
      l.stopRequested ??= reason;
      l.killClaude();
    },
    killClaude() {
      const pid = l.claude?.pid;
      if (pid) {
        try { process.kill(-pid, 'SIGTERM'); } catch {}
        setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 5000).unref();
      }
    },
  };
  live.add(l);
  let note: string | undefined;
  let boardText = '';
  const guardProblems: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  const git = gitInfo();
  const cmd: Record<string, unknown> = { run, job: job.id, ...git, startedAt };
  try {
    writeFileSync(join(out, 'prompt.txt'), job.prompt + '\n');
    // scratch bridge on a free port
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const bridgeLog = openSync(join(out, 'bridge.log'), 'w');
    l.bridge = spawn(process.execPath, ['--import', 'tsx', 'bridge/server.ts', board, '--port', String(port)], { cwd: root, stdio: ['ignore', bridgeLog, bridgeLog] });
    closeSync(bridgeLog); // the child has its own copy
    await until(async () => !!(await fetch(url + '/status').catch(() => null))?.ok, 20000, 'the bridge');

    const mcpFile = join(scratch, 'mcp.json');
    writeFileSync(mcpFile, JSON.stringify(mcpConfig(url), null, 2));
    const args = claudeArgs(job.prompt, mcpFile, o);
    const { env, dropped } = childEnv(o.env);
    let version = '';
    try { version = execFileSync(claudeBin(), ['--version'], { encoding: 'utf8', env }).trim(); } catch {}
    Object.assign(cmd, { bin: claudeBin(), version, args, isolation: o.isolation ?? DEFAULT_ISOLATION, droppedEnv: dropped, extraEnv: o.env ?? {}, model: o.model ?? 'default', budgetUsd: o.budget, timeoutS: o.timeoutS, port, cwd: scratch });

    const streamFile = join(out, 'stream.jsonl');
    writeFileSync(streamFile, '');
    const claude = spawn(claudeBin(), args, { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    l.claude = claude;
    const stderr = createWriteStream(join(out, 'claude.stderr'));
    claude.stderr!.pipe(stderr);
    let buf = '';
    let guarded = false;
    claude.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        appendFileSync(streamFile, line + '\n');
        if (!guarded && line.includes('"init"')) {
          const init = parseStream([line]).init;
          if (init) {
            guarded = true;
            guardProblems.push(...initProblems(init));
            if (guardProblems.length) l.stopClaude('harness-error');
          }
        }
      }
    });
    timer = setTimeout(() => l.stopClaude('timeout'), o.timeoutS * 1000);
    const spawnError = new Promise<void>((r) => claude.once('error', (e) => (note = `could not start ${claudeBin()}: ${e.message}`, l.stopRequested ??= 'harness-error', r())));
    await Promise.race([waitExit(claude, 2 ** 31 - 1), spawnError]);
    if (buf.trim()) appendFileSync(streamFile, buf + '\n');
    clearTimeout(timer);
    // reap the rest of the claude group (its MCP server), then read the board before the bridge goes
    try { process.kill(-claude.pid!, 'SIGKILL'); } catch {}
    const get = (p: string) => fetch(url + p).then((r) => r.text());
    boardText = await get('/doc').catch(() => '');
    writeFileSync(join(out, 'board.canvas'), boardText);
    writeFileSync(join(out, 'activity.json'), await get('/log?limit=500').catch(() => '[]'));
    if (guardProblems.length) note = `isolation guard: ${guardProblems.join('; ')}`;
    else if (!guarded && !note) note = 'claude produced no init event; see claude.stderr';
    if (!guarded && !l.stopRequested) l.stopRequested = 'harness-error';
  } catch (e) {
    note = `harness error: ${(e as Error).message}`;
    l.stopRequested ??= 'harness-error';
  } finally {
    clearTimeout(timer);
    l.killClaude(); // a still-running claude after an exception
    const b = l.bridge;
    if (b) {
      b.kill('SIGTERM');
      if (!(await waitExit(b, 3000))) {
        b.kill('SIGKILL');
        await waitExit(b, 2000);
      }
    }
    live.delete(l);
    if (!o.keep) rmSync(scratch, { recursive: true, force: true });
    else note = `${note ? note + '; ' : ''}scratch kept: ${scratch}`;
  }

  const meta: Meta = { run, job: job.id, ...git, model: o.model ?? 'default', startedAt, durationMs: Date.now() - t0, stoppedBy: l.stopRequested, note };
  Object.assign(cmd, { stoppedBy: meta.stoppedBy, durationMs: meta.durationMs, model: meta.model, note });
  writeFileSync(join(out, 'cmd.json'), JSON.stringify(cmd, null, 2) + '\n');
  return finishRun(out, meta);
}

/** Parse the stream, grade the board, write transcript/grade/summary into `out`. */
export function finishRun(out: string, meta: Meta, jobId = meta.job): Summary {
  const lines = existsSync(join(out, 'stream.jsonl')) ? readFileSync(join(out, 'stream.jsonl'), 'utf8').split('\n') : [];
  const t = parseStream(lines);
  const boardFile = join(out, 'board.canvas');
  const boardText = existsSync(boardFile) ? readFileSync(boardFile, 'utf8') : '';
  let checks: Check[] = [];
  if (meta.stoppedBy !== 'harness-error' && boardText) {
    try {
      checks = JOBS[jobId].grade(loadDoc(boardText));
    } catch (e) {
      meta = { ...meta, note: `${meta.note ?? ''} grader failed: ${(e as Error).message}` };
    }
  }
  if (jobId === 'smoke' && meta.stoppedBy !== 'harness-error') checks.push({ id: 'tool-call', label: 'at least one canvas tool call', pass: t.calls.length >= 1, detail: `${t.calls.length} calls` });
  const s = summarize(t, checks, meta);
  writeFileSync(join(out, 'transcript.md'), transcriptMarkdown(t));
  writeFileSync(join(out, 'grade.json'), JSON.stringify(checks, null, 2) + '\n');
  writeFileSync(join(out, 'summary.json'), JSON.stringify(s, null, 2) + '\n');
  writeFileSync(join(out, 'summary.md'), summaryMarkdown(s));
  return s;
}

/** Regrade a stored run (after a grader or parser change). */
export function regrade(out: string): Summary {
  const cmd = JSON.parse(readFileSync(join(out, 'cmd.json'), 'utf8'));
  const meta: Meta = { run: cmd.run, job: cmd.job, head: cmd.head, dirty: cmd.dirty, model: cmd.model, startedAt: cmd.startedAt, durationMs: cmd.durationMs, stoppedBy: cmd.stoppedBy, note: cmd.note };
  return finishRun(out, meta);
}

export { alive };
