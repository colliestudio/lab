import './core.css';
import { registerCoreCommands } from './commands';
import { getNode, type CanvasNode } from './doc';
import type { KeyBinding, MenuItem, ObjectType, Plugin } from './plugin';
import { Store, type Command, type CommandResult } from './store';
import { View } from './view';
import { Viewport } from './viewport';

/** The host: store + viewport + view + what plugins registered. */
export class App {
  readonly store = new Store();
  readonly viewport = new Viewport();
  readonly types: ObjectType[] = [];
  readonly keys = new Map<string, KeyBinding>();
  readonly menu: MenuItem[] = [];
  readonly view: View;

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

  // --- helpers ---
  dispatch<A>(name: string, args: A): CommandResult {
    return this.store.dispatch(name, args);
  }
  get doc() {
    return this.store.doc;
  }
  node(id: string) {
    return getNode(this.store.doc, id);
  }
  /** Selected nodes in z-order (bottom first). */
  selected(): CanvasNode[] {
    const sel = this.store.selection;
    return this.store.doc.nodes.filter((n) => sel.has(n.id));
  }
  typeOf(node: CanvasNode): ObjectType | undefined {
    return this.types.find((t) => t.match(node));
  }
}
