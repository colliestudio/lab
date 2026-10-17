import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'Collie Canvas';
export const BUNDLE_ID = 'studio.collie.canvas';
export const DEFAULT_BACKEND = 'http://mini.internal:5310';

/** The app's own state: settings, windows, logs. `CANVAS_USER_DATA` overrides (tests). */
export function userDataDir(home = homedir()): string {
  return process.env.CANVAS_USER_DATA ?? join(home, 'Library', 'Application Support', APP_NAME);
}
