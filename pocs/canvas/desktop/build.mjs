// Build the desktop app: the main process and the preload (esbuild, bundled: the packaged app has no
// node_modules) and the app's own page. The board UI is not part of the app: it comes from the backend.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const common = { bundle: true, platform: 'node', target: 'node24', sourcemap: 'linked', logLevel: 'warning', format: 'cjs', external: ['electron'] };
await build({ ...common, entryPoints: [join(here, 'src/main.ts')], outfile: join(here, 'build/main.cjs') });
await build({ ...common, entryPoints: [join(here, 'src/preload.ts')], outfile: join(here, 'build/preload.cjs') });
mkdirSync(join(here, 'build'), { recursive: true });
copyFileSync(join(here, 'ui/ui.html'), join(here, 'build/ui.html'));
console.log(`built in ${Date.now() - t0} ms`);
