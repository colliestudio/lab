import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Server } from 'node:net';
import { join } from 'node:path';
import { nameHash, popoutId } from './logic';

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
  /** How many times the instance was asked to come to the front. */
  focused?: number;
  icon?: { letter: string; hue: number };
}

export type Message = { cmd: string; canvas?: string; forget?: boolean };
export type Reply = { ok: boolean; [k: string]: unknown };

/** Sockets live outside the data folder, whose path may be too long. One folder per main data folder. */
export const socketDir = (mainData: string, uid = process.getuid?.() ?? 0) => join('/tmp', `collie-canvas-${uid}-${nameHash(mainData)}`);
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
  mkdirSync(join(sock, '..'), { recursive: true, mode: 0o700 });
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
          r = await handle(JSON.parse(line));
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
    return typeof j?.canvas === 'string' && j.canvas && Number.isInteger(j.pid) ? { ...j, keep: j.keep !== false } : null;
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
