import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_CONFIG } from '../fixtures';
import { newTaskFile, parseTask } from '../markdown';
import { SourceError } from '../source';
import { sourceContract } from '../source.contract';
import { BacklogMdSource } from './backlogMd';

const NOW = new Date(Date.UTC(2026, 9, 16, 12, 0));
const dirs: string[] = [];
const sources: BacklogMdSource[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  sources.length = 0;
});

function task(id: string, title: string, over: Partial<Parameters<typeof newTaskFile>[1]> = {}) {
  return newTaskFile(id, { title, status: 'To Do', ...over }, new Date(Date.UTC(2026, 9, 1)));
}
function project(files: Record<string, string> = {}, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kb-src-'));
  dirs.push(root);
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'archive', 'tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'completed'), { recursive: true });
  writeFileSync(join(root, 'backlog.config.yml'), CLI_CONFIG);
  for (const [n, t] of Object.entries(files)) writeFileSync(join(root, 'backlog', n.includes('/') ? '' : 'tasks', n), t);
  for (const [n, t] of Object.entries(extra)) writeFileSync(join(root, n), t);
  const src = new BacklogMdSource(root, { pollMs: 100, debounceMs: 30 });
  sources.push(src);
  return { root, tasks: join(root, 'backlog', 'tasks'), src };
}
const names = (dir: string) => readdirSync(dir).sort();

sourceContract('BacklogMdSource', async () => {
  const p = project({
    'task-1 - First.md': task('TASK-1', 'First', { labels: ['x'], description: 'about first', ac: [{ text: 'one', done: false }, { text: 'two', done: false }], ordinal: 1000 }),
    'task-2 - Second.md': task('TASK-2', 'Second', { ordinal: 2000 }),
  });
  return {
    source: p.src,
    ids: { a: 'TASK-1', b: 'TASK-2' },
    outsideEdit: async (id) => {
      const f = join(p.tasks, readdirSync(p.tasks).find((n) => n.toLowerCase().startsWith(id.toLowerCase()))!);
      writeFileSync(f, readFileSync(f, 'utf8').replace(/^title: .*$/m, `title: edited ${Math.random().toString(36).slice(2)}`));
    },
    cleanup: () => {},
  };
});

describe('BacklogMdSource: reading', () => {
  it('columns come from the config statuses in order; cards from tasks/ only (archive and completed never)', async () => {
    const p = project({
      'task-1 - A.md': task('TASK-1', 'A'),
      'task-2 - B.md': task('TASK-2', 'B', { status: 'Done' }),
      'archive/tasks/task-7 - Old.md': task('TASK-7', 'Old'),
      'completed/task-8 - Done.md': task('TASK-8', 'Done long ago', { status: 'Done' }),
    });
    const { info, cards } = await p.src.list();
    expect(info).toMatchObject({ name: 'demo', columns: ['To Do', 'In Progress', 'Done'], defaultColumn: 'To Do', doneColumn: 'Done', labels: ['demo', 'ui', 'canvas'] });
    expect(cards.map((c) => c.id).sort()).toEqual(['TASK-1', 'TASK-2']);
  });

  it('works on a backlog folder as well as a project root, and honors backlog_directory', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A') });
    writeFileSync(join(p.root, 'backlog', 'config.yml'), CLI_CONFIG.replace('"demo"', '"folder form"'));
    const folderOnly = new BacklogMdSource(join(p.root, 'backlog'));
    const l = await folderOnly.list();
    expect(l.info.name).toBe('folder form');
    expect(l.cards.map((c) => c.id)).toEqual(['TASK-1']);
    // backlog_directory moves the folder inside the project
    const root = mkdtempSync(join(tmpdir(), 'kb-src-'));
    dirs.push(root);
    mkdirSync(join(root, 'docs', 'board', 'tasks'), { recursive: true });
    writeFileSync(join(root, 'backlog.config.yml'), CLI_CONFIG.replace('backlog_directory: "backlog"', 'backlog_directory: "docs/board"'));
    writeFileSync(join(root, 'docs', 'board', 'tasks', 'task-4 - Deep.md'), task('TASK-4', 'Deep'));
    expect((await new BacklogMdSource(root).list()).cards.map((c) => c.id)).toEqual(['TASK-4']);
  });

  it('an odd path is refused at construction', () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-src-'));
    dirs.push(root);
    expect(() => new BacklogMdSource(root)).toThrow();
    expect(() => new BacklogMdSource(join(root, 'nope'))).toThrow();
    writeFileSync(join(root, 'backlog.config.yml'), 'project_name: x\nbacklog_directory: "../outside"\n');
    expect(() => new BacklogMdSource(root)).toThrow(/leaves the project folder/);
  });

  it('keeps the last good card while a file does not parse, and takes the next good one (C37)', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A') });
    const f = join(p.tasks, 'task-1 - A.md');
    await p.src.list();
    writeFileSync(f, '---\nid: TASK-1\ntitle: hal');
    expect((await p.src.list()).cards.map((c) => c.title)).toEqual(['A']);
    writeFileSync(f, '');
    expect((await p.src.list()).cards.map((c) => c.title)).toEqual(['A']);
    writeFileSync(f, task('TASK-1', 'Fixed'));
    expect((await p.src.list()).cards.map((c) => c.title)).toEqual(['Fixed']);
  });

  it('a task file that is a symlink is not a card; stray files are ignored', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A'), 'notes.txt': 'x', '.hidden.md': task('TASK-3', 'H') });
    writeFileSync(join(p.root, 'outside.md'), task('TASK-9', 'Outside'));
    symlinkSync(join(p.root, 'outside.md'), join(p.tasks, 'task-9 - Outside.md'));
    expect((await p.src.list()).cards.map((c) => c.id)).toEqual(['TASK-1']);
    expect(await p.src.read('TASK-9')).toBeNull();
  });

  it('a config change shows in the columns', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A') });
    expect((await p.src.list()).info.columns).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(p.root, 'backlog.config.yml'), CLI_CONFIG.replace('["To Do", "In Progress", "Done"]', '["Todo", "Doing", "Review", "Shipped"]'));
    const { info } = await p.src.list();
    expect(info.columns).toEqual(['Todo', 'Doing', 'Review', 'Shipped']);
    expect(info.doneColumn).toBe('Shipped');
  });
});

describe('BacklogMdSource: writing', () => {
  it('a status write changes the status line and updated_date, nothing else (C13)', async () => {
    const before = task('TASK-1', 'A', { ordinal: 1000, description: 'd' });
    const p = project({ 'task-1 - A.md': before });
    const card = await p.src.write('TASK-1', { column: 'In Progress' }, { now: NOW });
    expect(card.column).toBe('In Progress');
    const after = readFileSync(join(p.tasks, 'task-1 - A.md'), 'utf8');
    const b = before.split('\n');
    expect(after.split('\n').filter((l) => !b.includes(l))).toEqual(['status: In Progress', "updated_date: '2026-10-16 12:00'"]);
    expect(names(p.tasks)).toEqual(['task-1 - A.md']); // no temp file left
  });

  it('a title edit does not rename the file (like the CLI)', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A') });
    await p.src.write('TASK-1', { title: 'Totally different' }, { now: NOW });
    expect(names(p.tasks)).toEqual(['task-1 - A.md']);
    expect(parseTask(readFileSync(join(p.tasks, 'task-1 - A.md'), 'utf8'))!.title).toBe('Totally different');
  });

  it('a read-only file fails with a notice, writes nothing and leaves no temp file (C21)', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A'), 'task-2 - B.md': task('TASK-2', 'B') });
    const f = join(p.tasks, 'task-1 - A.md');
    const before = readFileSync(f, 'utf8');
    chmodSync(f, 0o444);
    const e = await p.src.write('TASK-1', { column: 'Done' }, { now: NOW }).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect((e as SourceError).message).toMatch(/TASK-1.*read-only/);
    expect((e as SourceError).message).not.toContain(p.root);
    expect(readFileSync(f, 'utf8')).toBe(before);
    expect(names(p.tasks).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    // the other task still works
    expect((await p.src.write('TASK-2', { column: 'Done' }, { now: NOW })).column).toBe('Done');
    chmodSync(f, 0o644);
  });

  it('a vanished folder fails clearly', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A') });
    await p.src.list();
    rmSync(p.tasks, { recursive: true });
    await expect(p.src.write('TASK-1', { column: 'Done' }, { now: NOW })).rejects.toThrow(/tasks folder is missing/);
    await expect(p.src.list()).rejects.toThrow(/tasks folder is missing/);
  });

  it('concurrent writes all land: two tasks, and two fields of one task (C23)', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A'), 'task-2 - B.md': task('TASK-2', 'B') });
    await Promise.all([
      p.src.write('TASK-1', { column: 'Done' }, { now: NOW }),
      p.src.write('TASK-2', { column: 'In Progress' }, { now: NOW }),
      p.src.write('TASK-1', { labels: ['canvas'] }, { now: NOW }),
      p.src.write('TASK-1', { sections: { plan: 'p' } }, { now: NOW }),
      p.src.write('TASK-1', { comment: { author: '@a', text: 'c' } }, { now: NOW }),
    ]);
    const { cards } = await p.src.list();
    expect(cards.find((c) => c.id === 'TASK-1')).toMatchObject({ column: 'Done', labels: ['canvas'], sections: { plan: 'p' } });
    expect(cards.find((c) => c.id === 'TASK-1')!.comments).toHaveLength(1);
    expect(cards.find((c) => c.id === 'TASK-2')!.column).toBe('In Progress');
  });
});

describe('BacklogMdSource: creating (C16)', () => {
  it('names the file like the CLI, takes the next id past archive and completed, puts it last', async () => {
    const p = project({
      'task-1 - A.md': task('TASK-1', 'A', { ordinal: 1000 }),
      'archive/tasks/task-7 - Old.md': task('TASK-7', 'Old'),
      'completed/task-9 - Gone.md': task('TASK-9', 'Gone'),
    });
    expect(await p.src.nextId()).toBe('TASK-10');
    const c = await p.src.create({ title: "Fix: it's [x]", column: 'In Progress', labels: ['canvas'], preferId: 'TASK-10' }, { now: NOW });
    expect(c.id).toBe('TASK-10');
    expect(names(p.tasks)).toContain('task-10 - Fix-its-x.md');
    expect(parseTask(readFileSync(join(p.tasks, 'task-10 - Fix-its-x.md'), 'utf8'))).toMatchObject({ taskId: 'TASK-10', title: "Fix: it's [x]", status: 'In Progress', labels: ['canvas'], ordinal: 2000 });
  });

  it('a subtask of TASK-1 is TASK-1.1 and records its parent', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A') });
    const c = await p.src.create({ title: 'Sub', column: 'To Do', parent: 'TASK-1' }, { now: NOW });
    expect(c).toMatchObject({ id: 'TASK-1.1', parent: 'TASK-1' });
    expect(names(p.tasks)).toContain('task-1.1 - Sub.md');
    await expect(p.src.create({ title: 'Orphan', column: 'To Do', parent: 'TASK-77' }, { now: NOW })).rejects.toThrow(/no parent/);
  });

  it('never overwrites: an id taken meanwhile (the CLI created it) gives the next one', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A') });
    const a = await p.src.create({ title: 'Same', column: 'To Do', preferId: 'TASK-2' }, { now: NOW });
    const b = await p.src.create({ title: 'Same', column: 'To Do', preferId: 'TASK-2' }, { now: NOW });
    expect([a.id, b.id]).toEqual(['TASK-2', 'TASK-3']);
    expect(names(p.tasks)).toEqual(['task-1 - A.md', 'task-2 - Same.md', 'task-3 - Same.md']);
    // a file with that very name appears between the id pick and the write: link() refuses, the next id is used
    writeFileSync(join(p.tasks, 'task-4 - Racer.md'), task('TASK-4', 'Racer'));
    const c = await p.src.create({ title: 'Racer', column: 'To Do', preferId: 'TASK-4' }, { now: NOW });
    expect(c.id).toBe('TASK-5');
    expect(parseTask(readFileSync(join(p.tasks, 'task-4 - Racer.md'), 'utf8'))!.title).toBe('Racer');
  });
});

describe('BacklogMdSource: marker lines', () => {
  it('create refuses a section with a block marker line and writes nothing', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A') });
    await expect(p.src.create({ title: 'x', column: 'To Do', sections: { description: 'a\n<!-- SECTION:DESCRIPTION:END -->' } }, { now: NOW })).rejects.toBeInstanceOf(SourceError);
    expect(names(p.tasks)).toEqual(['task-1 - A.md']);
  });
});

describe('BacklogMdSource: path safety (C78)', () => {
  it('ids that are not ids reach no file; titles cannot escape the folder', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A') });
    writeFileSync(join(p.root, 'canary.md'), task('TASK-1', 'Canary'));
    for (const bad of ['../canary', 'task-1/../../canary', '', 'a\u0000b', '/etc/passwd', 'TASK-1; rm', ' TASK-1', 'x'.repeat(500)]) {
      expect(await p.src.read(bad)).toBeNull();
      await expect(p.src.write(bad, { title: 'pwned' }, { now: NOW })).rejects.toBeInstanceOf(SourceError);
    }
    const c = await p.src.create({ title: '../../canary', column: 'To Do' }, { now: NOW });
    const made = names(p.tasks).find((n) => n.startsWith(`${c.id.toLowerCase()} - `))!;
    expect(made).not.toMatch(/[/\\]/);
    expect(existsSync(join(p.root, 'canary.md'))).toBe(true);
    expect(parseTask(readFileSync(join(p.root, 'canary.md'), 'utf8'))!.title).toBe('Canary');
    for (const t of ['a/b', 'a\\b', '..', '.', 'C:\\x', '\u0000x']) {
      const x = await p.src.create({ title: t, column: 'To Do' }, { now: NOW }).catch((e) => e);
      if (x instanceof SourceError) continue;
      expect(names(p.tasks).filter((n) => n.startsWith(`${x.id.toLowerCase()} - `))[0]).not.toMatch(/[/\\]/);
    }
    expect(readdirSync(p.root).sort()).toEqual(['backlog', 'backlog.config.yml', 'canary.md']);
  });

  it('a hostile preferred id or parent is not used as a path', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A') });
    const c = await p.src.create({ title: 'x', column: 'To Do', preferId: '../../evil' }, { now: NOW });
    expect(c.id).toBe('TASK-2');
    await expect(p.src.create({ title: 'x', column: 'To Do', parent: '../x' }, { now: NOW })).rejects.toBeInstanceOf(SourceError);
    await expect(p.src.nextId('../x')).rejects.toBeInstanceOf(SourceError);
  });
});

describe('BacklogMdSource: watching (C32, C34, C38)', () => {
  const waitFor = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return cond();
  };

  it('reports outside edits, new, removed and moved-to-archive files within 2 s', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A'), 'task-2 - B.md': task('TASK-2', 'B') });
    let n = 0;
    const stop = p.src.watch(() => n++);
    await new Promise((r) => setTimeout(r, 150));
    const hit = async (fn: () => void) => {
      const before = n;
      const t0 = Date.now();
      fn();
      expect(await waitFor(() => n > before)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2000);
    };
    await hit(() => writeFileSync(join(p.tasks, 'task-1 - A.md'), task('TASK-1', 'A2')));
    await hit(() => writeFileSync(join(p.tasks, 'task-3 - C.md'), task('TASK-3', 'C')));
    await hit(() => rmSync(join(p.tasks, 'task-3 - C.md')));
    await hit(() => renameSync(join(p.tasks, 'task-2 - B.md'), join(p.root, 'backlog', 'archive', 'tasks', 'task-2 - B.md')));
    await hit(() => writeFileSync(join(p.root, 'backlog.config.yml'), CLI_CONFIG.replace('"To Do", "In', '"Todo", "In')));
    stop();
  });

  it('a burst of 50 writes ends in the final state with a bounded number of callbacks', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 50; i++) files[`task-${i} - T${i}.md`] = task(`TASK-${i}`, `T${i}`);
    const p = project(files);
    let n = 0;
    const stop = p.src.watch(() => n++);
    await new Promise((r) => setTimeout(r, 150));
    for (let i = 1; i <= 50; i++) writeFileSync(join(p.tasks, `task-${i} - T${i}.md`), task(`TASK-${i}`, `T${i}`, { status: 'Done' }));
    expect(await waitFor(() => n > 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(n).toBeLessThanOrEqual(8);
    expect((await p.src.list()).cards.every((c) => c.column === 'Done')).toBe(true);
    stop();
  });

  it('a missing folder is an error that clears when the folder is back; watchers release with the last stop', async () => {
    const p = project({ 'task-1 - A.md': task('TASK-1', 'A') });
    await p.src.list();
    expect(p.src.watchingFs).toBe(false);
    let n = 0;
    const stop = p.src.watch(() => n++);
    const stop2 = p.src.watch(() => n++);
    expect(p.src.watchingFs).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    const moved = join(p.root, 'backlog', 'tasks-away');
    renameSync(p.tasks, moved);
    expect(await waitFor(() => n > 0)).toBe(true);
    await expect(p.src.list()).rejects.toThrow(/tasks folder is missing/);
    const before = n;
    renameSync(moved, p.tasks);
    expect(await waitFor(() => n > before)).toBe(true);
    expect((await p.src.list()).cards).toHaveLength(1);
    stop();
    expect(p.src.watchingFs).toBe(true);
    stop2();
    expect(p.src.watchingFs).toBe(false);
    expect(p.src.watching).toBe(0);
  });
});
