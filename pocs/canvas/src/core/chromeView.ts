import type { App } from './app';
import { icon } from './icons';
import type { DockItem, MenuEntry } from './plugin';

// The app's chrome: a small main menu with the breadcrumb (top-left), the people / chat / share
// cluster (top-right), the dock of tools (bottom-center) and zoom + help (bottom-right). Core and
// plugins fill the dock and the menu through app.registerDockItem / app.registerMainMenuItem; this
// file only draws what is registered.

/** Dock sections in order; sections nobody listed go before the last. */
const DOCK_SECTIONS = ['tools', 'create', 'add'];
/** Main-menu submenus in order; other groups follow in registration order, ungrouped rows last. */
const MENU_GROUPS = ['File', 'Edit', 'Room', 'Add'];

/** An icon button with a tooltip (name and shortcut), the look every chrome button shares. */
export function chromeButton(iconName: string, label: string, shortcut?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cv-btn';
  b.setAttribute('aria-label', label);
  b.dataset.tip = shortcut ? `${label}  ${shortcut}` : label;
  b.append(icon(iconName));
  // after a pointer click the button gives focus back, so Space / Enter on the table don't press it again
  b.addEventListener('click', (e) => {
    if (e.detail > 0) b.blur();
  });
  return b;
}

/** One entry per kit, each putting its kit at the middle of the view. */
export function kitEntries(app: App): MenuEntry[] {
  return app.kits.map((k) => ({ label: k.label, run: () => k.create(app, app.viewCenter()) }));
}

/** What core itself puts in the dock and the main menu. */
export function registerCoreChrome(app: App) {
  app.registerDockItem({ id: 'core.select', label: 'Select', icon: 'mouse-pointer-2', shortcut: 'V', section: 'tools', active: (a) => a.view.tool === 'select', run: (a) => a.view.setTool('select') });
  app.registerDockItem({ id: 'core.hand', label: 'Hand', icon: 'hand', shortcut: 'H · hold Space', section: 'tools', active: (a) => a.view.tool === 'hand', run: (a) => a.view.setTool('hand') });
  app.registerDockItem({
    id: 'core.add',
    label: 'Add to the table',
    icon: 'plus',
    section: 'add',
    when: (a) => a.kits.length > 0,
    run: (a, button) => {
      if (a.view.menuAnchor === button) a.view.closeMenu();
      else a.view.openMenu(kitEntries(a), button, 'Add to the table', { above: true });
    },
  });
  app.registerMainMenuItem({ id: 'core.undo', group: 'Edit', order: 0, entry: (a) => ({ label: 'Undo', hint: '⌘Z', run: () => a.store.undo() }) });
  app.registerMainMenuItem({ id: 'core.redo', group: 'Edit', order: 1, entry: (a) => ({ label: 'Redo', hint: '⇧⌘Z', run: () => a.store.redo() }) });
  app.registerMainMenuItem({ id: 'core.add', group: 'Add', when: (a) => a.kits.length > 0, entry: kitEntries });
}

/** The main menu's rows now: submenus per group (File, Edit, Room, Add, then plugins'), then ungrouped rows. */
export function buildMainMenu(app: App): MenuEntry[] {
  const groups = new Map<string, MenuEntry[]>();
  const top: MenuEntry[] = [];
  for (const item of app.mainMenu.list()) {
    if (item.when && !item.when(app)) continue;
    const rows = [item.entry(app)].flat();
    if (!item.group) top.push(...rows);
    else groups.set(item.group, [...(groups.get(item.group) ?? []), ...rows]);
  }
  const names = [...MENU_GROUPS.filter((g) => groups.has(g)), ...[...groups.keys()].filter((g) => !MENU_GROUPS.includes(g))];
  const out: MenuEntry[] = names.filter((g) => groups.get(g)!.length).map((g) => ({ label: g, items: groups.get(g)! }));
  if (top.length) top[0] = { ...top[0], separator: out.length > 0 };
  return [...out, ...top];
}

export interface Chrome {
  topLeft: HTMLElement;
  topRight: HTMLElement;
  bottomRight: HTMLElement;
  dock: HTMLElement;
  /** Show a short message above the dock. */
  toast(msg: string): void;
}

export function mountChrome(app: App, parent: HTMLElement = document.body): Chrome {
  const region = (name: string) => {
    const e = document.createElement('div');
    e.className = `cv-chrome cv-${name}`;
    parent.append(e);
    return e;
  };
  const topLeft = region('top-left');
  const topRight = region('top-right');
  const dock = region('dock');
  const bottomRight = region('bottom-right');

  // ---- main menu
  const menuBtn = chromeButton('menu', 'Main menu');
  menuBtn.classList.add('cv-menu-btn');
  menuBtn.addEventListener('click', () => {
    if (app.view.menuAnchor === menuBtn) app.view.closeMenu();
    else app.view.openMenu(buildMainMenu(app), menuBtn);
  });
  topLeft.append(menuBtn);
  // the table closes menus on its own pointerdown; chrome sits outside it
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Element;
    const anchor = app.view.menuAnchor;
    if (anchor && !anchor.contains(t)) app.view.closeMenu();
  });

  // ---- dock
  type Entry = { item: DockItem; btn: HTMLButtonElement; sep: HTMLElement };
  let entries: Entry[] = [];
  const sync = () => {
    let prev: Entry | undefined;
    for (const en of entries) {
      const shown = !en.item.when || en.item.when(app);
      en.btn.hidden = !shown;
      en.sep.hidden = !(shown && prev && prev.item.section !== en.item.section);
      if (shown) prev = en;
      if (en.item.active) en.btn.setAttribute('aria-pressed', String(en.item.active(app)));
    }
    dock.hidden = !prev;
  };
  const render = () => {
    entries = app.dock.list(DOCK_SECTIONS).map((item) => {
      const btn = chromeButton(item.icon, item.label, item.shortcut);
      btn.dataset.dockId = item.id;
      btn.addEventListener('click', () => (item.when && !item.when(app) ? undefined : item.run(app, btn)));
      const sep = document.createElement('i');
      sep.className = 'cv-dock-sep';
      return { item, btn, sep };
    });
    dock.replaceChildren(...entries.flatMap((e) => [e.sep, e.btn]));
    sync();
  };
  app.dock.onChange(render);
  app.view.onToolChange(sync);
  app.store.subscribe(sync);
  render();

  // ---- toast
  const toastEl = document.createElement('div');
  toastEl.className = 'cv-toast';
  toastEl.hidden = true;
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  parent.append(toastEl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const toast = (msg: string) => {
    clearTimeout(timer);
    toastEl.textContent = msg;
    toastEl.hidden = !msg;
    timer = setTimeout(() => (toastEl.hidden = true), 2500);
  };
  app.onNotify(toast);

  return { topLeft, topRight, bottomRight, dock, toast };
}
