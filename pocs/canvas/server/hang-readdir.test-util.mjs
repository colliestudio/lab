// Preload for a test serve (node --import): every readdir hangs for ever, the way macOS holds a process
// that has no Full Disk Access in a read of iCloud Drive. A file named by CANVAS_TEST_UNHANG, once it exists, lets reads through again.
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const real = fsp.readdir;
fsp.readdir = (...a) => (process.env.CANVAS_TEST_UNHANG && existsSync(process.env.CANVAS_TEST_UNHANG) ? real(...a) : new Promise(() => {}));
syncBuiltinESMExports();
