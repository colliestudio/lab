import { existsSync, mkdirSync, symlinkSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardDirectory } from '../core/directory';
import { NotLocalError } from '../core/errors';
import { FolderStorage } from './folder';
import { LOCK_FILE } from './lock';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'canvas-folder-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FolderStorage (a folder of boards)', () => {
  it('lists only top-level .canvas files', async () => {
    writeFileSync(join(dir, 'a.canvas'), '{}');
    writeFileSync(join(dir, 'b.canvas'), '{"nodes":[]}');
    writeFileSync(join(dir, 'notes.md'), 'x');
    writeFileSync(join(dir, '.hidden.canvas'), '{}');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'c.canvas'), '{}');
    mkdirSync(join(dir, '.canvas-bridge'));
    writeFileSync(join(dir, '.canvas-bridge', 'a.canvas.ystate'), 'x');
    const st = new FolderStorage(dir);
    const list = await st.list();
    expect(list.map((i) => i.name)).toEqual(['a', 'b']);
    expect(list[1].size).toBe(12);
    expect(list[0].modified).toBeGreaterThan(0);
    expect(st.mutable).toBe(true);
  });

  it('does not list a symlinked board (a write would replace the link, not its target)', async () => {
    mkdirSync(join(dir, 'ext'));
    writeFileSync(join(dir, 'ext', 'linked.canvas'), '{}');
    symlinkSync(join(dir, 'ext', 'linked.canvas'), join(dir, 'linked.canvas'));
    writeFileSync(join(dir, 'real.canvas'), '{}');
    expect((await new FolderStorage(dir).list()).map((i) => i.name)).toEqual(['real']);
  });

  it('renames a decomposed name to its composed spelling without refusing itself', async () => {
    const st = new FolderStorage(dir);
    await st.write('cafe\u0301', 'x');
    await st.rename('cafe\u0301', 'caf\u00e9');
    expect(await st.read('caf\u00e9')).toBe('x');
  });

  it('read is undefined for a missing board; write replaces atomically (no .tmp left)', async () => {
    const st = new FolderStorage(dir);
    expect(await st.read('a')).toBeUndefined();
    await st.write('a', 'one');
    await st.write('a', 'two');
    expect(await st.read('a')).toBe('two');
    expect(readdirSync(dir)).toEqual(['a.canvas']);
  });

  it('create is exclusive', async () => {
    const st = new FolderStorage(dir);
    expect(await st.create('a', 'first')).toBe(true);
    expect(await st.create('a', 'second')).toBe(false);
    expect(readFileSync(join(dir, 'a.canvas'), 'utf8')).toBe('first');
  });

  it('keeps the history sidecar where the bridge keeps it', async () => {
    const st = new FolderStorage(dir);
    expect(await st.readState('a')).toBeUndefined();
    await st.writeState('a', new Uint8Array([1, 2, 3]));
    expect(existsSync(join(dir, '.canvas-bridge', 'a.canvas.ystate'))).toBe(true);
    expect([...(await st.readState('a'))!]).toEqual([1, 2, 3]);
  });

  it('rename moves the sidecars and refuses an existing target', async () => {
    const st = new FolderStorage(dir);
    await st.write('a', 'A');
    await st.write('b', 'B');
    await st.writeState('a', new Uint8Array([9]));
    writeFileSync(join(dir, '.canvas-bridge', 'a.canvas.room'), 'room\n');
    await expect(st.rename('a', 'b')).rejects.toThrow(/exists/);
    await st.rename('a', 'c');
    expect(readdirSync(dir).filter((f) => f.endsWith('.canvas')).sort()).toEqual(['b.canvas', 'c.canvas']);
    expect(readdirSync(join(dir, '.canvas-bridge')).sort()).toEqual(['c.canvas.room', 'c.canvas.ystate']);
  });

  it('remove moves the board and its history to the trash', async () => {
    const st = new FolderStorage(dir);
    await st.write('a', 'A');
    await st.writeState('a', new Uint8Array([9]));
    await st.remove('a');
    expect(existsSync(join(dir, 'a.canvas'))).toBe(false);
    const trash = readdirSync(join(dir, '.canvas-bridge', 'trash')).sort();
    expect(trash).toHaveLength(2);
    expect(trash[0]).toMatch(/^a-\d{4}-\d\d-\d\dT[\d-]+Z\.canvas$/);
    expect(trash[1]).toBe(trash[0] + '.ystate');
    expect(readFileSync(join(dir, '.canvas-bridge', 'trash', trash[0]), 'utf8')).toBe('A');
  });

  it('watch fires for an editor-style replace of the watched file only, and stops after unwatch', async () => {
    const st = new FolderStorage(dir);
    await st.write('a', 'one');
    await st.write('b', 'one');
    let hits = 0;
    const off = st.watch('a', () => hits++);
    await wait(100);
    writeFileSync(join(dir, 'a.canvas.editor-tmp'), 'two'); // an editor's temp file: not ours
    renameSync(join(dir, 'a.canvas.editor-tmp'), join(dir, 'a.canvas'));
    await wait(300);
    expect(hits).toBeGreaterThan(0);
    const seen = hits;
    writeFileSync(join(dir, 'b.canvas'), 'two');
    await wait(300);
    expect(hits).toBe(seen);
    off();
    writeFileSync(join(dir, 'a.canvas'), 'three');
    await wait(300);
    expect(hits).toBe(seen);
  });

  it('a symlinked folder is one folder (names, paths)', async () => {
    const st = new FolderStorage(dir);
    await st.write('a', 'x');
    expect(st.location('a')).toBe(join(st.dir, 'a.canvas'));
  });
});

describe('FolderStorage (one fixed file)', () => {
  it('serves that file (any filename); nothing can be created, renamed or deleted', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'other.canvas'), '{}');
    const st = new FolderStorage(dir, { file: join(dir, 'notes.txt') });
    expect(st.mutable).toBe(false);
    expect((await st.list()).map((i) => i.name)).toEqual(['notes.txt']);
    expect(await st.read('notes.txt')).toBe('x');
    await st.write('notes.txt', 'y');
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('y');
    await st.writeState('notes.txt', new Uint8Array([1]));
    expect(existsSync(join(dir, '.canvas-bridge', 'notes.txt.ystate'))).toBe(true);
  });

  it('is that one board only: any other name is missing and cannot be written', async () => {
    writeFileSync(join(dir, 'main.canvas'), 'm');
    writeFileSync(join(dir, 'other.canvas'), 'o');
    const st = new FolderStorage(dir, { file: join(dir, 'main.canvas') });
    expect(await st.read('other')).toBeUndefined();
    expect(await st.readState('other')).toBeUndefined();
    await expect(st.write('other', 'x')).rejects.toThrow(/no canvas/);
    expect(readFileSync(join(dir, 'other.canvas'), 'utf8')).toBe('o');
  });

  it('a conditional write is refused when the file changed since it was read', async () => {
    const st = new FolderStorage(dir);
    await st.write('a', 'one');
    expect(await st.write('a', 'two', { from: 'one' })).toBe(true);
    expect(await st.write('a', 'three', { from: 'one' })).toBe(false);
    expect(await st.read('a')).toBe('two');
    expect(await st.write('b', 'new', { from: undefined })).toBe(true);
    expect(await st.write('b', 'again', { from: undefined })).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('names a .canvas file by its stem; a file that does not exist yet is just missing', async () => {
    const st = new FolderStorage(dir, { file: join(dir, 'board.canvas') });
    expect(await st.list()).toEqual([]);
    expect(await st.read(FolderStorage.nameOf('board.canvas'))).toBeUndefined();
    await st.write('board', '{}');
    expect((await st.list()).map((i) => i.name)).toEqual(['board']);
  });
});

describe('FolderStorage (iCloud stubs)', () => {
  const stub = (name: string) => writeFileSync(join(dir, `.${name}.canvas.icloud`), 'plist');

  it('lists an evicted board once, asks for its download at most once a minute', async () => {
    stub('Foo');
    const asked: string[] = [];
    const st = new FolderStorage(dir, { download: (p) => asked.push(p) });
    const list = await st.list();
    expect(list).toEqual([expect.objectContaining({ name: 'Foo', evicted: true })]);
    await st.list();
    expect(asked).toEqual([join(st.dir, 'Foo.canvas')]);
  });

  it('a stub whose name starts with a dot is no board', async () => {
    writeFileSync(join(dir, '..x.canvas.icloud'), 'p');
    expect(await new FolderStorage(dir, { download: () => {} }).list()).toEqual([]);
  });

  it('a real file wins over its stub; the lock file is not a board', async () => {
    stub('Foo');
    writeFileSync(join(dir, 'Foo.canvas'), '{}');
    writeFileSync(join(dir, LOCK_FILE), '{}');
    const asked: string[] = [];
    const list = await new FolderStorage(dir, { download: (p) => asked.push(p) }).list();
    expect(list.map((i) => [i.name, i.evicted])).toEqual([['Foo', undefined]]);
    expect(asked).toEqual([]);
  });

  it('reading an evicted board throws and starts the download; create, rename onto it and moving it are refused; nothing is written', async () => {
    stub('Foo');
    writeFileSync(join(dir, 'Bar.canvas'), '{}');
    const asked: string[] = [];
    const st = new FolderStorage(dir, { download: (p) => asked.push(p) });
    await expect(st.read('Foo')).rejects.toBeInstanceOf(NotLocalError);
    expect(asked).toHaveLength(1);
    expect(await st.create('Foo', 'x')).toBe(false);
    await expect(st.rename('Bar', 'Foo')).rejects.toThrow(/exists/);
    await expect(st.rename('Foo', 'Baz')).rejects.toBeInstanceOf(NotLocalError);
    await expect(st.remove('Foo')).rejects.toBeInstanceOf(NotLocalError);
    expect(existsSync(join(dir, 'Foo.canvas'))).toBe(false);
    expect(await st.read('Nope')).toBeUndefined();
  });

  it('the directory shows the evicted text, refuses to open (even with create) and to create over it', async () => {
    stub('Foo');
    const d = new BoardDirectory(new FolderStorage(dir, { download: () => {} }), { sweepMs: 0, log: () => {} });
    expect(await d.list()).toEqual([expect.objectContaining({ name: 'Foo', evicted: true, error: expect.stringContaining('not downloaded') })]);
    await expect(d.open('Foo', { create: true })).rejects.toBeInstanceOf(NotLocalError);
    await expect(d.open('foo', { create: true })).rejects.toBeInstanceOf(NotLocalError);
    await expect(d.create('foo')).rejects.toMatchObject({ status: 409 });
    expect(existsSync(join(dir, 'Foo.canvas'))).toBe(false);
    expect(existsSync(join(dir, 'foo.canvas'))).toBe(false);
  });
});
