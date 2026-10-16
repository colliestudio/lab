import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// scripts/serve-service.sh against a fake repo, scratch dirs and a launchctl stub that logs its arguments.
// Nothing here touches launchd, the real repo's tags or the real data folder.

const script = join(__dirname, 'serve-service.sh');
const LABEL = 'studio.collie.canvas-serve-test';
const PREFIX = 't339test-';
const uid = String(process.getuid!());

let root: string;
let repo: string;
let env: Record<string, string>;
const p = (...s: string[]) => join(root, ...s);
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const sh = (...a: string[]) => spawnSync('bash', [script, ...a], { env: { ...process.env, ...env }, encoding: 'utf8' });
const calls = () => (existsSync(p('launchctl.log')) ? readFileSync(p('launchctl.log'), 'utf8').trim().split('\n').filter(Boolean) : []);
const clear = () => writeFileSync(p('launchctl.log'), '');
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const tags = () => git('tag', '-l', `${PREFIX}*`).split('\n').filter(Boolean);
const target = () => readlinkSync(p('home', 'current'));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 't339-script-'));
  repo = p('repo');
  mkdirSync(join(repo, 'server'), { recursive: true });
  writeFileSync(join(repo, 'server', 'serve.ts'), '// stub\n');
  execFileSync('git', ['init', '-q', '-b', 'poc', repo]);
  git('add', '-A');
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one']);
  mkdirSync(p('Collie Canvas & <x>'));
  // loaded state lives in a file: bootstrap sets it, bootout clears it, `print` succeeds while it is set
  writeFileSync(
    p('launchctl'),
    `#!/bin/sh\necho "$@" >> "${p('launchctl.log')}"\ncase "$1" in\n  bootstrap) touch "${p('loaded')}";;\n  bootout) rm -f "${p('loaded')}";;\n  print) [ -f "${p('loaded')}" ] || exit 1;;\nesac\nexit 0\n`,
  );
  chmodSync(p('launchctl'), 0o755);
  env = {
    CANVAS_SERVE_REPO: repo,
    CANVAS_SERVE_REF: 'poc',
    CANVAS_SERVE_TAG_PREFIX: PREFIX,
    CANVAS_SERVE_HOME: p('home'),
    CANVAS_SERVE_LABEL: LABEL,
    CANVAS_SERVE_DATA: p('Collie Canvas & <x>'),
    CANVAS_SERVE_PORT: '5299',
    CANVAS_SERVE_AGENTS: p('agents'),
    CANVAS_SERVE_LOGS: p('logs'),
    CANVAS_SERVE_LAUNCHCTL: p('launchctl'),
    CANVAS_SERVE_BUILD: 'mkdir -p dist && echo ok > dist/built',
    CANVAS_SERVE_NODE: '/usr/bin/true',
    CANVAS_SERVE_WAIT: '0',
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('serve-service.sh', () => {
  it('release: tags the repo, builds in the release dir, points current at it, writes the plist and bootstraps', () => {
    const r = sh('release');
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const tag = `${PREFIX}${today()}-1`;
    expect(tags()).toEqual([tag]);
    expect(readFileSync(p('home', 'releases', tag, 'dist', 'built'), 'utf8')).toBe('ok\n');
    expect(readFileSync(p('home', 'releases', tag, 'RELEASE'), 'utf8')).toContain(`sha=${git('rev-parse', tag)}`);
    expect(existsSync(p('home', 'releases', tag, 'server', 'serve.ts'))).toBe(true);
    expect(target()).toBe(`releases/${tag}`);
    const plist = readFileSync(p('agents', `${LABEL}.plist`), 'utf8');
    for (const want of [`<string>${LABEL}</string>`, '<string>/usr/bin/true</string>', '<string>server/serve.ts</string>', `<string>${p('Collie Canvas &amp; &lt;x&gt;')}</string>`, '<string>--port</string>', '<string>5299</string>', '<string>--host-name</string>', '<string>mini.internal</string>', `<key>WorkingDirectory</key><string>${p('home', 'current')}</string>`, '<key>KeepAlive</key><true/>', '<key>RunAtLoad</key><true/>', p('logs', 'serve.log')]) {
      expect(plist).toContain(want);
    }
    if (process.platform === 'darwin') expect(spawnSync('plutil', ['-lint', p('agents', `${LABEL}.plist`)]).status).toBe(0);
    expect(calls()).toEqual([`print gui/${uid}/${LABEL}`, `bootstrap gui/${uid} ${p('agents', `${LABEL}.plist`)}`]);
  });

  it('a second release the same day is -2: current flips, the service is kickstarted, release 1 stays', () => {
    writeFileSync(join(repo, 'two'), '2');
    git('add', '-A');
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'two']);
    clear();
    const r = sh('release');
    expect(r.status, r.stderr).toBe(0);
    expect(target()).toBe(`releases/${PREFIX}${today()}-2`);
    expect(readdirSync(p('home', 'releases')).sort()).toEqual([`${PREFIX}${today()}-1`, `${PREFIX}${today()}-2`]);
    expect(calls()).toContain(`kickstart -k gui/${uid}/${LABEL}`);
    expect(calls().some((c) => c.startsWith('bootstrap'))).toBe(false);
    expect(existsSync(p('home', 'releases', `${PREFIX}${today()}-2`, 'two'))).toBe(true);
  });

  it('rollback goes to the release before current, or to a named one; an unknown tag changes nothing', () => {
    clear();
    expect(sh('rollback').status).toBe(0);
    expect(target()).toBe(`releases/${PREFIX}${today()}-1`);
    expect(calls()).toContain(`kickstart -k gui/${uid}/${LABEL}`);
    clear();
    expect(sh('rollback', `${PREFIX}${today()}-2`).status).toBe(0);
    expect(target()).toBe(`releases/${PREFIX}${today()}-2`);
    clear();
    const bad = sh('rollback', 'nope');
    expect(bad.status).not.toBe(0);
    expect(target()).toBe(`releases/${PREFIX}${today()}-2`);
    expect(calls()).toEqual([]);
  });

  it('a changed plist (another node) is bootout + bootstrap, not a kickstart', () => {
    clear();
    env.CANVAS_SERVE_NODE = '/usr/bin/false';
    expect(sh('install').status).toBe(0);
    env.CANVAS_SERVE_NODE = '/usr/bin/true';
    expect(calls().map((c) => c.split(' ')[0])).toEqual(['print', 'bootout', 'print', 'bootstrap']);
    expect(readFileSync(p('agents', `${LABEL}.plist`), 'utf8')).toContain('/usr/bin/false');
  });

  it('a failing build leaves no release dir, removes its tag, keeps current and calls nothing', () => {
    clear();
    const before = tags();
    const cur = target();
    const r = spawnSync('bash', [script, 'release'], { env: { ...process.env, ...env, CANVAS_SERVE_BUILD: 'echo broken >&2; exit 3' }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('build failed');
    expect(tags()).toEqual(before);
    expect(readdirSync(p('home', 'releases'))).toHaveLength(2);
    expect(target()).toBe(cur);
    expect(calls()).toEqual([]);
  });

  it('a missing data folder is refused before anything is tagged', () => {
    const before = tags();
    const r = spawnSync('bash', [script, 'release'], { env: { ...process.env, ...env, CANVAS_SERVE_DATA: p('no-such-folder') }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('mkdir -p');
    expect(tags()).toEqual(before);
  });

  it('uninstall boots the job out and removes the plist; releases stay', () => {
    clear();
    expect(sh('uninstall').status).toBe(0);
    expect(calls()).toContain(`bootout gui/${uid}/${LABEL}`);
    expect(existsSync(p('agents', `${LABEL}.plist`))).toBe(false);
    expect(readdirSync(p('home', 'releases'))).toHaveLength(2);
  });

  it('never reuses a release number whose dir exists, even when its tag is gone; a failed build leaves that dir alone', () => {
    const first = `${PREFIX}${today()}-1`;
    git('tag', '-d', first);
    writeFileSync(p('home', 'releases', first, 'marker'), 'mine');
    const cur = target();
    const bad = spawnSync('bash', [script, 'release'], { env: { ...process.env, ...env, CANVAS_SERVE_BUILD: 'exit 3' }, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(readFileSync(p('home', 'releases', first, 'marker'), 'utf8')).toBe('mine');
    expect(existsSync(p('home', 'releases', first, 'RELEASE'))).toBe(true);
    expect(target()).toBe(cur);
    expect(tags()).not.toContain(first);
    git('tag', first, 'poc'); // put the tag back for the rest
  });

  it('a partial CANVAS_SERVE_* override is refused before anything happens', () => {
    clear();
    const { CANVAS_SERVE_LABEL: _l, CANVAS_SERVE_AGENTS: _a, ...partial } = env;
    const r = spawnSync('bash', [script, 'release'], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...partial }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CANVAS_SERVE_LABEL');
    expect(calls()).toEqual([]);
  });

  it('a release that does not answer is rolled back automatically (exit 1), and kept for inspection', () => {
    expect(sh('install').status).toBe(0);
    clear();
    const before = target();
    const r = spawnSync('bash', [script, 'release'], { env: { ...process.env, ...env, CANVAS_SERVE_WAIT: '1' }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('did not answer');
    expect(target()).toBe(before);
    expect(calls().filter((c) => c.startsWith('kickstart')).length).toBe(2); // new release, then back
    expect(readdirSync(p('home', 'releases')).length).toBe(3);
  });

  it('status survives a dangling current', () => {
    const cur = target();
    execFileSync('ln', ['-sfn', 'releases/nope', p('home', 'current')]);
    const r = sh('status');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('missing release');
    execFileSync('ln', ['-sfn', cur, p('home', 'current')]);
  });
});
