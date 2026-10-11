// Build the desktop app: the web app (vite, from the repo root) into build/web, the main process and
// the MCP shim (esbuild, everything bundled: the packaged app has no node_modules).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const t0 = Date.now();
if (!process.argv.includes('--no-web')) {
  execFileSync(join(root, 'node_modules/.bin/vite'), ['build', '--outDir', join(here, 'build/web'), '--emptyOutDir', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
}
const t1 = Date.now();
const common = { bundle: true, platform: 'node', target: 'node24', sourcemap: 'linked', logLevel: 'warning', external: ['electron', 'bufferutil', 'utf-8-validate'] };
await build({ ...common, entryPoints: [join(here, 'src/main.ts')], outfile: join(here, 'build/main.cjs'), format: 'cjs' });
await build({ ...common, entryPoints: [join(here, 'src/shim.ts')], outfile: join(here, 'build/shim.mjs'), format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
console.log(`built: web ${t1 - t0} ms, main + shim ${Date.now() - t1} ms`);
