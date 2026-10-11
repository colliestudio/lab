import type { PulledTask } from './commands';
import { hashFields, newTaskFile, nextTaskId, parseConfig, parseTask, patchTask, taskFileName, type BoardConfig, type FieldName, type TaskFields } from './markdown';
import type { BoardField, SourceKind } from './model';

// Where a board's data lives. The host tab (the one that connected the board) is the only one that
// talks to a source; everyone else sees the board through the Yjs doc.
//   files:   a folder of Backlog.md markdown (File System Access API, or the dev server's folder)
//   service: a running Backlog.md server (`backlog browser`) through its JSON API

export interface Snapshot {
  meta: Partial<BoardField>;
  tasks: PulledTask[];
}

export interface WriteCtx {
  /** Backlog ids of a column in board order (after this write), for reorder APIs. */
  columnOrder(status: string): string[];
  /** Every Backlog id the board knows (to pick a new one). */
  allIds: string[];
  now: Date;
}

export interface Source {
  kind: SourceKind;
  label: string;
  /** Everything the source holds now, or null when nothing changed since the last read. */
  read(): Promise<Snapshot | null>;
  /** Write `dirty` fields of a task (all of them for a task without an id: create it). */
  write(t: { taskId?: string; path?: string; fields: TaskFields }, dirty: FieldName[], ctx: WriteCtx): Promise<{ taskId: string; path?: string }>;
}

// ------------------------------------------------------------------ folders

export interface Entry {
  name: string;
  kind: 'file' | 'dir';
  /** Change stamp (mtime + size): equal = unchanged. */
  stamp: string;
}

/** A directory tree the board may read and write (paths are "a/b/c.md", relative to its root). */
export interface Folder {
  name: string;
  /** Entries of a directory, or null when it doesn't exist. */
  list(dir: string): Promise<Entry[] | null>;
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
}

/** File System Access API (Chromium): a folder the user picked. */
export class FsaFolder implements Folder {
  constructor(readonly handle: FileSystemDirectoryHandle) {}
  get name() {
    return this.handle.name;
  }
  private async dir(path: string, create = false): Promise<FileSystemDirectoryHandle | null> {
    let h = this.handle;
    for (const part of path.split('/').filter(Boolean)) {
      try {
        h = await h.getDirectoryHandle(part, { create });
      } catch {
        return null;
      }
    }
    return h;
  }
  private split(path: string) {
    const i = path.lastIndexOf('/');
    return i < 0 ? ['', path] : [path.slice(0, i), path.slice(i + 1)];
  }
  async list(dir: string): Promise<Entry[] | null> {
    const h = await this.dir(dir);
    if (!h) return null;
    const out: Entry[] = [];
    for await (const e of (h as any).values() as AsyncIterable<FileSystemHandle>) {
      if (e.kind === 'directory') out.push({ name: e.name, kind: 'dir', stamp: '' });
      else {
        const f = await (e as FileSystemFileHandle).getFile();
        out.push({ name: e.name, kind: 'file', stamp: `${f.lastModified}:${f.size}` });
      }
    }
    return out;
  }
  async read(path: string): Promise<string | null> {
    const [d, n] = this.split(path);
    const h = await this.dir(d);
    try {
      return h ? await (await h.getFileHandle(n)).getFile().then((f) => f.text()) : null;
    } catch {
      return null;
    }
  }
  async write(path: string, text: string): Promise<void> {
    const [d, n] = this.split(path);
    const h = await this.dir(d, true);
    if (!h) throw new Error(`no folder ${d}`);
    const w = await (await h.getFileHandle(n, { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }
}

/** The dev server's folder (vite-kanban.ts, KANBAN_ROOT): any browser, no picker. */
export class DevFolder implements Folder {
  constructor(
    readonly name: string,
    private base = '/__kanban',
  ) {}
  static async probe(base = '/__kanban'): Promise<DevFolder | null> {
    try {
      const r = await fetch(`${base}/info`);
      if (!r.ok) return null;
      const j = await r.json();
      return j?.enabled ? new DevFolder(String(j.name ?? 'dev folder'), base) : null;
    } catch {
      return null;
    }
  }
  async list(dir: string): Promise<Entry[] | null> {
    const r = await fetch(`${this.base}/list?path=${encodeURIComponent(dir)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`list ${dir}: ${r.status}`);
    return r.json();
  }
  async read(path: string): Promise<string | null> {
    const r = await fetch(`${this.base}/read?path=${encodeURIComponent(path)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`read ${path}: ${r.status}`);
    return r.text();
  }
  async write(path: string, text: string): Promise<void> {
    const r = await fetch(`${this.base}/write?path=${encodeURIComponent(path)}`, { method: 'PUT', body: text });
    if (!r.ok) throw new Error(`write ${path}: ${r.status} ${await r.text()}`);
  }
}

/** In memory (tests). `stamp` bumps on every write. */
export class MemFolder implements Folder {
  files = new Map<string, string>();
  private stamps = new Map<string, number>();
  private clock = 0;
  constructor(
    readonly name = 'mem',
    init: Record<string, string> = {},
  ) {
    for (const [k, v] of Object.entries(init)) this.put(k, v);
  }
  put(path: string, text: string) {
    this.files.set(path, text);
    this.stamps.set(path, ++this.clock);
  }
  async list(dir: string): Promise<Entry[] | null> {
    const pre = dir ? `${dir}/` : '';
    const names = new Map<string, Entry>();
    for (const p of this.files.keys()) {
      if (!p.startsWith(pre)) continue;
      const rest = p.slice(pre.length);
      const i = rest.indexOf('/');
      if (i < 0) names.set(rest, { name: rest, kind: 'file', stamp: String(this.stamps.get(p)) });
      else names.set(rest.slice(0, i), { name: rest.slice(0, i), kind: 'dir', stamp: '' });
    }
    return names.size || !dir ? [...names.values()] : null;
  }
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, text: string) {
    this.put(path, text);
  }
}

// ------------------------------------------------------------------ files source

const metaOf = (c: BoardConfig): Partial<BoardField> => ({ name: c.name, statuses: c.statuses, labels: c.labels, defaultStatus: c.defaultStatus });

/** Backlog.md project in a folder: either the project root (backlog/ + backlog.config.yml) or backlog/ itself. */
export class FilesSource implements Source {
  readonly kind = 'files';
  private dir: string | undefined;
  private configPath: string | undefined;
  private configStamp = '';
  private config: BoardConfig | undefined;
  /** path -> [stamp, parsed] */
  private cache = new Map<string, [string, PulledTask | null]>();

  constructor(readonly folder: Folder) {}
  get label() {
    return this.folder.name;
  }

  /** Find backlog/tasks; throws when the folder isn't a Backlog.md project. */
  private async locate() {
    if (this.dir !== undefined) return;
    const root = (await this.folder.list('')) ?? [];
    const has = (n: string, kind: Entry['kind']) => root.some((e) => e.name === n && e.kind === kind);
    if (has('tasks', 'dir')) {
      this.dir = '';
      this.configPath = has('config.yml', 'file') ? 'config.yml' : undefined;
    } else if (has('backlog', 'dir')) {
      this.dir = 'backlog';
      this.configPath = has('backlog.config.yml', 'file') ? 'backlog.config.yml' : 'backlog/config.yml';
    } else throw new Error('not a Backlog.md folder (no tasks/ or backlog/tasks/)');
  }
  private join(...p: string[]) {
    return p.filter(Boolean).join('/');
  }

  async read(): Promise<Snapshot | null> {
    await this.locate();
    let changed = false;
    // config
    if (this.configPath) {
      const parent = this.configPath.includes('/') ? this.configPath.slice(0, this.configPath.lastIndexOf('/')) : '';
      const e = (await this.folder.list(parent))?.find((x) => x.name === this.configPath!.split('/').pop());
      if (e && e.stamp !== this.configStamp) {
        const text = await this.folder.read(this.configPath);
        this.config = text ? parseConfig(text) : undefined;
        this.configStamp = e.stamp;
        changed = true;
      }
    }
    // tasks: re-read only files whose stamp changed
    const tdir = this.join(this.dir!, 'tasks');
    const entries = ((await this.folder.list(tdir)) ?? []).filter((e) => e.kind === 'file' && e.name.endsWith('.md'));
    const live = new Set<string>();
    for (const e of entries) {
      const path = this.join(tdir, e.name);
      live.add(path);
      if (this.cache.get(path)?.[0] === e.stamp) continue;
      changed = true;
      const text = await this.folder.read(path);
      const p = text ? parseTask(text) : null;
      this.cache.set(path, [e.stamp, p && { taskId: p.taskId, path, fields: strip(p), hashes: hashFields(strip(p)) }]);
    }
    for (const k of [...this.cache.keys()]) {
      if (live.has(k)) continue;
      this.cache.delete(k);
      changed = true;
    }
    if (!changed) return null;
    return {
      meta: this.config ? metaOf(this.config) : {},
      tasks: [...this.cache.values()].map(([, p]) => p).filter((p): p is PulledTask => !!p),
    };
  }

  async write(t: { taskId?: string; path?: string; fields: TaskFields }, dirty: FieldName[], ctx: WriteCtx) {
    await this.locate();
    if (!t.taskId || !t.path) {
      // new task: an id past every id in tasks/, archive/tasks/ and completed/ (never reuse an archived one)
      const ids = [...ctx.allIds];
      for (const d of ['archive/tasks', 'completed', 'archive/drafts']) for (const e of (await this.folder.list(this.join(this.dir!, d))) ?? []) ids.push(e.name);
      const taskId = t.taskId ?? nextTaskId(ids, this.config?.prefix);
      const path = this.join(this.dir!, 'tasks', taskFileName(taskId, t.fields.title));
      await this.folder.write(path, newTaskFile(taskId, t.fields, ctx.now));
      return { taskId, path };
    }
    const text = await this.folder.read(t.path);
    if (text === null) throw new Error(`${t.path} is gone`);
    const patch: Partial<TaskFields> = {};
    for (const k of dirty) (patch as Record<string, unknown>)[k] = t.fields[k];
    await this.folder.write(t.path, patchTask(text, patch, ctx.now));
    return { taskId: t.taskId, path: t.path };
  }
}

const strip = ({ taskId: _id, ...f }: TaskFields & { taskId?: string }): TaskFields => f;

// ------------------------------------------------------------------ service source

/** Task as GET /api/tasks returns it (the fields we use). */
interface ApiTask {
  id: string;
  title: string;
  status: string;
  labels?: string[];
  assignee?: string[];
  ordinal?: number;
  description?: string;
  filePath?: string;
}

/**
 * A running Backlog.md server. The browser can't call it cross-origin (no CORS headers), so the
 * page reaches it through a same-origin proxy (dev: Vite's /backlog-api). In the host model this is
 * the host's job: only it can reach the service.
 * Writes: PUT /api/tasks/:id (title, status, labels, assignee, description),
 * POST /api/tasks/reorder (ordinal), POST /api/tasks (create). Body here = the Description section.
 */
export class ServiceSource implements Source {
  readonly kind = 'service';
  private last = '';
  constructor(
    readonly label: string,
    private base = '/backlog-api',
  ) {}

  private async json(path: string, init?: RequestInit) {
    const r = await fetch(`${this.base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  async read(): Promise<Snapshot | null> {
    const [tasks, config] = (await Promise.all([this.json('/api/tasks?crossBranch=false'), this.json('/api/config')])) as [ApiTask[], Record<string, unknown>];
    const snap: Snapshot = {
      meta: {
        name: String(config.projectName ?? 'Backlog'),
        statuses: Array.isArray(config.statuses) ? (config.statuses as string[]) : undefined,
        labels: Array.isArray(config.labels) ? (config.labels as string[]) : undefined,
        defaultStatus: typeof config.defaultStatus === 'string' ? config.defaultStatus : undefined,
      },
      tasks: tasks.map((t) => {
        const fields = fromApi(t);
        return { taskId: t.id.toUpperCase(), path: t.filePath, fields, hashes: hashFields(fields) };
      }),
    };
    const key = JSON.stringify(snap);
    if (key === this.last) return null;
    this.last = key;
    return snap;
  }

  async write(t: { taskId?: string; fields: TaskFields }, dirty: FieldName[], ctx: WriteCtx) {
    const f = t.fields;
    if (!t.taskId) {
      const res = await this.json('/api/tasks', { method: 'POST', body: JSON.stringify({ title: f.title, status: f.status, labels: f.labels, assignee: f.assignee, description: f.body }) });
      const created = (res.task ?? res) as ApiTask;
      return { taskId: created.id.toUpperCase(), path: created.filePath };
    }
    const body: Record<string, unknown> = {};
    for (const k of dirty) {
      if (k === 'ordinal') continue;
      body[k === 'body' ? 'description' : k] = f[k];
    }
    if (Object.keys(body).length) await this.json(`/api/tasks/${encodeURIComponent(t.taskId)}`, { method: 'PUT', body: JSON.stringify(body) });
    if (dirty.includes('ordinal')) {
      const order = ctx.columnOrder(f.status);
      if (order.includes(t.taskId)) await this.json('/api/tasks/reorder', { method: 'POST', body: JSON.stringify({ taskId: t.taskId, targetStatus: f.status, orderedTaskIds: order }) });
    }
    return { taskId: t.taskId };
  }
}

function fromApi(t: ApiTask): TaskFields {
  return {
    title: t.title ?? '',
    status: t.status ?? '',
    labels: t.labels ?? [],
    assignee: t.assignee ?? [],
    ordinal: typeof t.ordinal === 'number' ? t.ordinal : undefined,
    body: t.description ?? '',
  };
}
