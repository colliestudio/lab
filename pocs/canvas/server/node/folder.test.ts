import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FolderStorage } from './folder';

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
  it('serves that file under any name; nothing can be created, renamed or deleted', async () => {
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

  it('names a .canvas file by its stem; a file that does not exist yet is just missing', async () => {
    const st = new FolderStorage(dir, { file: join(dir, 'board.canvas') });
    expect(await st.list()).toEqual([]);
    expect(await st.read(FolderStorage.nameOf('board.canvas'))).toBeUndefined();
    await st.write('board', '{}');
    expect((await st.list()).map((i) => i.name)).toEqual(['board']);
  });
});
