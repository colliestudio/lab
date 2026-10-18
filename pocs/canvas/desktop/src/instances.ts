import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, connect, type Server } from 'node:net';
import { join } from 'node:path';
import { nameHash, popoutId, type Bounds } from './logic';

// How the app's processes find each other. The main app and each pop-out are separate Electron
// processes. Each listens on a unix socket (short paths: macOS allows 104 bytes); a pop-out also
// keeps an `instance.json` in its own folder under <main data>/popouts/.

export interface InstanceInfo {
  canvas: string;
  pid: number;
  /** Brought back by the main app on its next launch: false once the user closed the window. */
  keep: boolean;
  title?: string;
  url?: string;
  /** Times the main app restarted it without it showing a window since (a pop-out that dies on start is given up on). */
  starts?: number;
  /** How many times the instance was asked to come to the front. */
  focused?: number;
  icon?: { letter: string; hue: number };
  bounds?: Bounds;
  /** Where it listens (also lets a test or a script reach it). */
  sock?: string;
}

export type Message = { cmd: string; canvas?: string; forget?: boolean };

/** A message from the wire: a command, and a canvas that is a string when there is one. */
export const validMessage = (m: any): m is Message => !!m && typeof m === 'object' && typeof m.cmd === 'string' && (m.canvas === undefined || typeof m.canvas === 'string');

/** Create the socket folder private to this user, or refuse one somebody else owns. */
function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error(`${dir} is not this user's folder`);
  if (st.mode & 0o077) chmodSync(dir, 0o700);
}

/** What the main app does with a kept pop-out that is not running: start it again, unless it has died on start twice already. */
export const MAX_RESTARTS = 2;
export const nextRestore = (i: Pick<InstanceInfo, 'keep' | 'starts'>): { launch: boolean; starts: number } =>
  i.keep && (i.starts ?? 0) < MAX_RESTARTS ? { launch: true, starts: (i.starts ?? 0) + 1 } : { launch: false, starts: i.starts ?? 0 };
export type Reply = { ok: boolean; [k: string]: unknown };

/** Sockets live outside the data folder, whose path may be too long: in the per-user temp folder (macOS: /var/folders/.., not shared), one folder per main data folder. */
export const socketDir = (mainData: string) => join(tmpdir(), `collie-canvas-${nameHash(mainData)}`);
export const mainSocket = (mainData: string) => join(socketDir(mainData), 'main.sock');
export const popoutSocket = (mainData: string, canvas: string) => join(socketDir(mainData), `${nameHash(canvas)}.sock`);
export const popoutsDir = (mainData: string) => join(mainData, 'popouts');
export const popoutDir = (mainData: string, canvas: string) => join(popoutsDir(mainData), popoutId(canvas));

/** Send one message, wait for the reply. null when nobody answers (nothing listens, or a stale socket). */
export function send(sock: string, msg: Message, timeoutMs = 1500): Promise<Reply | null> {
  return new Promise((resolve) => {
    let buf = '';
    const c = connect(sock);
    const done = (r: Reply | null) => {
      clearTimeout(t);
      c.destroy();
      resolve(r);
    };
    const t = setTimeout(() => done(null), timeoutMs);
    c.on('error', () => done(null));
    c.on('connect', () => c.write(JSON.stringify(msg) + '\n'));
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try {
        done(JSON.parse(buf.slice(0, i)));
      } catch {
        done(null);
      }
    });
  });
}

/** Answer messages on `sock` (a leftover file of a dead process is replaced). */
export async function listen(sock: string, handle: (m: Message) => Reply | Promise<Reply>): Promise<Server> {
  privateDir(join(sock, '..'));
  if (await send(sock, { cmd: 'ping' }, 500)) throw new Error(`another process answers on ${sock}`);
  try {
    unlinkSync(sock);
  } catch {}
  const server = createServer((c) => {
    let buf = '';
    c.on('error', () => {});
    c.on('data', async (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let r: Reply;
        try {
          const m = JSON.parse(line);
          r = validMessage(m) ? await handle(m) : { ok: false, error: 'bad message' };
        } catch (e) {
          r = { ok: false, error: (e as Error).message };
        }
        c.write(JSON.stringify(r) + '\n');
      }
    });
  });
  await new Promise<void>((res, rej) => (server.once('error', rej), server.listen(sock, res)));
  return server;
}

// ---------------------------------------------------------------- the registry (instance.json files)

export function writeInstance(mainData: string, info: InstanceInfo) {
  const dir = popoutDir(mainData, info.canvas);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'instance.json.tmp'), JSON.stringify(info, null, 2) + '\n');
  renameSync(join(dir, 'instance.json.tmp'), join(dir, 'instance.json'));
}

export function readInstance(mainData: string, canvas: string): InstanceInfo | null {
  return parse(join(popoutDir(mainData, canvas), 'instance.json'));
}

function parse(file: string): InstanceInfo | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return typeof j?.canvas === 'string' && j.canvas && Number.isInteger(j.pid) && j.pid > 0 ? { ...j, keep: j.keep !== false } : null;
  } catch {
    return null;
  }
}

export function listInstances(mainData: string): InstanceInfo[] {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(popoutsDir(mainData));
  } catch {}
  return dirs.flatMap((d) => parse(join(popoutsDir(mainData), d, 'instance.json')) ?? []);
}

/** Cheap check that a process is there (no signal sent). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false; // kill(0 or -n) would address a whole process group
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pop-out of `canvas` that answers on its socket, or null (none, or a stale file). */
export async function livePopout(mainData: string, canvas: string): Promise<InstanceInfo | null> {
  const info = readInstance(mainData, canvas);
  if (!info || !pidAlive(info.pid)) return null;
  return (await send(popoutSocket(mainData, canvas), { cmd: 'ping' })) ? info : null;
}

/** All pop-outs that are running now. */
export async function livePopouts(mainData: string): Promise<InstanceInfo[]> {
  return (await Promise.all(listInstances(mainData).map((i) => livePopout(mainData, i.canvas)))).filter((x): x is InstanceInfo => !!x);
}
