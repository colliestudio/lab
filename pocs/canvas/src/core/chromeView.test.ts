// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { buildMainMenu, mountChrome } from './chromeView';
import type { MenuEntry } from './plugin';

let roots: HTMLElement[] = [];
afterEach(() => {
  for (const r of roots) r.remove();
  roots = [];
  document.body.replaceChildren();
});
function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const app = new App(root);
  const chrome = mountChrome(app);
  return { app, root, chrome };
}
const dockIds = (chrome: { dock: HTMLElement }) => [...chrome.dock.querySelectorAll<HTMLElement>('button:not([hidden])')].map((b) => b.dataset.dockId);
const labels = (entries: MenuEntry[]) => entries.map((e) => e.label);
const sub = (entries: MenuEntry[], label: string) => {
  const e = entries.find((x) => x.label === label);
  return typeof e?.items === 'function' ? e.items() : (e?.items ?? []);
};
const kit = (id: string) => ({ id, label: `Kit ${id}`, create: vi.fn() });

describe('dock', () => {
  it('a core-only app has select and hand; + appears with the first kit', () => {
    const { app, chrome } = setup();
    expect(dockIds(chrome)).toEqual(['core.select', 'core.hand']);
    app.registerKit(kit('a'));
    expect(dockIds(chrome)).toEqual(['core.select', 'core.hand', 'core.add']);
  });
  it('buttons are icons with an accessible name and a tooltip naming the shortcut', () => {
    const { chrome } = setup();
    const sel = chrome.dock.querySelector<HTMLElement>('[data-dock-id="core.select"]')!;
    const hand = chrome.dock.querySelector<HTMLElement>('[data-dock-id="core.hand"]')!;
    expect(sel.getAttribute('aria-label')).toBe('Select');
    expect(sel.dataset.tip).toContain('V');
    expect(hand.dataset.tip).toContain('hold Space');
    expect(sel.querySelector('svg')).toBeTruthy();
    expect(sel.textContent).toBe('');
  });
  it('exactly one tool is pressed and it follows the tool, by click and by key', () => {
    const { app, chrome } = setup();
    const pressed = () => [...chrome.dock.querySelectorAll('[aria-pressed="true"]')].map((b) => (b as HTMLElement).dataset.dockId);
    expect(pressed()).toEqual(['core.select']);
    chrome.dock.querySelector<HTMLElement>('[data-dock-id="core.hand"]')!.click();
    expect(app.view.tool).toBe('hand');
    expect(pressed()).toEqual(['core.hand']);
    app.view.setTool('select');
    expect(pressed()).toEqual(['core.select']);
  });
  it('+ opens the kits above the button; choosing one creates it at the view center', () => {
    const { app, root, chrome } = setup();
    const a = kit('a');
    const b = kit('b');
    app.registerKit(a);
    app.registerKit(b);
    chrome.dock.querySelector<HTMLElement>('[data-dock-id="core.add"]')!.click();
    const rows = [...root.querySelectorAll<HTMLElement>('.cv-menu .cv-menu-item')];
    expect(rows.map((r) => r.querySelector('.cv-menu-label')!.textContent)).toEqual(['Kit a', 'Kit b']);
    rows[1].click();
    expect(b.create).toHaveBeenCalledWith(app, app.viewCenter());
    expect(a.create).not.toHaveBeenCalled();
  });
  it('a plugin item shows up, runs with its button, can be modal, and goes away on dispose', () => {
    const { app, chrome } = setup();
    let on = false;
    const run = vi.fn();
    const off = app.registerDockItem({ id: 'x.tool', label: 'Box', icon: 'plus', shortcut: 'R', section: 'create', active: () => on, run });
    expect(dockIds(chrome)).toEqual(['core.select', 'core.hand', 'x.tool']);
    const btn = chrome.dock.querySelector<HTMLElement>('[data-dock-id="x.tool"]')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    expect(run).toHaveBeenCalledWith(app, btn);
    on = true;
    app.view.setTool('hand'); // any tool change re-checks the pressed state
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    off();
    expect(dockIds(chrome)).toEqual(['core.select', 'core.hand']);
  });
  it('an item whose when() is false is hidden, and shows when it turns true', () => {
    const { app, chrome } = setup();
    let ok = false;
    app.registerDockItem({ id: 'x.when', label: 'W', icon: 'plus', when: () => ok, run: () => {} });
    expect(dockIds(chrome)).not.toContain('x.when');
    ok = true;
    app.view.setTool('hand');
    expect(dockIds(chrome)).toContain('x.when');
  });
  it('sections are separated by one separator; a hidden section leaves none behind', () => {
    const { app, chrome } = setup();
    let ok = false;
    app.registerDockItem({ id: 'x.c', label: 'C', icon: 'plus', section: 'create', when: () => ok, run: () => {} });
    const seps = () => [...chrome.dock.querySelectorAll('.cv-dock-sep:not([hidden])')].length;
    expect(seps()).toBe(0);
    ok = true;
    app.view.setTool('hand');
    expect(seps()).toBe(1);
  });
  it('a click gives the button its focus back', () => {
    const { chrome } = setup();
    const btn = chrome.dock.querySelector<HTMLElement>('[data-dock-id="core.hand"]')!;
    btn.focus();
    btn.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
    expect(document.activeElement).not.toBe(btn);
  });
});

describe('main menu', () => {
  it('core alone: Edit with Undo and Redo, nothing else (no Add without kits, no room items)', () => {
    const { app } = setup();
    const m = buildMainMenu(app);
    expect(labels(m)).toEqual(['Edit']);
    expect(labels(sub(m, 'Edit'))).toEqual(['Undo', 'Redo']);
  });
  it('Undo and Redo are always enabled and call the store', () => {
    const { app } = setup();
    const undo = vi.spyOn(app.store, 'undo');
    const redo = vi.spyOn(app.store, 'redo');
    const [u, r] = sub(buildMainMenu(app), 'Edit');
    expect([u.disabled, r.disabled]).toEqual([undefined, undefined]);
    u.run!();
    r.run!();
    expect(undo).toHaveBeenCalledOnce();
    expect(redo).toHaveBeenCalledOnce();
  });
  it('known groups come first in order, plugin groups after, ungrouped rows last behind a separator', () => {
    const { app } = setup();
    app.registerMainMenuItem({ id: 'z', group: 'Game', entry: () => ({ label: 'Play' }) });
    app.registerMainMenuItem({ id: 'help', order: 1, entry: () => ({ label: 'Help' }) });
    app.registerMainMenuItem({ id: 'bridge', order: 0, entry: () => ({ label: 'Bridge…' }) });
    app.registerMainMenuItem({ id: 'f', group: 'File', entry: () => ({ label: 'Open' }) });
    app.registerKit(kit('a'));
    const m = buildMainMenu(app);
    expect(labels(m)).toEqual(['File', 'Edit', 'Add', 'Game', 'Bridge…', 'Help']);
    expect(m.map((e) => !!e.separator)).toEqual([false, false, false, false, true, false]);
  });
  it('a plugin group fills with its rows in order; when() hides rows and empty groups', () => {
    const { app } = setup();
    let ok = true;
    app.registerMainMenuItem({ id: 'g2', group: 'Game', entry: () => ({ label: 'Second' }) });
    app.registerMainMenuItem({ id: 'g1', group: 'Game', order: -1, entry: () => ({ label: 'First' }) });
    app.registerMainMenuItem({ id: 'h', group: 'Hidden', when: () => ok, entry: () => ({ label: 'Nope' }) });
    expect(labels(sub(buildMainMenu(app), 'Game'))).toEqual(['First', 'Second']);
    expect(labels(buildMainMenu(app))).toContain('Hidden');
    ok = false;
    expect(labels(buildMainMenu(app))).not.toContain('Hidden');
  });
  it('an item may return several rows, and Add lists the kits', () => {
    const { app } = setup();
    app.registerKit(kit('a'));
    app.registerKit(kit('b'));
    expect(labels(sub(buildMainMenu(app), 'Add'))).toEqual(['Kit a', 'Kit b']);
  });
  it('the ☰ button opens the menu under it, closes it on a second click', () => {
    const { app, root, chrome } = setup();
    const btn = chrome.topLeft.querySelector<HTMLElement>('[aria-label="Main menu"]')!;
    btn.click();
    expect(root.querySelector('.cv-menu')).toBeTruthy();
    expect(app.view.menuAnchor).toBe(btn);
    btn.click();
    expect(root.querySelector('.cv-menu')).toBeNull();
  });
  it('a pointerdown elsewhere in the page closes it', () => {
    const { root, chrome } = setup();
    chrome.topLeft.querySelector<HTMLElement>('[aria-label="Main menu"]')!.click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.cv-menu')).toBeNull();
  });
});

describe('toast', () => {
  it('app.notify shows the message above the dock, then clears', () => {
    vi.useFakeTimers();
    try {
      const { app } = setup();
      const t = document.querySelector<HTMLElement>('.cv-toast')!;
      expect(t.hidden).toBe(true);
      app.notify('Saved x');
      expect(t.hidden).toBe(false);
      expect(t.textContent).toBe('Saved x');
      vi.advanceTimersByTime(2600);
      expect(t.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('context actions', () => {
  it('registerMenu and registerMenuItem return disposers', () => {
    const { app } = setup();
    const off = app.registerMenu(() => ({ entries: [{ label: 'x' }] }));
    const off2 = app.registerMenuItem({ label: 'y', when: () => true, run: () => {} });
    expect([app.menuProviders.length, app.menu.length]).toEqual([1, 1]);
    off();
    off2();
    expect([app.menuProviders.length, app.menu.length]).toEqual([0, 0]);
  });
});

describe('icons and hooks', () => {
  it('an unknown icon name warns and shows the default glyph', async () => {
    const { icon, ICONS } = await import('./icons');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svg = icon('no-such-icon');
    expect(warn).toHaveBeenCalledOnce();
    expect(svg.innerHTML).toContain(ICONS.square.slice(0, 20));
    warn.mockRestore();
  });
  it('the + button toggles its kit menu', () => {
    const { app, chrome } = setup();
    app.registerKit(kit('a'));
    const plus = chrome.dock.querySelector<HTMLButtonElement>('[data-dock-id="core.add"]')!;
    plus.click();
    expect(app.view.menuAnchor).toBe(plus);
    plus.click();
    expect(app.view.menuAnchor).toBeUndefined();
  });
  it('onTableReplaced hooks run', () => {
    const { app } = setup();
    const seen = vi.fn();
    app.onTableReplaced(seen);
    app.tableReplaced();
    expect(seen).toHaveBeenCalledWith(app);
  });
});

describe('zoom control', () => {
  it('mounts without an icon warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app } = setup();
    const { mountZoomControl } = await import('./zoomControl');
    mountZoomControl(app);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
