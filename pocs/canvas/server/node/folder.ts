import { execFile } from 'node:child_process';
import { watch, realpathSync, type FSWatcher } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile, access } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { NotLocalError } from '../core/errors';
import type { BoardInfo, BoardStorage } from '../core/storage';

// Boards as .canvas files in one folder (iCloud, Dropbox, a git repo all work: it is just files).
//  <dir>/<name>.canvas                            the board; the file is the durable record
//  <dir>/.canvas-bridge/<file>.canvas.ystate      its Yjs history, so open tabs and a restarted server agree
//  <dir>/.canvas-bridge/<file>.canvas.room        the room a bridge saved it from (bridge/server.ts)
//  <dir>/.canvas-bridge/open-<pid>.json           a running bridge's marker (lock.ts): a serve refuses the folder
//  <dir>/.canvas-bridge/trash/<name>-<time>.canvas  deleted boards (real deletion is Finder's job)
// With `file`, the folder driver serves exactly that one file (bridge mode): any filename, no create,
// rename or delete.
// iCloud can evict a board: Finder shows it, the folder holds only a stub `.<name>.canvas.icloud`. Such a board
// is listed as `evicted` (nothing reads or writes it), and asking for it triggers a download (`brctl download`).

const EXT = '.canvas';
const SIDECARS = ['.ystate', '.room'];

const fold = (n: string) => n.normalize('NFC').toLowerCase();
// (a stubbed name that starts with a dot would be no valid board name)
const STUB = /^\.([^.].*\.canvas)\.icloud$/;
const DOWNLOAD_EVERY_MS = 60_000;
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export class FolderStorage implements BoardStorage {
  readonly mutable: boolean;
  readonly dir: string;
  private readonly single: string | undefined;
  private readonly stateDir: string;
  private watchers = new Map<string, Set<() => void>>();
  private fsWatcher: FSWatcher | undefined;

  private downloads = new Map<string, number>();
  private readonly download: (path: string) => void;

  /** `download`: asks the cloud store to fetch an evicted board (default: `brctl download` on macOS). */
  constructor(dir: string, opts: { file?: string; download?: (path: string) => void } = {}) {
    this.download = opts.download ?? (platform() === 'darwin' ? (p) => void execFile(process.env.CANVAS_BRCTL || 'brctl', ['download', p], () => {}) : () => {});
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

  /** Ask for the download of an evicted board, at most once a minute per board. */
  private fetchEvicted(file: string) {
    const now = Date.now();
    if (now - (this.downloads.get(file) ?? 0) < DOWNLOAD_EVERY_MS) return;
    this.downloads.set(file, now);
    this.download(join(this.dir, file));
  }

  /** The stub of a board file that isn't there, if iCloud has evicted it. */
  private async stubOf(file: string): Promise<string | undefined> {
    if (this.single) return undefined;
    const stub = `.${file}.icloud`;
    return (await exists(join(this.dir, stub))) ? stub : undefined;
  }

  async list(): Promise<BoardInfo[]> {
    const entries = this.single ? [] : await readdir(this.dir, { withFileTypes: true });
    const names = this.single ? [this.single] : entries.filter((e) => e.name.endsWith(EXT) && !e.name.startsWith('.') && e.isFile()).map((e) => e.name);
    const out: BoardInfo[] = [];
    const have = new Set(names.map(fold));
    for (const e of entries) {
      const stubbed = STUB.exec(e.name)?.[1];
      if (!stubbed || !e.isFile() || have.has(fold(stubbed))) continue;
      try {
        const s = await stat(join(this.dir, e.name));
        out.push({ name: stubbed.slice(0, -EXT.length), modified: Math.floor(s.mtimeMs), evicted: true });
        this.fetchEvicted(stubbed);
      } catch (err) {
        if (!missing(err)) throw err;
      }
    }
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
    if (this.single && name !== FolderStorage.nameOf(this.single)) return undefined;
    try {
      return await readFile(this.path(name), 'utf8');
    } catch (e) {
      if (!missing(e)) throw e;
      if (await this.stubOf(this.fileName(name))) {
        this.fetchEvicted(this.fileName(name));
        throw new NotLocalError(name);
      }
      return undefined;
    }
  }

  async write(name: string, text: string, expect?: { from: string | undefined }) {
    this.own(name);
    const path = this.path(name);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text);
    // an editor may have replaced the file while the temp file was written: look again right before the replace
    try {
      if (expect && (await this.read(name)) !== expect.from) {
        await unlink(tmp).catch(() => {});
        return false;
      }
      await rename(tmp, path);
      return true;
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  /** Fixed-file mode: the one file is the only board there is. */
  private own(name: string) {
    if (this.single && name !== FolderStorage.nameOf(this.single)) throw new Error(`no board "${name}" here`);
  }

  async create(name: string, text: string) {
    if (await this.stubOf(this.fileName(name))) return false;
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
    await this.mustBeLocal(from);
    if (await this.stubOf(this.fileName(to))) throw new Error(`${to} exists`);
    if (fold(from) !== fold(to) && (await exists(this.path(to)))) throw new Error(`${to} exists`);
    await rename(this.path(from), this.path(to));
    for (const ext of SIDECARS) {
      try {
        await rename(this.sidecar(from, ext), this.sidecar(to, ext));
      } catch (e) {
        if (!missing(e)) throw e;
      }
    }
  }

  /** An evicted board can't be moved or deleted from here: the file isn't on this machine. */
  private async mustBeLocal(name: string) {
    if (!(await exists(this.path(name))) && (await this.stubOf(this.fileName(name)))) {
      this.fetchEvicted(this.fileName(name));
      throw new NotLocalError(name);
    }
  }

  async remove(name: string) {
    await this.mustBeLocal(name);
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
    if (this.single && name !== FolderStorage.nameOf(this.single)) return undefined;
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
