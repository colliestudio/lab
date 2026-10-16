import { existsSync, readFileSync, statSync } from 'node:fs';
import { loadDoc } from './grade';
import { ALL_JOBS, JOBS } from './jobs';
import { DEFAULT_ISOLATION, ISOLATION, RESULTS, interruptAll, regrade, runJob, type Options } from './session';
import { compareTable, loadRuns, summaryLine } from './summary';

// pnpm agent:eval <job…|all> [--model M] [--budget USD] [--timeout S] [--keep] [--isolation NAME]
// pnpm agent:eval --grade <run dir | file.canvas> [--job J]      regrade offline
// pnpm agent:eval compare [results dir]                           table across runs

export interface Args {
  mode: 'run' | 'grade' | 'compare';
  jobs: string[];
  opts: Options;
  target?: string;
  job?: string;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { mode: 'run', jobs: [], opts: { budget: 2, timeoutS: 600, keep: false } };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${x} needs a value`);
      return v;
    };
    if (x === '--model') a.opts.model = val();
    else if (x === '--budget') a.opts.budget = Number(val());
    else if (x === '--timeout') a.opts.timeoutS = Number(val());
    else if (x === '--keep') a.opts.keep = true;
    else if (x === '--isolation') a.opts.isolation = val();
    else if (x === '--job') a.job = val();
    else if (x === '--grade') (a.mode = 'grade'), (a.target = val());
    else if (x === 'compare') a.mode = 'compare';
    else if (x.startsWith('--')) throw new Error(`unknown flag ${x}`);
    else if (a.mode === 'compare') a.target = x;
    else a.jobs.push(...(x === 'all' ? ALL_JOBS : [x]));
  }
  if (!(a.opts.budget > 0) || !(a.opts.timeoutS > 0)) throw new Error('--budget and --timeout must be positive numbers');
  if (a.opts.isolation && !ISOLATION[a.opts.isolation]) throw new Error(`--isolation: ${Object.keys(ISOLATION).join(' | ')} (default ${DEFAULT_ISOLATION})`);
  for (const j of [...a.jobs, ...(a.job ? [a.job] : [])]) if (!JOBS[j]) throw new Error(`unknown job ${j}; known: ${Object.keys(JOBS).join(', ')}, all`);
  if (a.mode === 'run' && !a.jobs.length) throw new Error('usage: pnpm agent:eval <job…|all> [--model M] [--budget USD] [--timeout S] [--keep]\n       pnpm agent:eval --grade <run dir|file.canvas> [--job J]\n       pnpm agent:eval compare');
  return a;
}

async function main() {
  let a: Args;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (a.mode === 'compare') {
    console.log(compareTable(loadRuns(a.target ?? RESULTS)));
    return 0;
  }
  if (a.mode === 'grade') {
    const t = a.target!;
    if (!existsSync(t)) return console.error(`not found: ${t}`), 2;
    if (statSync(t).isDirectory()) {
      console.log(summaryLine(regrade(t)));
      return 0;
    }
    if (!a.job) return console.error('--grade <file.canvas> needs --job'), 2;
    for (const c of JOBS[a.job].grade(loadDoc(readFileSync(t, 'utf8')))) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.label}  (${c.detail})`);
    return 0;
  }
  let interrupted = false;
  const onSig = () => {
    interrupted = true;
    interruptAll();
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  process.on('SIGHUP', onSig);
  let code = 0;
  for (const j of a.jobs) {
    if (interrupted) break;
    const s = await runJob(j, a.opts);
    console.log(summaryLine(s));
    console.log(`  ${RESULTS}/${s.run}${s.note ? `\n  ${s.note}` : ''}`);
    if (s.endReason === 'harness-error') code = 1;
  }
  return interrupted ? 130 : code;
}

if (process.argv[1]?.endsWith('run.ts')) main().then((c) => process.exit(c));
