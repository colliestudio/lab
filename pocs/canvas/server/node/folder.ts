import { watch, realpathSync, type FSWatcher } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, writeFile, access } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { BoardInfo, BoardStorage } from '../core/storage';

// Boards as .canvas files in one folder (iCloud, Dropbox, a git repo all work: it is just files).
//  <dir>/<name>.canvas                            the board; the file is the durable record
//  <dir>/.canvas-bridge/<file>.canvas.ystate      its Yjs history, so open tabs and a restarted server agree
//  <dir>/.canvas-bridge/<file>.canvas.room        the room a bridge saved it from (bridge/server.ts)
//  <dir>/.canvas-bridge/trash/<name>-<time>.canvas  deleted boards (real deletion is Finder's job)
// With `file`, the folder driver serves exactly that one file (bridge mode): any filename, no create,
// rename or delete.

const EXT = '.canvas';
const SIDECARS = ['.ystate', '.room'];

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export class FolderStorage implements BoardStorage {
  readonly mutable: boolean;
  readonly dir: string;
  private readonly single: string | undefined;
  private readonly stateDir: string;
  private watchers = new Map<string, Set<() => void>>();
  private fsWatcher: FSWatcher | undefined;

  constructor(dir: string, opts: { file?: string } = {}) {
    // the real path, so a symlinked folder (/tmp on macOS) is one folder to the watcher and to names
    this.dir = realpathSync(resolve(opts.file ? dirname(opts.file) : dir));
    this.single = opts.file ? basename(opts.file) : undefined;
    this.mutable = !opts.file;
    this.stateDir = join(this.dir, '.canvas-bridge');
  }

  /** The name a single file is served as. */
  static nameOf(file: string): string {
    const ext = extname(file);
    return basename(file, ext === EXT ? ext : '');
  }

  private fileName(name: string) {
    return this.single ?? name + EXT;
  }
  private path(name: string) {
    return join(this.dir, this.fileName(name));
  }
  private sidecar(name: string, ext: string) {
    return join(this.stateDir, this.fileName(name) + ext);
  }

  async list(): Promise<BoardInfo[]> {
    const names = this.single ? [this.single] : (await readdir(this.dir, { withFileTypes: true })).filter((e) => e.name.endsWith(EXT) && !e.name.startsWith('.') && (e.isFile() || e.isSymbolicLink())).map((e) => e.name);
    const out: BoardInfo[] = [];
    for (const f of names) {
      try {
        const s = await stat(join(this.dir, f));
        if (s.isFile()) out.push({ name: this.single ? FolderStorage.nameOf(f) : f.slice(0, -EXT.length), modified: Math.floor(s.mtimeMs), size: s.size });
      } catch (e) {
        if (!missing(e)) throw e;
      }
    }
    return out;
  }

  async read(name: string) {
    try {
      return await readFile(this.path(name), 'utf8');
    } catch (e) {
      if (missing(e)) return undefined;
      throw e;
    }
  }

  async write(name: string, text: string) {
    const path = this.path(name);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, path);
  }

  async create(name: string, text: string) {
    let fh;
    try {
      fh = await open(this.path(name), 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    try {
      await fh.writeFile(text);
    } finally {
      await fh.close();
    }
    return true;
  }

  async rename(from: string, to: string) {
    if (from.toLowerCase() !== to.toLowerCase() && (await exists(this.path(to)))) throw new Error(`${to} exists`);
    await rename(this.path(from), this.path(to));
    for (const ext of SIDECARS) {
      try {
        await rename(this.sidecar(from, ext), this.sidecar(to, ext));
      } catch (e) {
        if (!missing(e)) throw e;
      }
    }
  }

  async remove(name: string) {
    const trash = join(this.stateDir, 'trash');
    await mkdir(trash, { recursive: true });
    const stem = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await rename(this.path(name), join(trash, stem + EXT));
    for (const ext of SIDECARS) {
      try {
        await rename(this.sidecar(name, ext), join(trash, stem + EXT + ext));
      } catch (e) {
        if (!missing(e)) throw e;
      }
    }
  }

  async readState(name: string) {
    try {
      return new Uint8Array(await readFile(this.sidecar(name, '.ystate')));
    } catch (e) {
      if (missing(e)) return undefined;
      throw e;
    }
  }

  async writeState(name: string, data: Uint8Array) {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.sidecar(name, '.ystate'), data);
  }

  /** The sidecar for the room a bridge joined (bridge/server.ts reads and writes it). */
  roomMarkPath(name: string) {
    return this.sidecar(name, '.room');
  }
  stateDirPath() {
    return this.stateDir;
  }

  watch(name: string, onChange: () => void) {
    const file = this.fileName(name);
    const set = this.watchers.get(file) ?? new Set();
    this.watchers.set(file, set);
    set.add(onChange);
    // one watcher on the folder for all boards (editors and git replace the file instead of writing in place)
    if (!this.fsWatcher) {
      this.fsWatcher = watch(this.dir, (_ev, changed) => {
        if (changed) for (const fn of this.watchers.get(changed.toString()) ?? []) fn();
      });
      this.fsWatcher.on('error', () => {});
    }
    return () => {
      set.delete(onChange);
      if (!set.size) this.watchers.delete(file);
      if (!this.watchers.size) {
        this.fsWatcher?.close();
        this.fsWatcher = undefined;
      }
    };
  }

  location(name: string) {
    return this.path(name);
  }
}

const exists = (p: string) => access(p).then(
  () => true,
  () => false,
);
