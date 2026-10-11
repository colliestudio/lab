import type { App, CanvasNode, MenuEntry } from '../core';
import { has, hashSource, parseManifest, type Manifest } from './manifest';
import { checkResult, nsOf, readableDoc } from './policy';
import { escapeHtml, treeToHtml, type RenderTree } from './tree';

// Host side of the plugin bridge. A third-party plugin runs in a sandbox (an iframe in the browser,
// in-process in tests) and only talks to the app through messages: the host turns what the plugin
// declares (types, kits, menu entries) into regular in-process registrations, and every call into
// the plugin (a command, a render) is async request/response over plain data. The host checks
// every result against the plugin's capabilities before it touches the doc.
//
// Room-level trust: the room's doc lists its plugins (manifest + code + hash, meta `x-plugins`), so
// every peer loads the same set from the doc itself. Each device still approves a plugin (by hash)
// before its code runs there; until then its nodes show their plain JSON Canvas text.

// ---------------------------------------------------------------- protocol

export interface DeclType {
  id: string;
  /** data-action name → command name (called with { ids: [node.id], action }). */
  actions: Record<string, string>;
}
export interface DeclKit {
  id: string;
  label: string;
  command: string;
}
export interface DeclMenu {
  label: string;
  command: string;
  /** Only when every selected node is this plugin type; undefined = any selection (even none). */
  type?: string;
  min?: number;
  max?: number;
  /** Put the entry in a submenu of this name. */
  group?: string;
  /** Ask the user for a line of text first (the host shows the prompt); passed as `args.input`. */
  prompt?: string;
  args?: Record<string, unknown>;
}
export interface Decl {
  types: DeclType[];
  commands: string[];
  kits: DeclKit[];
  menu: DeclMenu[];
}
export interface CallCtx {
  viewer: string;
  actor: { id: string; name: string };
  now: number;
}
export type ToSandbox =
  | { t: 'call'; id: number; fn: 'command'; name: string; args: unknown; doc: { nodes: CanvasNode[] }; ctx: CallCtx }
  | { t: 'call'; id: number; fn: 'render'; type: string; node: CanvasNode; ctx: CallCtx };
export type FromSandbox =
  | { t: 'ready'; decl: Decl }
  | { t: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'violation'; text: string }
  | { t: 'fail'; error: string };

/** A running sandbox: how the host reaches one plugin. */
export interface Transport {
  send(m: ToSandbox): void;
  onMessage(fn: (m: FromSandbox) => void): void;
  destroy(): void;
}
export type MakeTransport = (manifest: Manifest, source: string) => Transport;

/** A plugin as the room records it (meta `x-plugins`): enough for any peer to load the same code. */
export interface RoomPlugin {
  manifest: Manifest;
  hash: string;
  source: string;
  /** Where it was installed from (display only; the source above is what runs). */
  from?: string;
  addedBy?: string;
}

export const META_KEY = 'x-plugins';
export const APPLY = 'ext.apply';
const TIMEOUT = 2000;

export type Status = 'running' | 'loading' | 'awaiting approval' | 'failed';
export interface Notice {
  plugin: string;
  kind: 'denied' | 'error' | 'info';
  text: string;
  time: number;
}

/** Device-local approvals (hashes this device agreed to run). */
export interface Approvals {
  has(hash: string): boolean;
  add(hash: string): void;
  remove(hash: string): void;
}
export function memoryApprovals(): Approvals {
  const s = new Set<string>();
  return { has: (h) => s.has(h), add: (h) => void s.add(h), remove: (h) => void s.delete(h) };
}

// ---------------------------------------------------------------- one loaded plugin

class Loaded {
  decl: Decl | undefined;
  status: Status = 'loading';
  error?: string;
  private seq = 0;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private ready: Promise<Decl>;
  /** Undo hooks of what was registered into the app. */
  cleanup: (() => void)[] = [];
  /** node id → last render (key = node content it was made for). */
  renders = new Map<string, { key: string; html: string }>();
  rendering = new Set<string>();

  constructor(
    readonly entry: RoomPlugin,
    readonly transport: Transport,
    onNotice: (n: Omit<Notice, 'time' | 'plugin'>) => void,
  ) {
    let ready!: (d: Decl) => void;
    let failed!: (e: Error) => void;
    this.ready = new Promise<Decl>((res, rej) => ((ready = res), (failed = rej)));
    const bootTimer = setTimeout(() => failed(new Error('did not start in time')), TIMEOUT * 2);
    transport.onMessage((m) => {
      if (m.t === 'ready') {
        clearTimeout(bootTimer);
        this.decl = m.decl;
        this.status = 'running';
        ready(m.decl);
      } else if (m.t === 'fail') {
        clearTimeout(bootTimer);
        failed(new Error(m.error));
      } else if (m.t === 'violation') onNotice({ kind: 'denied', text: `sandbox blocked: ${m.text}` });
      else if (m.t === 'reply') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error ?? 'failed'));
      }
    });
    this.ready.catch((e: Error) => {
      this.status = 'failed';
      this.error = e.message;
    });
  }

  get id() {
    return this.entry.manifest.id;
  }
  get manifest() {
    return this.entry.manifest;
  }
  started() {
    return this.ready;
  }

  call(m: Omit<Extract<ToSandbox, { fn: 'command' }>, 'id' | 't'> | Omit<Extract<ToSandbox, { fn: 'render' }>, 'id' | 't'>): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer within ${TIMEOUT} ms`));
      }, TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ ...m, t: 'call', id } as ToSandbox);
    });
  }

  destroy() {
    for (const f of this.cleanup.splice(0)) f();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.transport.destroy();
  }
}

/** What renders depend on: the node minus position (moves don't re-render). */
const contentKey = (n: CanvasNode, viewer: string) => {
  const { x: _x, y: _y, z: _z, ...rest } = n;
  return viewer + '\n' + JSON.stringify(rest);
};

// ---------------------------------------------------------------- the host

export class PluginHost {
  readonly loaded = new Map<string, Loaded>();
  readonly notices: Notice[] = [];
  private listeners = new Set<() => void>();
  private syncing = Promise.resolve();

  constructor(
    readonly app: App,
    private makeTransport: MakeTransport,
    readonly approvals: Approvals = memoryApprovals(),
  ) {
    // The one store command every external plugin's results go through: re-checked against the
    // doc at apply time (sync, inside the dispatch), so the undo step and log entry are the core's.
    app.registerCommand(APPLY, (doc, a: { plugin: string; result: unknown; command: string }) => {
      const p = this.loaded.get(a?.plugin);
      if (!p) return [];
      const r = checkResult(p.manifest, doc, a.result);
      for (const d of r.denied) this.notice(p.id, 'denied', `${a.command}: ${d}`);
      return { changes: r.changes, events: r.events, select: r.select };
    });
    app.store.meta.observe(() => this.sync());
  }

  // ------------------------------------------------------------ room list

  /** Plugins the room uses (from the doc: synced, saved with the file). */
  roomPlugins(): RoomPlugin[] {
    const v = this.app.store.meta.get(META_KEY);
    if (!Array.isArray(v)) return [];
    // Any peer can write this list: validate every entry as untrusted (a reserved id like `cards`
    // would own the cards' nodes; a bad id or name would reach class names and HTML).
    const out: RoomPlugin[] = [];
    for (const e of v as Partial<RoomPlugin>[]) {
      try {
        if (!e || typeof e.hash !== 'string' || typeof e.source !== 'string') continue;
        const manifest = parseManifest(e.manifest);
        out.push({ manifest, hash: e.hash, source: e.source, from: typeof e.from === 'string' ? e.from : undefined, addedBy: typeof e.addedBy === 'string' ? e.addedBy : undefined });
      } catch {
        // invalid entries are ignored
      }
    }
    return out;
  }

  status(id: string): Status {
    const p = this.loaded.get(id);
    if (p) return p.status;
    const e = this.roomPlugins().find((r) => r.manifest.id === id);
    return e && !this.approvals.has(e.hash) ? 'awaiting approval' : 'loading';
  }

  /**
   * Add a plugin to the room (approved on this device). Replaces an older version with the same id.
   * `manifestJson` is untrusted: validated before anything runs.
   */
  async install(manifestJson: unknown, source: string, from?: string): Promise<RoomPlugin> {
    const manifest = parseManifest(manifestJson);
    const hash = await hashSource(source);
    const entry: RoomPlugin = { manifest, hash, source, from, addedBy: this.app.me().name };
    this.approvals.add(hash);
    const list = this.roomPlugins().filter((p) => p.manifest.id !== manifest.id);
    this.app.store.ydoc.transact(() => this.app.store.meta.set(META_KEY, [...list, entry]));
    await this.sync();
    return entry;
  }

  /** Remove a plugin from the room (its nodes stay, shown as their plain text). */
  uninstall(id: string) {
    const list = this.roomPlugins().filter((p) => p.manifest.id !== id);
    this.app.store.ydoc.transact(() => this.app.store.meta.set(META_KEY, list));
  }

  /** This device agrees to run a plugin the room lists. */
  approve(hash: string) {
    this.approvals.add(hash);
    return this.sync();
  }

  /** Load what the room lists and this device approved; unload the rest. Serialized. */
  sync(): Promise<void> {
    this.syncing = this.syncing.then(() => this.reconcile()).catch((e) => console.warn('plugins:', e));
    return this.syncing;
  }

  private async reconcile() {
    const want = new Map(this.roomPlugins().filter((p) => this.approvals.has(p.hash)).map((p) => [p.manifest.id, p]));
    for (const [id, p] of this.loaded) {
      if (want.get(id)?.hash === p.entry.hash) continue;
      p.destroy();
      this.loaded.delete(id);
      this.notice(id, 'info', 'unloaded');
    }
    for (const [id, entry] of want) {
      if (this.loaded.has(id)) continue;
      // the code must match the hash the room pinned
      if ((await hashSource(entry.source)) !== entry.hash) {
        this.notice(id, 'error', 'code does not match its hash: not loaded');
        continue;
      }
      const p = new Loaded(entry, this.makeTransport(entry.manifest, entry.source), (n) => this.notice(id, n.kind, n.text));
      this.loaded.set(id, p);
      this.emit();
      try {
        this.register(p, await p.started());
        this.notice(id, 'info', `loaded ${entry.manifest.name} ${entry.manifest.version}`);
      } catch (e) {
        this.notice(id, 'error', `failed to start: ${(e as Error).message}`);
      }
    }
    this.app.view.render();
    this.emit();
  }

  // ------------------------------------------------------------ registration

  /** Turn a plugin's declarations into in-process registrations (only what its capabilities allow). */
  private register(p: Loaded, decl: Decl) {
    const app = this.app;
    const m = p.manifest;
    const ns = nsOf(m);
    const types = Array.isArray(decl.types) ? decl.types : [];
    for (const t of types) {
      const match = (n: CanvasNode) => {
        const d = n[ns] as { kind?: string } | undefined;
        return !!d && typeof d === 'object' && (d.kind === t.id || (types.length === 1 && d.kind === undefined));
      };
      const type = {
        id: `${m.id}.${t.id}`,
        match,
        renderKey: (n: CanvasNode) => {
          const key = contentKey(n, app.viewer);
          const have = p.renders.get(n.id);
          if (have?.key !== key) this.requestRender(p, t.id, n, key);
          return key + (have?.key === key ? '\nready' : '\npending');
        },
        render: (n: CanvasNode, el: HTMLElement) => {
          const have = p.renders.get(n.id);
          el.classList.add('px-node');
          // a stale render beats a blank box while the new one is on its way
          el.innerHTML = have?.html ?? `<div class="px-pending">${escapeHtml(m.name)}…</div>`;
        },
        onAction: (n: CanvasNode, action: string) => {
          const cmd = t.actions?.[action];
          if (cmd) void this.run(m.id, cmd, { ids: [n.id], action });
        },
      };
      app.registerType(type);
      p.cleanup.push(() => remove(app.types, type));
    }
    const kits = Array.isArray(decl.kits) ? decl.kits : [];
    if (kits.length && !has(m, 'ui:kit')) this.notice(m.id, 'denied', `${kits.length} Add-menu kit(s) ignored: needs ui:kit`);
    else
      for (const k of kits) {
        const kit = { id: `${m.id}.${k.id}`, label: `${k.label}`, create: (_a: App, at: { x: number; y: number }) => void this.run(m.id, k.command, at) };
        app.registerKit(kit);
        p.cleanup.push(() => remove(app.kits, kit));
      }
    const menu = Array.isArray(decl.menu) ? decl.menu : [];
    if (menu.length && !has(m, 'ui:menu')) this.notice(m.id, 'denied', `${menu.length} menu item(s) ignored: needs ui:menu`);
    else if (menu.length) {
      const typeIds = new Map(types.map((t) => [t.id, app.types.find((x) => x.id === `${m.id}.${t.id}`)]));
      const provider = (_a: App, sel: CanvasNode[]) => {
        const ids = sel.map((n) => n.id);
        const fits = (e: DeclMenu) => {
          if (e.min !== undefined && sel.length < e.min) return false;
          if (e.max !== undefined && sel.length > e.max) return false;
          if (e.type === undefined) return true;
          const t = typeIds.get(e.type);
          return sel.length > 0 && !!t && sel.every((n) => t.match(n));
        };
        const entries: MenuEntry[] = [];
        const groups = new Map<string, MenuEntry[]>();
        for (const e of menu.filter(fits)) {
          const run = () => {
            let input: string | undefined;
            if (e.prompt) {
              const v = prompt(e.prompt, sel.length === 1 ? (sel[0].text ?? '') : '');
              if (v === null) return;
              input = v;
            }
            void this.run(m.id, e.command, { ...e.args, ids, at: app.viewCenter(), input });
          };
          const entry: MenuEntry = { label: e.label, run };
          if (!e.group) entries.push(entry);
          else {
            let g = groups.get(e.group);
            if (!g) groups.set(e.group, (g = []));
            g.push(entry);
          }
        }
        for (const [label, items] of groups) entries.push({ label, items });
        return entries.length ? { title: undefined, entries } : undefined;
      };
      app.registerMenu(provider);
      p.cleanup.push(() => remove(app.menuProviders, provider));
    }
    // forget renders of deleted nodes now and then
    const off = app.store.subscribe(() => {
      for (const id of p.renders.keys()) if (!app.node(id)) p.renders.delete(id);
    });
    p.cleanup.push(() => void off());
  }

  private requestRender(p: Loaded, type: string, n: CanvasNode, key: string) {
    if (p.rendering.has(key + n.id)) return;
    p.rendering.add(key + n.id);
    p.call({ fn: 'render', type, node: structuredClone(n), ctx: this.callCtx() })
      .then((tree) => {
        p.renders.set(n.id, { key, html: treeToHtml(tree as RenderTree, p.id) });
        this.app.view.render();
      })
      .catch((e: Error) => {
        p.renders.set(n.id, { key, html: `<div class="px-error">${escapeHtml(p.manifest.name)}: render failed</div>` });
        this.notice(p.id, 'error', `render: ${e.message}`);
        this.app.view.render();
      })
      .finally(() => p.rendering.delete(key + n.id));
  }

  private callCtx(): CallCtx {
    const me = this.app.me();
    return { viewer: this.app.viewer, actor: { id: me.id, name: me.name }, now: Date.now() };
  }

  // ------------------------------------------------------------ commands

  /**
   * Run a plugin command: send it what it may read, wait for its plain-data result, apply that
   * through the core (capability-checked, one undo step). Resolves to the denials (empty = applied).
   */
  async run(pluginId: string, command: string, args: unknown): Promise<{ ok: boolean; denied: string[] }> {
    const p = this.loaded.get(pluginId);
    if (!p || p.status !== 'running') return { ok: false, denied: [`${pluginId} is not running`] };
    const doc = readableDoc(p.manifest, this.app.doc, (n) => this.app.hiddenFrom(n));
    let result: unknown;
    try {
      result = await p.call({ fn: 'command', name: command, args: structuredClone(args), doc, ctx: this.callCtx() });
    } catch (e) {
      this.notice(pluginId, 'error', `${command}: ${(e as Error).message}`);
      return { ok: false, denied: [] };
    }
    const before = this.notices.length;
    const r = this.app.dispatch(APPLY, { plugin: pluginId, command, result });
    const denied = this.notices.slice(before).filter((n) => n.kind === 'denied').map((n) => n.text);
    return { ok: r.ok && !denied.length, denied };
  }

  // ------------------------------------------------------------ notices

  private notice(plugin: string, kind: Notice['kind'], text: string) {
    this.notices.push({ plugin, kind, text, time: Date.now() });
    if (this.notices.length > 100) this.notices.shift();
    if (kind === 'denied') this.app.notify(`Plugin ${plugin}: denied (${text})`);
    if (kind === 'error') this.app.notify(`Plugin ${plugin}: ${text}`);
    this.emit();
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  destroy() {
    for (const p of this.loaded.values()) p.destroy();
    this.loaded.clear();
  }
}

function remove<T>(list: T[], item: T) {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}

/** Tests / trusted dev: run a plugin module in this realm (no isolation), same protocol. */
export function inProcessTransport(load: (source: string) => unknown, createRuntime: (plugin: unknown, post: (m: FromSandbox) => void) => { handle(m: ToSandbox): Promise<void> }): MakeTransport {
  return (_manifest, source) => {
    let fn: (m: FromSandbox) => void = () => {};
    let dead = false;
    let rt: { handle(m: ToSandbox): Promise<void> } | undefined;
    queueMicrotask(() => {
      if (dead) return;
      rt = createRuntime(load(source), (m) => !dead && queueMicrotask(() => fn(structuredClone(m))));
    });
    return {
      send: (m) => queueMicrotask(() => !dead && rt?.handle(structuredClone(m))),
      onMessage: (f) => (fn = f),
      destroy: () => (dead = true),
    };
  };
}
