// Build the canvas-service sidecar as one self-contained executable for Tauri's externalBin.
//   node desktop/build-sidecar.mjs [--runtime node|bun]
// node (default): esbuild → one CJS file → Node single executable application (SEA): copy of the
//   node binary + injected blob (postject), ad-hoc re-signed. Same runtime as dev (tsx).
// bun: `bun build --compile` (smaller runtime, different engine: JSC instead of V8).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'build');
const triple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
const target = join(here, 'src-tauri/binaries', `canvas-service-${triple}`);
const runtime = process.argv.includes('--runtime') ? process.argv[process.argv.indexOf('--runtime') + 1] : 'node';
mkdirSync(out, { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const mb = (p) => `${(statSync(p).size / 1e6).toFixed(1)} MB`;

const t0 = Date.now();
await build({
  entryPoints: [join(here, 'service/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(out, 'service.cjs'),
  minify: true,
  legalComments: 'none',
  // ws probes optional native addons (bufferutil, utf-8-validate); a SEA can't load them and warns
  banner: { js: 'process.env.WS_NO_BUFFER_UTIL="1";process.env.WS_NO_UTF_8_VALIDATE="1";' },
  logLevel: 'warning',
});
console.log(`bundle: ${mb(join(out, 'service.cjs'))} in ${Date.now() - t0} ms`);

if (runtime === 'bun') {
  run('bun', ['build', '--compile', '--minify', join(out, 'service.cjs'), '--outfile', target]);
} else {
  const blob = join(out, 'sea-prep.blob');
  writeFileSync(join(out, 'sea-config.json'), JSON.stringify({ main: join(out, 'service.cjs'), output: blob, disableExperimentalSEAWarning: true, useCodeCache: true }));
  run(process.execPath, ['--experimental-sea-config', join(out, 'sea-config.json')]);
  copyFileSync(process.execPath, target);
  chmodSync(target, 0o755);
  run('codesign', ['--remove-signature', target]);
  run(join(here, '../node_modules/.bin/postject'), [target, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--macho-segment-name', 'NODE_SEA']);
  run('codesign', ['--sign', '-', target]);
}
console.log(`sidecar (${runtime}): ${target} ${mb(target)} total ${Date.now() - t0} ms`);
