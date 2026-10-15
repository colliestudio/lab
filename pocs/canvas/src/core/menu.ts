import type { MenuEntry } from './plugin';

type Pt = { x: number; y: number };
type Level = { el: HTMLElement; entries: MenuEntry[]; rows: (HTMLElement | null)[]; active: number; parentRow?: HTMLElement };

const HOVER_MS = 140;

/**
 * Cascading menus inside `root` (positioned in root coordinates). "Label ▸" entries open a child
 * menu beside the row on hover or click; it flips to the other side (and shifts up) at the edges.
 * Keyboard while open: ↑/↓ move, → or Enter opens a submenu, ← closes one level, Enter runs, Esc closes all.
 */
export class Menu {
  private levels: Level[] = [];
  private timer = 0;
  private anchorEl?: Element;

  constructor(private root: HTMLElement) {
    window.addEventListener('keydown', (e) => this.onKey(e), { capture: true });
  }

  get isOpen() {
    return this.levels.length > 0;
  }

  /** The element the open menu hangs from (a button), if any: lets that button toggle it. */
  get anchor() {
    return this.isOpen ? this.anchorEl : undefined;
  }

  /** Open at a root point, or below an element (e.g. an object's tab); `above` puts it over the element instead. */
  open(entries: MenuEntry[], at: Pt | Element, title?: string, opts: { above?: boolean } = {}) {
    this.close();
    this.anchorEl = undefined;
    if (!entries.length) return;
    const lv = this.build(entries, title);
    let p: Pt;
    if (at instanceof Element) {
      this.anchorEl = at;
      const r = at.getBoundingClientRect();
      const root = this.root.getBoundingClientRect();
      p = { x: r.left - root.left, y: opts.above ? r.top - root.top - lv.el.offsetHeight - 4 : r.bottom - root.top + 4 };
    } else p = at;
    this.place(lv.el, p.x, p.y);
  }

  close() {
    clearTimeout(this.timer);
    this.closeFrom(0);
  }

  /** Root-relative boxes of the open menus (tests and debugging). */
  get elements() {
    return this.levels.map((l) => l.el);
  }

  private closeFrom(level: number) {
    for (const lv of this.levels.splice(level)) {
      lv.el.remove();
      lv.parentRow?.classList.remove('cv-open');
      lv.parentRow?.setAttribute('aria-expanded', 'false');
    }
  }

  private build(entries: MenuEntry[], title?: string): Level {
    const level = this.levels.length;
    const menu = el('div', 'cv-menu');
    menu.setAttribute('role', 'menu');
    menu.dataset.level = String(level);
    if (title) {
      const t = el('div', 'cv-menu-title');
      t.textContent = title;
      menu.append(t);
    }
    const lv: Level = { el: menu, entries, rows: [], active: -1 };
    entries.forEach((entry, i) => {
      if (entry.separator && i > 0) menu.append(el('div', 'cv-menu-sep'));
      const row = entry.number ? this.numberRow(entry, level) : this.itemRow(entry, level, i);
      lv.rows.push(row);
      menu.append(row);
      row.addEventListener('pointerenter', () => {
        clearTimeout(this.timer);
        this.setActive(level, i, false);
        // after a short pause: open this row's submenu, or close a sibling's
        this.timer = window.setTimeout(() => {
          if (this.levels[level]?.active !== i) return;
          if (entry.items && !entry.disabled) this.openSub(level, i, false);
          else this.closeFrom(level + 1);
        }, HOVER_MS);
      });
    });
    // entering a child menu keeps it open (cancels a pending close from the parent)
    menu.addEventListener('pointerenter', () => {
      if (level > 0) clearTimeout(this.timer);
    });
    menu.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    menu.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    this.root.append(menu);
    this.levels.push(lv);
    return lv;
  }

  private itemRow(entry: MenuEntry, level: number, i: number) {
    const b = el('button', 'cv-menu-item');
    b.type = 'button';
    b.setAttribute('role', entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
    if (entry.checked !== undefined) b.setAttribute('aria-checked', String(entry.checked));
    const check = el('span', 'cv-menu-check');
    check.textContent = entry.checked ? '✓' : '';
    const label = el('span', 'cv-menu-label');
    label.textContent = entry.label;
    if (entry.color) {
      const dot = el('i', 'cv-menu-dot');
      dot.style.background = entry.color;
      const line = el('span', '');
      line.append(dot, entry.label);
      label.replaceChildren(line);
    }
    if (entry.muted) b.classList.add('cv-muted');
    const reason = typeof entry.disabled === 'string' ? entry.disabled : '';
    if (reason) {
      const why = el('small', 'cv-menu-why');
      why.textContent = reason;
      label.append(why);
      b.title = reason;
    }
    const kbd = el('kbd', '');
    kbd.textContent = entry.hint ?? '';
    b.append(check, label, kbd);
    if (entry.items) {
      b.classList.add('cv-has-sub');
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      const arrow = el('span', 'cv-menu-arrow');
      arrow.textContent = '▸';
      b.append(arrow);
    }
    if (entry.disabled) {
      b.classList.add('cv-disabled');
      b.setAttribute('aria-disabled', 'true');
    }
    b.addEventListener('click', () => this.activate(level, i));
    return b;
  }

  /** "N…" row: a small number field and a go button. */
  private numberRow(entry: MenuEntry, level: number) {
    const spec = entry.number!;
    const row = el('div', 'cv-menu-item cv-menu-number');
    const label = el('span', 'cv-menu-label');
    label.textContent = entry.label;
    const input = el('input', '');
    input.type = 'number';
    input.min = String(spec.min ?? 1);
    if (spec.max !== undefined) input.max = String(spec.max);
    input.value = String(spec.value ?? spec.min ?? 1);
    input.setAttribute('aria-label', entry.label);
    const go = el('button', 'cv-menu-go');
    go.type = 'button';
    go.textContent = spec.action ?? 'OK';
    row.append(el('span', 'cv-menu-check'), label, input, go);
    const submit = () => {
      const n = Math.round(Number(input.value));
      if (!Number.isFinite(n) || n < (spec.min ?? 1) || (spec.max !== undefined && n > spec.max)) {
        input.select();
        return;
      }
      this.close();
      spec.run(n);
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
    });
    input.addEventListener('focus', () => this.setActive(level, this.levels[level]?.rows.indexOf(row) ?? -1, false));
    return row;
  }

  private setActive(level: number, i: number, focus: boolean) {
    const lv = this.levels[level];
    if (!lv) return;
    lv.rows[lv.active]?.classList.remove('cv-active');
    lv.active = i;
    const row = lv.rows[i];
    if (!row) return;
    row.classList.add('cv-active');
    if (focus) {
      const target = row.querySelector('input') ?? row;
      (target as HTMLElement).focus({ preventScroll: true });
      if (target instanceof HTMLInputElement) target.select();
    }
  }

  /** Click / Enter on a row: open its submenu, or run it. */
  private activate(level: number, i: number, focusChild = false) {
    const entry = this.levels[level]?.entries[i];
    if (!entry || entry.disabled) return;
    if (entry.items) return this.openSub(level, i, focusChild);
    if (entry.number) return this.setActive(level, i, true);
    this.close();
    entry.run?.();
  }

  private openSub(level: number, i: number, focusFirst: boolean) {
    const parent = this.levels[level];
    const entry = parent?.entries[i];
    const row = parent?.rows[i];
    if (!entry?.items || !row) return;
    if (this.levels[level + 1]?.parentRow === row) {
      if (focusFirst) this.moveActive(level + 1, 1, true);
      return;
    }
    this.closeFrom(level + 1);
    const items = typeof entry.items === 'function' ? entry.items() : entry.items;
    if (!items.length) return;
    const lv = this.build(items);
    lv.parentRow = row;
    row.classList.add('cv-open');
    row.setAttribute('aria-expanded', 'true');
    // beside the row; flip to the left of the parent menu if it doesn't fit on the right
    const root = this.root.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const pm = parent.el.getBoundingClientRect();
    const w = lv.el.offsetWidth;
    const right = pm.right - root.left - 2;
    const x = right + w > this.root.clientWidth ? pm.left - root.left - w + 2 : right;
    this.place(lv.el, x, r.top - root.top - 4);
    if (focusFirst) this.moveActive(level + 1, 1, true);
  }

  /** Clamp a menu inside the root (flip up/left when it would run off the edge). */
  private place(menu: HTMLElement, x: number, y: number) {
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    if (x + w > W) x = Math.max(4, W - w - 4);
    if (y + h > H) y = Math.max(4, H - h - 4);
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, y)}px`;
  }

  private moveActive(level: number, dir: 1 | -1, fromStart = false) {
    const lv = this.levels[level];
    if (!lv) return;
    const n = lv.rows.length;
    let i = fromStart || lv.active < 0 ? (dir > 0 ? -1 : n) : lv.active;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (!lv.entries[i].disabled) return this.setActive(level, i, true);
    }
  }

  private onKey(e: KeyboardEvent) {
    if (!this.isOpen) return;
    const level = this.levels.length - 1;
    const lv = this.levels[level];
    const inInput = e.target instanceof HTMLInputElement && !!e.target.closest('.cv-menu');
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case 'Escape':
        handled();
        return this.close();
      case 'ArrowDown':
      case 'ArrowUp':
        handled();
        clearTimeout(this.timer);
        return this.moveActive(level, e.key === 'ArrowDown' ? 1 : -1);
      case 'ArrowRight': {
        if (inInput) return;
        handled();
        const entry = lv.entries[lv.active];
        if (entry?.items && !entry.disabled) this.openSub(level, lv.active, true);
        return;
      }
      case 'ArrowLeft':
        if (inInput) return;
        handled();
        if (level > 0) {
          const row = lv.parentRow;
          this.closeFrom(level);
          if (row) (row as HTMLElement).focus({ preventScroll: true });
        }
        return;
      case 'Enter':
      case ' ':
        if (inInput) return; // the number field handles its own Enter
        handled();
        if (lv.active >= 0) this.activate(level, lv.active, true);
        return;
      case 'Tab':
        handled();
        return this.moveActive(level, e.shiftKey ? -1 : 1);
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
