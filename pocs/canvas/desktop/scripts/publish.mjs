// Build the unsigned arm64 app, zip it and publish it where the Mac Mini serves static files, so
// the MacBook can install it with one command (scripts/install.sh):
//   pnpm --dir desktop publish-app [--out <dir>] [--base-url <url>] [--keep N]
// Writes into <out> ($COLLIE_APPS_DIR when --out is not given; on the Mini the folder served at
// http://mini.internal:5412/apps/):
//   collie-canvas-<yyyymmdd-hhmm>-<sha>.zip   one per publish (the newest --keep, default 5, stay)
//   collie-canvas-latest.zip                  copy of the newest
//   latest.json                               version, build, sha, branch, date, file, size, sha256
//   install.sh                                the MacBook side
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const out = arg('out', process.env.COLLIE_APPS_DIR);
if (!out) throw new Error('say where to publish: --out <dir> or COLLIE_APPS_DIR (the folder served at the apps URL)');
const baseUrl = arg('base-url', process.env.COLLIE_APPS_URL ?? 'http://mini.internal:5412/apps').replace(/\/+$/, '');
const keep = Number(arg('keep', 5));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();

const git = (...a) => run('git', ['-C', here, ...a]);
const sha = git('rev-parse', '--short=7', 'HEAD');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
const version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;
const buildSha = dirty ? `${sha}-dirty` : sha;
if (dirty) console.warn('warning: uncommitted changes in the worktree; the build is marked dirty');

console.log(`building ${version} (${day}.${time}, ${buildSha}, ${branch})`);
execFileSync(process.execPath, [join(here, 'build.mjs')], { stdio: 'inherit' });
const builder = join(here, 'node_modules/.bin/electron-builder');
const dist = join(here, 'dist');
rmSync(join(dist, 'mac-arm64'), { recursive: true, force: true });
execFileSync(builder, ['--dir', '--mac', '--arm64', `-c.mac.bundleVersion=${day}.${time}`, `-c.mac.extendInfo.CollieCanvasBuild=${buildSha}`], { cwd: here, stdio: 'inherit' });

const app = join(dist, 'mac-arm64', 'Collie Canvas.app');
if (!existsSync(app)) throw new Error(`no app at ${app}`);
// electron-builder leaves Electron's linker-signed binary with an Info.plist it no longer matches;
// a fresh ad-hoc signature makes the bundle verify (still unsigned for Gatekeeper: install.sh clears quarantine)
run('codesign', ['--force', '--deep', '--sign', '-', app]);
run('codesign', ['--verify', '--deep', '--strict', app]);

mkdirSync(out, { recursive: true });
const file = `collie-canvas-${day}-${time}-${buildSha}.zip`;
const zip = join(out, file);
run('ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', app, zip]);
const bytes = statSync(zip).size;
const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
copyFileSync(zip, join(out, 'collie-canvas-latest.zip'), constants.COPYFILE_FICLONE);
copyFileSync(join(here, 'scripts/install.sh'), join(out, 'install.sh'));
const meta = { name: 'Collie Canvas', bundleId: 'studio.collie.canvas', version, build: `${day}.${time}`, sha: buildSha, branch, date: now.toISOString(), file, url: `${baseUrl}/${file}`, bytes, sha256 };
writeFileSync(join(out, 'latest.json'), JSON.stringify(meta, null, 2) + '\n');

const old = readdirSync(out)
  .filter((f) => /^collie-canvas-\d{8}-\d{4}-.+\.zip$/.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) rmSync(join(out, f));

console.log(`\npublished ${file} (${(bytes / 1e6).toFixed(0)} MB) to ${out}${old.length ? `; removed ${old.length} older` : ''}`);
console.log(`install on the MacBook:\n  curl -fsSL ${baseUrl}/install.sh | sh`);
