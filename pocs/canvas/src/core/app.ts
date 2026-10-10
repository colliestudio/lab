import './core.css';
import { registerCoreCommands } from './commands';
import type { CanvasNode, ParentOf } from './doc';
import type { KeyBinding, MenuItem, ObjectType, Plugin } from './plugin';
import { Store, type Command, type DispatchResult, type DocFilter } from './store';
import { View } from './view';
import { Viewport } from './viewport';
import type { Presence } from './presence';

/** Local player id. A constant until multiplayer gives each peer its own. */
export const LOCAL_PLAYER = 'local';

/** The host: store + viewport + view + what plugins registered. */
export class App {
  readonly store = new Store();
  readonly viewport = new Viewport();
  readonly types: ObjectType[] = [];
  readonly keys = new Map<string, KeyBinding>();
  readonly menu: MenuItem[] = [];
  readonly view: View;
  viewer = LOCAL_PLAYER;
  /** Set when the table is shared (multiplayer); null when playing solo. */
  presence: Presence | null = null;
  private notifiers = new Set<(msg: string) => void>();

  constructor(root: HTMLElement) {
    registerCoreCommands(this.store);
    this.view = new View(this, root);
    // zoom keys (handled before the browser's page zoom)
    const zin = { run: () => this.view.zoomCenter('in') };
    for (const key of ['mod+=', 'mod++', 'mod+shift+=', 'mod+shift++']) this.registerKey({ key, label: 'Zoom in', ...zin });
    for (const key of ['mod+-', 'mod+shift+-', 'mod+_', 'mod+shift+_']) this.registerKey({ key, label: 'Zoom out', run: () => this.view.zoomCenter('out') });
    this.registerKey({ key: 'mod+0', label: 'Zoom to 100%', run: () => this.view.zoomCenter(1) });
    // Figma: Shift+1 fit, Shift+2 selection, Shift+0 100%
    this.registerKey({ key: 'shift+0', label: 'Zoom to 100%', run: () => this.view.zoomCenter(1) });
    this.registerKey({ key: 'shift+1', label: 'Zoom to fit', run: () => this.view.fit() });
    this.registerKey({ key: 'shift+2', label: 'Zoom to selection', run: () => this.view.zoomToSelection() });
  }

  use(plugin: Plugin) {
    plugin.setup(this);
    this.view.render();
    return this;
  }

  // --- plugin API ---
  registerType(t: ObjectType) {
    this.types.push(t);
  }
  registerCommand<A>(name: string, cmd: Command<A>) {
    this.store.register(name, cmd);
  }
  registerKey(k: KeyBinding) {
    this.keys.set(k.key.toLowerCase(), k);
  }
  registerMenuItem(item: MenuItem) {
    this.menu.push(item);
  }
  /** Containment: contained nodes aren't rendered or selectable and are deleted with their parent. */
  registerParentRule(rule: ParentOf) {
    this.store.addParentRule(rule);
  }
  registerImportFilter(f: DocFilter) {
    this.store.importFilters.push(f);
  }
  registerExportFilter(f: DocFilter) {
    this.store.exportFilters.push(f);
  }

  /** Show a short message to the local user (toolbar status). */
  notify(msg: string) {
    for (const fn of this.notifiers) fn(msg);
  }
  onNotify(fn: (msg: string) => void) {
    this.notifiers.add(fn);
    return () => this.notifiers.delete(fn);
  }

  // --- helpers ---
  dispatch<A>(name: string, args: A, opts?: { merge?: boolean }): DispatchResult {
    return this.store.dispatch(name, args, opts);
  }
  get doc() {
    return this.store.doc;
  }
  node(id: string) {
    return this.store.doc.get(id);
  }
  /** Selected nodes in z-order (bottom first). */
  selected(): CanvasNode[] {
    const sel = this.store.selection;
    return this.store.doc.visible.filter((n) => sel.has(n.id));
  }
  typeOf(node: CanvasNode): ObjectType | undefined {
    return this.types.find((t) => t.match(node));
  }
}
