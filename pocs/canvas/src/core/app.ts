import './core.css';
import { registerCoreCommands } from './commands';
import type { CanvasEdge, CanvasNode, CarrierOf, DocView, DuplicateRule, LayoutRule, ParentOf } from './doc';
import type { DockItem, KeyBinding, Kit, MainMenuItem, MenuItem, MenuProvider, ObjectType, Plugin, Tool } from './plugin';
import { Registry } from './registry';
import { registerCoreChrome } from './chromeView';
import { Store, type Command, type DispatchResult, type DocFilter } from './store';
import { View } from './view';
import { Viewport } from './viewport';
import type { PlayerInfo, Presence } from './presence';
import type { EventSpec } from './log';

/** Local player id. A constant until multiplayer gives each peer its own. */
export const LOCAL_PLAYER = 'local';
/** A viewer id that is nobody: "hidden from OTHERS" = hidden from every other player. */
export const OTHERS = '\u0000others';

/** The host: store + viewport + view + what plugins registered. */
export class App {
  readonly store = new Store();
  readonly viewport = new Viewport();
  readonly types: ObjectType[] = [];
  readonly keys = new Map<string, KeyBinding>();
  readonly menu: MenuItem[] = [];
  readonly menuProviders: MenuProvider[] = [];
  /** Creation tools (toolbar buttons), in registration order. */
  readonly tools: Tool[] = [];
  /** A double-click on the empty table (`at` = world point). First handler that returns true wins. */
  readonly emptyDoubleClicks: ((at: { x: number; y: number }, app: App) => boolean | void)[] = [];
  /** ⌘C: plain copies of the selected nodes and the arrows between them, for ⌘V. */
  clipboard: { nodes: CanvasNode[]; edges: CanvasEdge[]; pastes: number } | null = null;
  /** Kits for the Add menu, in registration order. */
  readonly kits: Kit[] = [];
  /** Buttons of the bottom dock, and rows of the main menu (top-left). */
  readonly dock = new Registry<DockItem>();
  readonly mainMenu = new Registry<MainMenuItem>();
  /** Run when the whole table was replaced (New board, Open, drop a file). */
  readonly tableReplacedHooks: ((app: App) => void)[] = [];
  /** Run when the local player changes name or color (see `registerRenameHook`). */
  readonly renameHooks: ((app: App, me: PlayerInfo) => void)[] = [];
  readonly view: View;
  viewer = LOCAL_PLAYER;
  /** A page that only looks (the screenshot page): nothing dispatched from here, timers included, changes the board. */
  readOnly = false;
  /** Peers whose cursor and selection are not drawn (the agent view hides its own seat). */
  hidePeer: (id: string) => boolean = () => false;
  /**
   * What keeps this page's board: a canvas serve ('served'), a bridge ('bridge'), or nothing (null: a local board or a room).
   * Plugins whose data lives outside the doc (a kanban node syncing a folder) work only on 'served'.
   */
  hosted: 'served' | 'bridge' | null = null;
  /** Set when the table is shared (multiplayer); null when playing solo. */
  presence: Presence | null = null;
  /** This device's player when solo (in a room: presence.me). */
  player: PlayerInfo = { id: LOCAL_PLAYER, name: 'Me', color: '#888888' };
  private notifiers = new Set<(msg: string) => void>();
  /** Privacy rules: is `node` hidden from `viewer` (its content must not leak via presence either)? */
  readonly edgeOwners: ((e: CanvasEdge, doc: DocView) => boolean)[] = [];
  readonly hiders: ((node: CanvasNode, viewer: string) => boolean)[] = [];
  /** Where others see my pointer: a rule may park it (e.g. over my private cards → at my hand's tab). */
  readonly cursorRules: ((p: { x: number; y: number }, app: App) => { x: number; y: number } | undefined)[] = [];

  constructor(root: HTMLElement) {
    registerCoreCommands(this.store);
    this.store.actor = () => this.me();
    this.store.onUndoRefused = (why) => this.notify(why);
    this.view = new View(this, root);
    // zoom keys (handled before the browser's page zoom)
    const zin = { run: () => this.view.zoomCenter('in') };
    for (const key of ['mod+=', 'mod++', 'mod+shift+=', 'mod+shift++']) this.registerKey({ key, label: 'Zoom in', ...zin });
    for (const key of ['mod+-', 'mod+shift+-', 'mod+_', 'mod+shift+_']) this.registerKey({ key, label: 'Zoom out', run: () => this.view.zoomCenter('out') });
    this.registerKey({ key: 'mod+0', label: 'Zoom to 100%', run: () => this.view.zoomCenter(1) });
    // Figma: Shift+1 fit, Shift+2 selection, Shift+0 100%
    this.registerKey({ key: 'shift+0', label: 'Zoom to 100%', run: () => this.view.zoomCenter(1) });
    this.registerKey({ key: 'shift+1', label: 'Zoom to fit', run: () => this.view.fit() });
    this.registerKey({ key: 'mod+d', label: 'Duplicate', run: () => this.dispatch('core.duplicate', { ids: [...this.store.selection] }) });
    this.registerKey({ key: 'shift+2', label: 'Zoom to selection', run: () => this.view.zoomToSelection() });
    // only with something to copy / paste: else the browser's own copy of selected page text runs
    this.registerKey({ key: 'mod+c', label: 'Copy', when: () => this.selected().length > 0 && !getSelection()?.toString(), run: () => this.copy() });
    this.registerKey({ key: 'mod+v', label: 'Paste', when: () => !!this.clipboard, run: () => this.paste() });
    registerCoreChrome(this);
  }

  /** Remember the selected nodes (as ⌘D would copy them) and the arrows between them. */
  copy(): boolean {
    const doc = this.store.doc;
    const nodes: CanvasNode[] = [];
    for (const n of this.selected()) {
      if (doc.parentOf(n.id)) continue;
      let copy: CanvasNode | null | undefined;
      for (const rule of this.store.duplicateRules) if ((copy = rule(n, doc, () => undefined)) !== undefined) break;
      if (copy !== null) nodes.push(structuredClone(copy ?? n));
    }
    if (!nodes.length) return false;
    const ids = new Set(nodes.map((n) => n.id));
    const edges = doc.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode)).map((e) => structuredClone(e));
    this.clipboard = { nodes, edges, pastes: 0 };
    this.notify(nodes.length === 1 ? 'Copied' : `Copied ${nodes.length} objects`);
    return true;
  }

  /** Put the copied objects on the table, a little further down-right each time. */
  paste() {
    const c = this.clipboard;
    if (!c) return;
    const k = ++c.pastes;
    this.dispatch('core.paste', { nodes: c.nodes, edges: c.edges, dx: 24 * k, dy: 24 * k });
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
  /** A plain right-click row (context action). Returns a disposer. */
  registerMenuItem(item: MenuItem) {
    this.menu.push(item);
    return () => void remove(this.menu, item);
  }
  /** Context actions: the right-click menu built per selection (submenus, checkmarks, disabled reasons). Returns a disposer. */
  registerMenu(provider: MenuProvider) {
    this.menuProviders.push(provider);
    return () => void remove(this.menuProviders, provider);
  }
  /** A button in the bottom dock. Returns a disposer. */
  registerDockItem(item: DockItem) {
    return this.dock.add(item);
  }
  /** A row in the main menu (top-left); see `MainMenuItem` for where it lands. Returns a disposer. */
  registerMainMenuItem(item: MainMenuItem) {
    return this.mainMenu.add(item);
  }
  /** Run after the shell replaced the table (New, Open): drop per-table state such as a plugin's mode. */
  onTableReplaced(fn: (app: App) => void) {
    this.tableReplacedHooks.push(fn);
  }
  tableReplaced() {
    for (const fn of this.tableReplacedHooks) fn(this);
  }
  /** Called after the local player renamed or recolored (cards relabel their hand). */
  registerRenameHook(fn: (app: App, me: PlayerInfo) => void) {
    this.renameHooks.push(fn);
  }
  /** The shell calls this after saving a new name or color. */
  playerRenamed(me: PlayerInfo) {
    for (const fn of this.renameHooks) fn(this, me);
  }
  /** Containment: contained nodes aren't rendered or selectable and are deleted with their parent. */
  registerParentRule(rule: ParentOf) {
    this.store.addParentRule(rule);
  }
  /** Riders: nodes that move and come to front with their carrier, but stay separate objects. */
  registerRiderRule(rule: CarrierOf) {
    this.store.addRiderRule(rule);
  }
  /** Shape or refuse copies made by Duplicate (⌘D). */
  registerDuplicateRule(rule: DuplicateRule) {
    this.store.duplicateRules.push(rule);
  }
  /** A command that puts this plugin's objects back in their starting state (Reset table). */
  registerReset(cmd: Command) {
    this.store.resets.push(cmd);
  }
  /** A creation tool: toolbar button and key; the next press-drag on the table calls `create`. */
  registerTool(tool: Tool) {
    this.tools.push(tool);
  }
  /** React to a double-click on the empty table. */
  registerEmptyDoubleClick(fn: (at: { x: number; y: number }, app: App) => boolean | void) {
    this.emptyDoubleClicks.push(fn);
  }
  registerKit(kit: Kit) {
    this.kits.push(kit);
    this.dock.touch(); // the dock's Add button shows once there is a kit
  }
  /** Layouts place contained nodes (fanned hands, rows...); derived on read, never stored. */
  registerLayout(rule: LayoutRule) {
    this.store.addLayout(rule);
  }
  registerImportFilter(f: DocFilter) {
    this.store.importFilters.push(f);
  }
  registerExportFilter(f: DocFilter) {
    this.store.exportFilters.push(f);
  }

  /** The local player: who log entries name. */
  me(): PlayerInfo {
    return this.presence?.me ?? this.player;
  }
  /** Log events that no command reports (see log.ts); not an undo step. */
  logEvents(events: EventSpec[]) {
    if (this.readOnly) return;
    this.store.appendLog(events);
  }

  /** Show a short message to the local user (shown above the dock). */
  notify(msg: string) {
    for (const fn of this.notifiers) fn(msg);
  }
  onNotify(fn: (msg: string) => void) {
    this.notifiers.add(fn);
    return () => this.notifiers.delete(fn);
  }

  /** A rule saying a node is hidden from a viewer: no presence outlines on it, never broadcast. */
  registerHider(fn: (node: CanvasNode, viewer: string) => boolean) {
    this.hiders.push(fn);
  }
  /** Claim edges a plugin draws itself; core's edge layer skips them, so every edge has one renderer. */
  registerEdgeRenderer(owns: (e: CanvasEdge, doc: DocView) => boolean) {
    this.edgeOwners.push(owns);
  }
  /** Is this edge drawn by a plugin rather than core? */
  edgeOwned(e: CanvasEdge): boolean {
    const doc = this.store.doc;
    return this.edgeOwners.some((f) => f(e, doc));
  }
  registerCursorRule(fn: (p: { x: number; y: number }, app: App) => { x: number; y: number } | undefined) {
    this.cursorRules.push(fn);
  }
  /** Is `node` hidden from `viewer`? `OTHERS` = from every other player (what may I broadcast?). */
  hiddenFrom(node: CanvasNode, viewer: string = this.viewer): boolean {
    return this.hiders.some((f) => f(node, viewer));
  }
  /** Ids safe to tell other players about (selection, held). */
  publicIds(ids: Iterable<string>): string[] {
    return [...ids].filter((id) => {
      const n = this.node(id);
      return !n || !this.hiddenFrom(n, OTHERS);
    });
  }
  /** My pointer as others may see it. */
  publicCursor(p: { x: number; y: number }) {
    for (const r of this.cursorRules) {
      const q = r(p, this);
      if (q) return q;
    }
    return p;
  }
  /** Not rendered for the local viewer (see ObjectType.concealed). */
  isConcealed(n: CanvasNode): boolean {
    return !!this.typeOf(n)?.concealed?.(n, { doc: this.store.doc, viewer: this.viewer });
  }

  /** Can a drag / nudge move this node (ObjectType.movable)? */
  canMove(id: string): boolean {
    const n = this.node(id);
    return !!n && this.typeOf(n)?.movable?.(n, this) !== false;
  }
  /** Does a box selection pick this node up (ObjectType.boxSelectable)? */
  boxSelectable(n: CanvasNode): boolean {
    return this.typeOf(n)?.boxSelectable?.(n, this) !== false;
  }

  // --- helpers ---
  dispatch<A>(name: string, args: A, opts?: { merge?: boolean; undoable?: boolean }): DispatchResult {
    if (this.readOnly) return { ok: false, error: 'this view is read-only', changes: [] };
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
  /** World point at the middle of the visible table. */
  viewCenter(): { x: number; y: number } {
    const r = this.view.root;
    const [x, y] = this.viewport.toWorld(r.clientWidth / 2, r.clientHeight / 2);
    return { x: Math.round(x), y: Math.round(y) };
  }
}

function remove<T>(list: T[], item: T) {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}
