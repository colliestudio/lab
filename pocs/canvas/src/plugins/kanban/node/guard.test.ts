import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Two promises as tests: the plugin keeps no way for a client to choose a folder (the File System Access
// code of the first prototype is gone), and its tests stay on scratch folders and free ports.

const root = join(__dirname, '..', '..', '..', '..');
const kanban = join(root, 'src', 'plugins', 'kanban');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const me = join(kanban, 'node', 'guard.test.ts');
const files = walk(kanban).filter((f) => /\.(ts|css)$/.test(f) && f !== me);
const tests = [...files.filter((f) => /\.test\.ts$/.test(f)), join(root, 'server', 'kanban.e2e.test.ts')];
const text = (f: string) => readFileSync(f, 'utf8');

describe('no client-chosen folder', () => {
  it('nothing in the plugin touches the File System Access API, a dev-server folder proxy or the Backlog.md web API', () => {
    for (const f of files.filter((f) => !/\.test\.ts$/.test(f))) expect(text(f), relative(root, f)).not.toMatch(/showDirectoryPicker|FileSystemDirectoryHandle|FileSystemFileHandle|__kanban|backlog-api|KANBAN_ROOT|BACKLOG_URL/);
  });

  it('the browser side imports nothing from node/', () => {
    for (const f of files.filter((f) => !f.includes('/node/') && !/\.test\.ts$/.test(f))) expect(text(f), relative(root, f)).not.toMatch(/from '\.\/node\/|from 'node:/);
  });
});

describe('test hygiene (C86)', () => {
  it('kanban tests use temp folders and free ports: no real backlog, no workspace path, no port of a real serve or bridge', () => {
    for (const f of tests) {
      const t = text(f);
      expect(t, relative(root, f)).not.toMatch(/cs-vault|ctrl-vault|workspaces\/|Collie Canvas|iCloud/);
      expect(t, relative(root, f)).not.toMatch(/\b(5310|5222|5231)\b/);
    }
  });
});
