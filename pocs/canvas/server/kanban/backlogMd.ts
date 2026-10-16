import { lstatSync, readdirSync, readFileSync, statSync, watch as fsWatch, realpathSync, type FSWatcher } from 'node:fs';
import { access, constants, link, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ID_RE, newTaskFile, nextTaskId, parseConfig, parseTask, patchTask, taskFileName, type BoardConfig, type ParsedTask, type TaskPatch } from '../../src/plugins/kanban/markdown';
import { SourceError, type Card, type CardPatch, type NewCard, type SourceInfo, type TrackerSource, type WriteOpts } from '../../src/plugins/kanban/source';

// The Backlog.md folder behind a kanban node: the task files, read and written in place, the way the
// `backlog` CLI does. The only code that touches the folder. Rules:
//  - the folder is fixed at construction (serve config); every path is built from it and a name the
//    directory listing gave, never from a client's text, and a card id is checked before it is used
//  - one write at a time (a queue); a write replaces the file atomically (temp file in the same folder + rename)
//  - a file that stops parsing keeps its last good card; a missing folder is an error that clears when it is back

export interface BacklogMdOptions {
  /** Safety net under fs.watch, which misses events on some volumes. Default 1000 ms; 0 = off. */
  pollMs?: number;
  /** Quiet time before `watch` callbacks run. Default 100 ms (never later than 500 ms after the first change). */
  debounceMs?: number;
}

/** Is `path` a Backlog.md project root (has backlog.config.yml) or a backlog folder (has config.yml and tasks/)? */
export function findBacklog(path: string): { root: string; configFile: string; config: string; dir: string } {
  const real = realpathSync(resolve(path));
  const tryRoot = () => {
    const cfg = join(real, 'backlog.config.yml');
    try {
      return { root: real, configFile: cfg, config: parseConfigFile(cfg) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  };
  const asRoot = tryRoot();
  if (asRoot) {
    const leaves = (p: string) => relative(real, p).startsWith('..') || isAbsolute(relative(real, p));
    if (leaves(resolve(real, asRoot.config.directory))) throw new Error(`backlog_directory "${asRoot.config.directory}" leaves the project folder`);
    const dir = realpathSync(resolve(real, asRoot.config.directory));
    if (leaves(dir)) throw new Error(`backlog_directory "${asRoot.config.directory}" leaves the project folder`);
    return { root: real, configFile: asRoot.configFile, config: asRoot.config.text, dir };
  }
  const cfg = join(real, 'config.yml');
  const c = parseConfigFile(cfg);
  return { root: real, configFile: cfg, config: c.text, dir: real };
}

function parseConfigFile(file: string): BoardConfig & { text: string } {
  const text = readFileSync(file, 'utf8');
  return { ...parseConfig(text), text };
}

interface Cached {
  stamp: string;
  parsed: ParsedTask | null;
  /** The last version that parsed (kept while the file is unreadable). */
  good?: ParsedTask;
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const stampOf = (s: { mtimeMs: number; size: number; ino: number }) => `${s.mtimeMs}:${s.size}:${s.ino}`;

export class BacklogMdSource implements TrackerSource {
  readonly kind = 'backlog-md';
  private readonly root: string;
  private readonly configFile: string;
  private readonly dir: string;
  private readonly tasksDir: string;
  private config: BoardConfig;
  private configStamp = '';
  private files = new Map<string, Cached>();
  private chain: Promise<unknown> = Promise.resolve();
  private watchers = new Set<() => void>();
  private fsw: FSWatcher | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private fireTimer: ReturnType<typeof setTimeout> | undefined;
  private firstPending = 0;
  private lastSig = '';
  private readonly pollMs: number;
  private readonly debounceMs: number;

  /** `path`: a project root (backlog.config.yml) or a backlog folder (config.yml + tasks/). Throws when it is neither. */
  constructor(path: string, o: BacklogMdOptions = {}) {
    const f = findBacklog(path);
    this.root = f.root;
    this.configFile = f.configFile;
    this.dir = f.dir;
    this.tasksDir = join(this.dir, 'tasks');
    this.config = parseConfig(f.config);
    this.pollMs = o.pollMs ?? 1000;
    this.debounceMs = o.debounceMs ?? 100;
  }

  // ------------------------------------------------------------ reading

  private info(): SourceInfo {
    const c = this.config;
    return {
      name: c.name,
      columns: c.statuses,
      defaultColumn: c.defaultStatus,
      doneColumn: c.statuses.at(-1),
      labels: c.labels,
      priorities: ['high', 'medium', 'low'],
      caps: { sections: ['description', 'plan', 'notes'], checklist: true, comments: true, order: 'number', nextId: true },
    };
  }

  private async readConfig() {
    let st;
    try {
      st = await stat(this.configFile);
    } catch (e) {
      throw new SourceError('io', missing(e) ? 'the Backlog.md config is missing' : `cannot read the Backlog.md config: ${(e as Error).message}`);
    }
    const s = stampOf(st);
    if (s === this.configStamp) return;
    try {
      this.config = parseConfig(await readFile(this.configFile, 'utf8'));
      this.configStamp = s;
    } catch (e) {
      // a config that stopped parsing keeps the last good one; only a first read fails
      if (!this.configStamp) throw new SourceError('io', `the Backlog.md config can not be read: ${(e as Error).message}`);
    }
  }

  /** Re-read what changed in the tasks folder. */
  private async scan(): Promise<Map<string, ParsedTask>> {
    await this.readConfig();
    let names: string[];
    try {
      names = (await readdir(this.tasksDir, { withFileTypes: true })).filter((d) => d.isFile() && d.name.endsWith('.md') && !d.name.startsWith('.')).map((d) => d.name);
    } catch (e) {
      throw new SourceError('io', missing(e) ? 'the tasks folder is missing' : `cannot read the tasks folder: ${(e as Error).message}`);
    }
    const seen = new Set(names);
    for (const n of [...this.files.keys()]) if (!seen.has(n)) this.files.delete(n);
    await Promise.all(
      names.map(async (n) => {
        const file = join(this.tasksDir, n);
        let st;
        try {
          st = await stat(file);
        } catch {
          this.files.delete(n);
          return;
        }
        const stamp = stampOf(st);
        const hit = this.files.get(n);
        if (hit && hit.stamp === stamp) return;
        try {
          const parsed = parseTask(await readFile(file, 'utf8'));
          this.files.set(n, { stamp, parsed, good: parsed ?? hit?.good });
        } catch {
          if (hit) this.files.set(n, { ...hit, stamp });
        }
      }),
    );
    const byId = new Map<string, ParsedTask>();
    const idFile = new Map<string, string>();
    for (const [n, c] of [...this.files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const t = c.parsed ?? c.good;
      if (t && ID_RE.test(t.taskId) && !byId.has(t.taskId)) {
        byId.set(t.taskId, t);
        idFile.set(t.taskId, n);
      }
    }
    this.idFile = idFile;
    return byId;
  }
  private idFile = new Map<string, string>();

  private card(t: ParsedTask): Card {
    return {
      id: t.taskId,
      title: t.title,
      column: t.status,
      order: t.ordinal,
      labels: t.labels,
      assignee: t.assignee,
      priority: t.priority,
      parent: t.parent,
      created: t.created,
      updated: t.updated,
      sections: Object.fromEntries((['description', 'plan', 'notes'] as const).filter((k) => t[k]).map((k) => [k, t[k]])),
      checklist: t.ac,
      comments: t.comments,
    };
  }

  async list() {
    const tasks = await this.scan();
    return { info: this.info(), cards: [...tasks.values()].map((t) => this.card(t)) };
  }

  async read(id: string): Promise<Card | null> {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const tasks = await this.scan();
    const t = tasks.get(id.toUpperCase());
    return t ? this.card(t) : null;
  }

  // ------------------------------------------------------------ writing

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private ioError(e: unknown, what: string): SourceError {
    if (e instanceof SourceError) return e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new SourceError('io', `${what}: the file is read-only`);
    if (code === 'ENOENT') return new SourceError('not-found', `${what}: the file is gone`);
    return new SourceError('io', `${what}: ${String((e as Error).message ?? e).split(this.root).join('…')}`);
  }

  private toPatch(p: CardPatch): TaskPatch {
    if (p.column !== undefined && !this.config.statuses.includes(p.column)) throw new SourceError('invalid', `no status "${p.column}" (statuses: ${this.config.statuses.join(', ')})`);
    if (p.priority && !['high', 'medium', 'low'].includes(p.priority)) throw new SourceError('invalid', `priority must be high, medium or low, not "${p.priority}"`);
    if (p.title !== undefined && !p.title.trim()) throw new SourceError('invalid', 'a title can not be empty');
    return {
      title: p.title?.replace(/\s+/g, ' ').trim(),
      status: p.column,
      labels: p.labels,
      assignee: p.assignee,
      priority: p.priority,
      ordinal: p.order,
      sections: p.sections,
      ac: p.checklist,
      comment: p.comment && { author: p.comment.author, text: p.comment.text },
    };
  }

  write(id: string, patch: CardPatch, o: WriteOpts): Promise<Card> {
    return this.queue(async () => {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw new SourceError('not-found', `no task ${String(id).slice(0, 40)}`);
      const key = id.toUpperCase();
      for (let attempt = 0; ; attempt++) {
        const tasks = await this.scan();
        const t = tasks.get(key);
        const name = this.idFile.get(key);
        if (!t || !name) throw new SourceError('not-found', `no task ${key}`);
        const file = join(this.tasksDir, name);
        if (!file.startsWith(this.tasksDir + sep)) throw new SourceError('invalid', 'bad task file');
        const what = `could not write ${key}`;
        try {
          await access(file, constants.W_OK);
          const before = await stat(file);
          const text = await readFile(file, 'utf8');
          const next = patchTask(text, this.toPatch(patch), o.now);
          if (next !== text) {
            // the file changed since we read it (an editor, git): read again instead of writing over it
            if (stampOf(await stat(file)) !== stampOf(before)) {
              if (attempt < 3) continue;
              throw new SourceError('io', `${what}: the file keeps changing`);
            }
            await this.atomicWrite(file, next, before.mode);
          }
        } catch (e) {
          throw this.ioError(e, what);
        }
        this.files.delete(name);
        const after = (await this.scan()).get(key);
        if (!after) throw new SourceError('not-found', `${key} is gone after the write`);
        return this.card(after);
      }
    });
  }

  private async atomicWrite(file: string, text: string, mode: number) {
    const tmp = join(this.tasksDir, `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    try {
      const fh = await open(tmp, 'wx', mode & 0o777);
      try {
        await fh.writeFile(text, 'utf8');
      } finally {
        await fh.close();
      }
      await rename(tmp, file);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  // ------------------------------------------------------------ ids and new files

  private async allIds(): Promise<string[]> {
    const ids = new Set<string>();
    const prefix = `${this.config.prefix}-`;
    const dirs = [this.tasksDir, join(this.dir, 'archive', 'tasks'), join(this.dir, 'completed')];
    for (const d of dirs) {
      let names: string[] = [];
      try {
        names = await readdir(d);
      } catch {
        continue;
      }
      for (const n of names) {
        const m = /^(\S+) - /.exec(n) ?? /^(\S+)\.md$/.exec(n);
        if (m && m[1].toLowerCase().startsWith(prefix)) ids.add(m[1].toUpperCase());
      }
    }
    for (const t of this.idFile.keys()) ids.add(t);
    return [...ids];
  }

  async nextId(parent?: string): Promise<string> {
    await this.scan();
    if (parent !== undefined && !ID_RE.test(parent)) throw new SourceError('invalid', `bad parent id "${String(parent).slice(0, 40)}"`);
    return nextTaskId(await this.allIds(), this.config.prefix, parent);
  }

  create(n: NewCard, o: WriteOpts): Promise<Card> {
    return this.queue(async () => {
      const tasks = await this.scan();
      if (!this.config.statuses.includes(n.column)) throw new SourceError('invalid', `no status "${n.column}" (statuses: ${this.config.statuses.join(', ')})`);
      if (!n.title?.trim()) throw new SourceError('invalid', 'a title can not be empty');
      if (n.priority && !['high', 'medium', 'low'].includes(n.priority)) throw new SourceError('invalid', `priority must be high, medium or low, not "${n.priority}"`);
      const parent = n.parent?.toUpperCase();
      if (parent && (!ID_RE.test(parent) || !tasks.has(parent))) throw new SourceError('invalid', `no parent task "${String(n.parent).slice(0, 40)}"`);
      const used = new Set(await this.allIds());
      let id = n.preferId && ID_RE.test(n.preferId) && !used.has(n.preferId.toUpperCase()) && (!parent || n.preferId.toUpperCase().startsWith(`${parent}.`)) && n.preferId.toLowerCase().startsWith(`${this.config.prefix}-`) ? n.preferId.toUpperCase() : undefined;
      id ??= nextTaskId([...used], this.config.prefix, parent);
      const order = n.order ?? Math.max(0, ...[...tasks.values()].map((t) => t.ordinal ?? 0)) + 1000;
      const title = n.title.replace(/\s+/g, ' ').trim();
      for (let tries = 0; tries < 8; tries++) {
        const file = join(this.tasksDir, taskFileName(id, title));
        const text = newTaskFile(id, { title, status: n.column, labels: n.labels, assignee: n.assignee, priority: n.priority, parent, ordinal: order, description: n.sections?.description, plan: n.sections?.plan, notes: n.sections?.notes, ac: n.checklist }, o.now);
        const tmp = join(this.tasksDir, `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
        try {
          await mkdir(this.tasksDir, { recursive: true });
          const fh = await open(tmp, 'wx', 0o644);
          try {
            await fh.writeFile(text, 'utf8');
          } finally {
            await fh.close();
          }
          try {
            await link(tmp, file); // fails if the name exists: never over another file
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
              used.add(id);
              id = nextTaskId([...used], this.config.prefix, parent);
              continue;
            }
            throw e;
          } finally {
            await unlink(tmp).catch(() => {});
          }
        } catch (e) {
          await unlink(tmp).catch(() => {});
          throw this.ioError(e, 'could not create the task');
        }
        const made = (await this.scan()).get(id);
        if (!made) throw new SourceError('io', 'the new task did not show up');
        return this.card(made);
      }
      throw new SourceError('io', 'could not find a free task id');
    });
  }

  // ------------------------------------------------------------ watching

  /** Names and stamps of everything that matters, as one string (changes when anything does). Sync: cheap, and a watcher's first reading can't race an edit. */
  private signature(): string {
    const parts: string[] = [];
    try {
      parts.push(stampOf(statSync(this.configFile)));
    } catch {
      parts.push('noconfig');
    }
    try {
      for (const d of readdirSync(this.tasksDir, { withFileTypes: true })) {
        if (!d.isFile() || !d.name.endsWith('.md') || d.name.startsWith('.')) continue;
        try {
          parts.push(`${d.name}@${stampOf(lstatSync(join(this.tasksDir, d.name)))}`);
        } catch {
          /* gone meanwhile */
        }
      }
    } catch {
      parts.push('notasks');
    }
    return parts.sort().join('|');
  }

  private check() {
    const sig = this.signature();
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.schedule();
  }

  private schedule() {
    const now = Date.now();
    if (!this.fireTimer) this.firstPending = now;
    clearTimeout(this.fireTimer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstPending + 500 - now));
    this.fireTimer = setTimeout(() => {
      this.fireTimer = undefined;
      for (const w of [...this.watchers]) {
        try {
          w();
        } catch {
          /* one watcher's trouble is not the others' */
        }
      }
    }, wait);
  }

  private startWatching() {
    this.lastSig = this.signature();
    const attach = () => {
      if (this.fsw) return;
      try {
        this.fsw = fsWatch(this.tasksDir, { persistent: false }, () => this.check());
        this.fsw.on('error', () => {
          this.fsw?.close();
          this.fsw = undefined;
        });
      } catch {
        /* folder missing: the poll attaches again when it is back */
      }
    };
    attach();
    if (this.pollMs > 0) {
      this.poll = setInterval(() => {
        attach();
        this.check();
      }, this.pollMs);
      (this.poll as { unref?: () => void }).unref?.();
    }
  }

  private stopWatching() {
    this.fsw?.close();
    this.fsw = undefined;
    clearInterval(this.poll);
    this.poll = undefined;
    clearTimeout(this.fireTimer);
    this.fireTimer = undefined;
  }

  watch(onChange: () => void) {
    const w = () => onChange();
    this.watchers.add(w);
    if (this.watchers.size === 1) this.startWatching();
    return () => {
      if (!this.watchers.delete(w)) return;
      if (!this.watchers.size) this.stopWatching();
    };
  }

  /** Watchers attached (tests: released on unload). */
  get watching() {
    return this.watchers.size;
  }
  get watchingFs() {
    return !!this.fsw || !!this.poll;
  }
}
