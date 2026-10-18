#!/usr/bin/env node
// Helper for the /canvas skill. No dependencies: Node built-ins and global fetch.
//   node canvas-wait.mjs name                      seat name for this directory
//   node canvas-wait.mjs follow <canvas> --as <seat> [--serve URL]
//                                                  print each new chat message as one line (for a Monitor)

import { execFile, execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const DEFAULT_SERVE = 'http://localhost:5310'; // the always-on serve; a dev `pnpm serve` defaults to 5231
const MAX_NAME = 30; // canvas_join rejects names over 32; leaves room for the skill's " 2" retry suffix

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

function seatName(cwd = process.cwd()) {
  const at = (...a) => git('-C', cwd, ...a);
  const task = /^task-(\d+(?:\.\d+)*)(?:-|$)/.exec(at('symbolic-ref', '--short', 'HEAD'));
  const top = at('rev-parse', '--show-toplevel');
  const label = task ? `task-${task[1]}` : basename(top || cwd) || 'session';
  return `Claude · ${label}`.slice(0, MAX_NAME);
}

// Same rule as mentions() in src/core/chat.ts.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentions(text, name) {
  if (/(^|[\s(])@(all|everyone)(?![\w-])/i.test(text)) return true;
  name = name?.trim();
  return !!name && new RegExp(`(^|[\\s(])@${esc(name)}(?![\\w-])`, 'i').test(text);
}

function line(m, seat) {
  const d = new Date(m.time);
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const kind = m.from.kind ? ` (${m.from.kind})` : '';
  const re = m.node ? `  (re: ${m.node})` : '';
  return `${mentions(m.text, seat) ? '@you ' : ''}[${t}] ${m.from.name}${kind}: ${m.text.replace(/\s*\n\s*/g, ' ')}${re}`;
}

// Returns the exit code. Exits go through the event loop, not process.exit(), so a batch just
// written (and already marked seen by the serve) is not dropped.
async function follow(board, seat, serve) {
  const base = `${serve.replace(/\/+$/, '')}/api/boards/${encodeURIComponent(board)}`;
  const backoff = Number(process.env.CANVAS_WAIT_BACKOFF_MS) || 1000;
  // Consecutive failures this long end the follow; long enough to ride over a serve restart.
  const giveUpMs = Number(process.env.CANVAS_WAIT_GIVEUP_MS) || 30000;
  const ac = new AbortController();
  let code = null;
  const stop = (c) => {
    if (code === null) code = c;
    ac.abort();
  };
  // A Monitor's process outlives a session that ends without stopping it, and an orphan would keep
  // answering for the seat and eat the next session's messages. Bounds: its own lifetime (under the
  // Monitor's 30 minute timeout, so it ends cleanly first), the output pipe closing, and its
  // ancestors changing. Claude runs commands under a wrapper shell with stdout in a file, so our own
  // parent survives the session: record a few ancestors (parent, grandparent, ...) and stop when any
  // of their parents changes or one is gone.
  const links = (pids) =>
    new Promise((res) =>
      execFile('ps', ['-o', 'pid=,ppid=', '-p', pids.join(',')], { encoding: 'utf8' }, (e, out) => {
        res(new Map(String(out).split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2)));
      }),
    );
  const chain = new Map(); // pid -> its ppid when we started
  for (let pid = String(process.ppid); Number(pid) > 1 && chain.size < 4; ) {
    const next = (await links([pid])).get(pid);
    if (!next) break;
    chain.set(pid, next);
    pid = next;
  }
  let checking = false;
  const timers = [
    setTimeout(() => stop(0), Number(process.env.CANVAS_WAIT_MAX_MS) || 29 * 60 * 1000),
    setInterval(async () => {
      if (checking || !chain.size) return;
      checking = true;
      const now = await links([...chain.keys()]);
      // No output at all means `ps` itself failed (fork error under load), not that every link is gone.
      if (now.size && [...chain].some(([pid, ppid]) => now.get(pid) !== ppid)) stop(0);
      checking = false;
    }, Number(process.env.CANVAS_WAIT_PPID_MS) || 3000),
  ];
  process.stdout.on('error', () => stop(0));
  let failedSince = 0;
  let failures = 0;
  let seated = false;
  while (code === null) {
    try {
      if (!seated) {
        // The seat comes from the MCP join; a missing one means this is not the MCP's serve.
        const r = await fetch(`${base}/status`, { signal: ac.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
        const st = await r.json();
        if (!Array.isArray(st?.actors)) throw new Error('unexpected reply (not a canvas serve?)');
        // The serve seats actors by slug (makeActor in server/core/host.ts), so fold the same way.
        const slug = seat.slice(0, 32).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
        if (!st.actors.some((a) => a?.id === `agent:${slug}`)) {
          process.stderr.write(`canvas-wait: seat "${seat}" is not on canvas "${board}" at ${serve} (wrong --serve? join over MCP first)\n`);
          code = 1;
          break;
        }
        seated = true;
      }
      const r = await fetch(`${base}/chat/wait?as=${encodeURIComponent(seat)}&timeout=290`, { signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      const body = await r.json();
      const waiting = body && !Array.isArray(body) && body.waiting === true;
      if (!Array.isArray(body) && !waiting) throw new Error('unexpected reply (not a canvas serve?)');
      failures = 0;
      if (Array.isArray(body) && body.length) process.stdout.write(body.map((m) => line(m, seat)).join('\n') + '\n');
    } catch (e) {
      if (code !== null) break;
      if (!failures++) failedSince = Date.now();
      process.stderr.write(`canvas-wait: ${e.message} (failing for ${Math.round((Date.now() - failedSince) / 1000)}s) canvas "${board}" at ${serve}\n`);
      if (Date.now() - failedSince >= giveUpMs) {
        process.stderr.write(`canvas-wait: gave up on canvas "${board}" at ${serve}\n`);
        code = 1;
        break;
      }
      await new Promise((r) => setTimeout(r, Math.min(backoff * 2 ** (failures - 1), 5000)));
    }
  }
  timers.forEach(clearTimeout);
  return code;
}

function usage() {
  process.stderr.write('usage: canvas-wait.mjs name | follow <canvas> --as <seat> [--serve URL]\n');
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'name') {
  console.log(seatName());
} else if (cmd === 'follow') {
  let board, seat, serve = process.env.CANVAS_SERVE || DEFAULT_SERVE;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--as') seat = rest[++i];
    else if (rest[i] === '--serve') serve = rest[++i];
    else if (!rest[i].startsWith('--') && !board) board = rest[i];
    else usage();
  }
  if (!board || !seat || !serve) usage();
  const code = await follow(board, seat, serve);
  process.exitCode = code;
  process.stdout.write('', () => process.exit(code)); // flush what is pending first
  setTimeout(() => process.exit(code), 1000).unref();
} else usage();
