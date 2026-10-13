import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Names and folders the app, its MCP shim and the tests agree on. No electron import: the shim
// (plain Node) uses this too.

export const APP_NAME = 'Collie Canvas';
export const BUNDLE_ID = 'studio.collie.canvas';

/** The app's own state: logs, recents, endpoint.json, Yjs sidecars. `CANVAS_USER_DATA` overrides (tests, demos). */
export function userDataDir(home = homedir()): string {
  return process.env.CANVAS_USER_DATA ?? join(home, 'Library', 'Application Support', APP_NAME);
}

const ICLOUD_DRIVE = ['Library', 'Mobile Documents', 'com~apple~CloudDocs'];

/**
 * Where boards live by default: a "Collie Canvas" folder in iCloud Drive (created on first use),
 * else ~/Collie Canvas when iCloud Drive isn't set up on this Mac.
 */
export function boardsDir(home = homedir(), create = true): string {
  const drive = join(home, ...ICLOUD_DRIVE);
  const dir = existsSync(drive) ? join(drive, APP_NAME) : join(home, APP_NAME);
  if (create) mkdirSync(dir, { recursive: true });
  return dir;
}

/** `.board.canvas.icloud` is the stub iCloud leaves for an evicted file; the real name is `board.canvas`. */
export function realPath(file: string): string {
  const m = /^(.*\/)\.([^/]+)\.icloud$/.exec(file);
  return m ? m[1] + m[2] : file;
}

export const isBoardFile = (f: string) => realPath(f).endsWith('.canvas');
