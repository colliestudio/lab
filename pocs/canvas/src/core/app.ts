import './core.css';
import { registerCoreCommands } from './commands';
import type { CanvasNode, ParentOf } from './doc';
import type { KeyBinding, MenuItem, ObjectType, Plugin } from './plugin';
import { Store, type Command, type DispatchResult, type DocFilter } from './store';
import { View } from './view';
import { Viewport } from './viewport';

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

  constructor(root: HTMLElement) {
    registerCoreCommands(this.store);
    this.view = new View(this, root);
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
