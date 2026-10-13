// Dev loop: vite dev server for the web app (HMR in every window) + Electron on the bundled main.
//   pnpm dev [file.canvas…]      (main-process changes: Ctrl-C and run again; the bundle takes ~0.1 s)
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(here, '..');
const port = Number(process.env.CANVAS_DEV_PORT) || 5253;
execFileSync(process.execPath, [join(here, 'build.mjs'), '--no-web'], { stdio: 'inherit' });
const vite = spawn(join(root, 'node_modules/.bin/vite'), ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'inherit' });
const url = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    await fetch(url);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const electron = createRequire(import.meta.url)('electron');
const app = spawn(electron, [here, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, CANVAS_WEB_URL: url } });
const stop = () => (vite.kill(), app.kill());
app.on('exit', () => (vite.kill(), process.exit(0)));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
