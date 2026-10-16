import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { hostname, platform, uptime } from 'node:os';
import { join } from 'node:path';

// The folder lock: one writer per folder of .canvas files. A server that serves a folder live (canvas serve,
// later the desktop app) takes it; anything else that would write boards there must check it first.
//
// Contract
//  - File: <folder>/.canvas-serve.lock, JSON { v, app, pid, machine, host, bootAt, startedAt, port, urls, token }.
//    Written once with exclusive create, removed by its owner on exit (only if `token` is still its own).
//  - Held = a foreign `machine`, or this machine with the pid alive and the same boot (bootAt within 60 s).
//    Unparseable or missing = free. After a reboot or a crash the file is stale and the next writer replaces it.
//  - A writer that finds it held must not open boards in that folder live: use the service (`urls`) as the
//    backend, or open read-only. A writer that writes the folder itself takes the lock the same way.
//  - iCloud syncs the file with a delay: right after a serve starts there is a window where another Mac
//    has not seen it yet. A foreign lock that outlives its machine is removed by hand (the message says so).

export const LOCK_FILE = '.canvas-serve.lock';
const BOOT_SLACK_MS = 60_000;

export interface LockHolder {
  v: 1;
  app: 'canvas serve';
  pid: number;
  /** Stable id of the machine (IOPlatformUUID on macOS): hostnames change with the network. */
  machine: string;
  /** Hostname, for messages. */
  host: string;
  /** Boot time (ms since epoch), so a pid reused after a reboot is not mistaken for the holder. */
  bootAt: number;
  startedAt: string;
  port: number;
  urls: string[];
  token: string;
}

export interface Here {
  machine: string;
  host: string;
  bootAt: number;
}

let cached: Here | undefined;
export function hereInfo(): Here {
  if (cached) return cached;
  let machine = hostname();
  if (platform() === 'darwin') {
    try {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
      machine = /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1] ?? machine;
    } catch {
      /* hostname stays */
    }
  }
  return (cached = { machine, host: hostname(), bootAt: Date.now() - uptime() * 1000 });
}

export interface LockState {
  holder?: LockHolder;
  held: boolean;
  reason: string;
}

function parse(text: string): LockHolder | undefined {
  try {
    const h = JSON.parse(text) as LockHolder;
    return h && h.v === 1 && Number.isInteger(h.pid) && typeof h.machine === 'string' && typeof h.bootAt === 'number' && Array.isArray(h.urls) ? h : undefined;
  } catch {
    return undefined;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function judge(text: string | undefined, here: Here): LockState {
  if (text === undefined) return { held: false, reason: 'no lock' };
  const holder = parse(text);
  if (!holder) return { held: false, reason: 'unreadable lock file (stale)' };
  // ioreg failed for one of the two (its machine id fell back to the hostname): same Mac if the hostnames match
  const sameMachine = holder.machine === here.machine || (here.machine === here.host && holder.host === here.host) || (holder.machine === holder.host && holder.host === here.host);
  if (!sameMachine) return { holder, held: true, reason: `held from ${holder.host}` };
  if (holder.pid === process.pid) return { holder, held: false, reason: 'our own pid (stale)' };
  if (Math.abs(holder.bootAt - here.bootAt) >= BOOT_SLACK_MS) return { holder, held: false, reason: 'from before the last boot (stale)' };
  if (!alive(holder.pid)) return { holder, held: false, reason: `pid ${holder.pid} is gone (stale)` };
  return { holder, held: true, reason: `pid ${holder.pid} is running` };
}

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
};

export const lockPath = (dir: string) => join(dir, LOCK_FILE);

export function lockState(dir: string, here: Here = hereInfo()): LockState {
  return judge(read(lockPath(dir)), here);
}

export function describeHolder(h: LockHolder): string {
  return `canvas serve pid ${h.pid} on ${h.host} since ${h.startedAt}${h.urls[0] ? ` (${h.urls[0]})` : ''}`;
}

export class FolderLockedError extends Error {
  constructor(
    readonly dir: string,
    readonly holder: LockHolder,
  ) {
    super(`${dir} is served by ${describeHolder(holder)}; stop it, or delete ${lockPath(dir)} if it no longer runs`);
    this.name = 'FolderLockedError';
  }
}

export interface FolderLock {
  path: string;
  holder: LockHolder;
  /** Sync (it runs in an exit handler); only removes the file while it still has our token. */
  release(): void;
}

export function acquireFolderLock(dir: string, o: { port: number; urls: string[]; here?: Here }): FolderLock {
  const here = o.here ?? hereInfo();
  const path = lockPath(dir);
  const holder: LockHolder = { v: 1, app: 'canvas serve', pid: process.pid, machine: here.machine, host: here.host, bootAt: Math.round(here.bootAt), startedAt: new Date().toISOString(), port: o.port, urls: o.urls, token: randomBytes(12).toString('hex') };
  const take = () => {
    const fd = openSync(path, 'wx');
    try {
      writeSync(fd, JSON.stringify(holder, null, 2) + '\n');
    } finally {
      closeSync(fd);
    }
  };
  try {
    take();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const text = read(path);
    const state = judge(text, here);
    if (state.held) throw new FolderLockedError(dir, state.holder!);
    // Stale. Move it aside first (atomic: only one of two simultaneous starters gets it) and look at what we
    // moved: if it is not the text we judged, a live holder replaced it meanwhile, so put it back and refuse.
    const aside = `${path}.${holder.token}`;
    let moved: string | undefined;
    try {
      renameSync(path, aside);
      moved = read(aside);
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code !== 'ENOENT') throw e2;
    }
    if (moved !== undefined) {
      const was = judge(moved, here);
      if (moved !== text && was.held) {
        try {
          linkSync(aside, path);
        } catch {
          /* somebody took the name again: they are the holder now */
        }
        // Residual: a third starter that took the name between our rename and this link-back leaves two writers;
        // we drop our copy and report the holder we saw. Needs three starters within microseconds.
        unlinkSync(aside);
        throw new FolderLockedError(dir, was.holder!);
      }
      unlinkSync(aside);
    }
    try {
      take();
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2;
      const now = judge(read(path), here);
      if (now.holder) throw new FolderLockedError(dir, now.holder);
      throw e2;
    }
  }
  let released = false;
  return {
    path,
    holder,
    release() {
      if (released) return;
      released = true;
      try {
        if (parse(read(path) ?? '')?.token === holder.token) unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
  };
}

// Bridge markers: the other direction. A bridge writes boards in its folder too, so it leaves
// <folder>/.canvas-bridge/open-<pid>.json while it runs, and a serve that would take the folder refuses while one
// is alive. Same-machine only: a marker from another Mac is not judged (its pid means nothing here) and not removed.
const BRIDGE_STATE = '.canvas-bridge';
const bridgeMarker = (dir: string, pid: number) => join(dir, BRIDGE_STATE, `open-${pid}.json`);

export interface BridgeMark {
  pid: number;
  machine: string;
  bootAt: number;
  file: string;
  port: number;
}

/** Marks the folder as in use by this bridge. Returns the release (sync, for exit handlers). */
export function markBridge(dir: string, o: { file: string; port: number; here?: Here }): () => void {
  const here = o.here ?? hereInfo();
  const path = bridgeMarker(dir, process.pid);
  mkdirSync(join(dir, BRIDGE_STATE), { recursive: true });
  const mark: BridgeMark = { pid: process.pid, machine: here.machine, bootAt: Math.round(here.bootAt), file: o.file, port: o.port };
  writeFileSync(path, JSON.stringify(mark) + '\n');
  return () => {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
}

/** Bridges running on this machine with a board open in the folder. Markers of dead ones are removed. */
export function liveBridges(dir: string, here: Here = hereInfo()): BridgeMark[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, BRIDGE_STATE)).filter((n) => /^open-\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: BridgeMark[] = [];
  for (const n of names) {
    const path = join(dir, BRIDGE_STATE, n);
    let m: BridgeMark;
    try {
      m = JSON.parse(readFileSync(path, 'utf8')) as BridgeMark;
    } catch {
      continue;
    }
    if (!m || !Number.isInteger(m.pid) || typeof m.machine !== 'string') continue;
    const same = m.machine === here.machine || (here.machine === here.host && m.machine === here.host);
    if (!same) continue;
    if (m.pid === process.pid) continue;
    if (Math.abs(m.bootAt - here.bootAt) >= BOOT_SLACK_MS || !alive(m.pid)) {
      try {
        unlinkSync(path);
      } catch {
        /* gone */
      }
      continue;
    }
    out.push(m);
  }
  return out;
}

export const describeBridges = (dir: string, bs: BridgeMark[]) =>
  `${dir} has a bridge with a board open (${bs.map((b) => `pid ${b.pid}, ${b.file}`).join('; ')}); stop it first`;
