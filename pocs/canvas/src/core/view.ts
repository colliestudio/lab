import type { App } from './app';
import type { CanvasNode } from './doc';

type Pt = { x: number; y: number };

type Gesture =
  | { kind: 'pan'; last: Pt; start: Pt; moved: boolean; onEmpty: boolean }
  | { kind: 'drag'; ids: string[]; clickId: string; shift: boolean; start: Pt; applied: Pt; moved: boolean }
  | { kind: 'marquee'; start: Pt; base: Set<string> }
  | { kind: 'pinch'; dist: number; mid: Pt };

const DRAG_THRESHOLD = 4; // screen px
const DOUBLE_CLICK_MS = 350;

/** Renders the doc as DOM boxes inside a transformed "world" layer and turns input into commands. */
export class View {
  readonly world: HTMLElement;
  private els = new Map<string, HTMLElement>();
  private contentKeys = new Map<string, string>();
  private marquee: HTMLElement;
  private menuEl: HTMLElement | null = null;
  private gesture: Gesture | null = null;
  private pointers = new Map<number, Pt>();
  private spaceDown = false;
  private lastClick = { id: '', t: 0 };

  constructor(
    private app: App,
    readonly root: HTMLElement,
  ) {
    root.classList.add('cv-root');
    root.tabIndex = 0;
    this.world = el('div', 'cv-world');
    this.marquee = el('div', 'cv-marquee');
    root.append(this.world, this.marquee);

    app.viewport.onChange(() => this.applyViewport());
    app.store.subscribe(() => this.render());
    this.applyViewport();

    root.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    root.addEventListener('pointermove', (e) => this.onPointerMove(e));
    root.addEventListener('pointerup', (e) => this.onPointerUp(e));
    root.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    root.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    root.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    // Safari trackpad pinch
    let gScale = 1;
    root.addEventListener('gesturestart', (e: any) => {
      e.preventDefault();
      gScale = 1;
    });
    root.addEventListener('gesturechange', (e: any) => {
      e.preventDefault();
      const p = this.local(e);
      this.app.viewport.zoomAt(p.x, p.y, e.scale / gScale);
      gScale = e.scale;
    });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') {
        this.spaceDown = false;
        root.classList.remove('cv-space');
      }
    });
    window.addEventListener('blur', () => {
      this.spaceDown = false;
      root.classList.remove('cv-space');
    });
  }

  // ---------------------------------------------------------------- rendering

  render() {
    const { nodes } = this.app.store.doc;
    const sel = this.app.store.selection;
    const alive = new Set<string>();
    nodes.forEach((n, i) => {
      alive.add(n.id);
      let box = this.els.get(n.id);
      if (!box) {
        box = el('div', 'cv-node');
        box.dataset.nodeId = n.id;
        this.world.append(box);
        this.els.set(n.id, box);
      }
      box.style.transform = `translate(${n.x}px, ${n.y}px)`;
      box.style.zIndex = String(i + 1);
      box.classList.toggle('cv-selected', sel.has(n.id));
      const key = contentKey(n);
      if (this.contentKeys.get(n.id) !== key) {
        this.contentKeys.set(n.id, key);
        box.style.width = `${n.width}px`;
        box.style.height = `${n.height}px`;
        const type = this.app.typeOf(n);
        box.dataset.kind = type?.id ?? n.type;
        box.replaceChildren();
        if (type) type.render(n, box);
        else renderFallback(n, box);
      }
    });
    for (const [id, box] of this.els) {
      if (!alive.has(id)) {
        box.remove();
        this.els.delete(id);
        this.contentKeys.delete(id);
      }
    }
  }

  private applyViewport() {
    const { x, y, zoom } = this.app.viewport;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    const grid = 40 * zoom;
    this.root.style.backgroundSize = `${grid}px ${grid}px, auto`;
    this.root.style.backgroundPosition = `${x}px ${y}px, 0 0`;
  }

  /** Zoom/pan so every node is visible. */
  fit(padding = 60) {
    const { nodes } = this.app.store.doc;
    if (!nodes.length) return this.app.viewport.set(this.root.clientWidth / 2, this.root.clientHeight / 2, 1);
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + n.width));
    const maxY = Math.max(...nodes.map((n) => n.y + n.height));
    const w = this.root.clientWidth - padding * 2;
    const h = this.root.clientHeight - padding * 2;
    const zoom = Math.min(1.5, Math.max(0.1, Math.min(w / (maxX - minX), h / (maxY - minY))));
    const x = (this.root.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom;
    const y = (this.root.clientHeight - (maxY - minY) * zoom) / 2 - minY * zoom;
    this.app.viewport.set(x, y, zoom);
  }

  // ---------------------------------------------------------------- input

  private local(e: { clientX: number; clientY: number }): Pt {
    const r = this.root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private world_(p: Pt): Pt {
    const [x, y] = this.app.viewport.toWorld(p.x, p.y);
    return { x, y };
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button === 2) return;
    this.closeMenu();
    this.root.focus({ preventScroll: true });
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.root.setPointerCapture(e.pointerId);

    if (this.pointers.size === 2) {
      // second finger: switch to pinch, abandon whatever the first finger started
      const [a, b] = [...this.pointers.values()];
      this.gesture = { kind: 'pinch', dist: dist(a, b), mid: midpoint(a, b) };
      return;
    }
    if (this.pointers.size > 2) return;

    const nodeEl = (e.target as Element).closest<HTMLElement>('[data-node-id]');
    if (this.spaceDown || e.button === 1 || (!nodeEl && !e.shiftKey)) {
      this.gesture = { kind: 'pan', last: p, start: p, moved: false, onEmpty: !nodeEl };
      return;
    }
    if (!nodeEl) {
      this.gesture = { kind: 'marquee', start: this.world_(p), base: new Set(this.app.store.selection) };
      return;
    }

    let id = nodeEl.dataset.nodeId!;
    const node = this.app.node(id);
    if (!node) return;
    const swapped = this.app.typeOf(node)?.onPointerDown?.(node, e, this.app);
    const store = this.app.store;
    if (swapped) {
      id = swapped;
      store.select([id]);
    } else if (e.shiftKey) {
      const next = new Set(store.selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      store.select(next);
      if (!next.has(id)) return; // shift-click deselect: no drag
    } else if (!store.selection.has(id)) {
      store.select([id]);
    }
    const ids = this.app.selected().map((n) => n.id);
    this.app.dispatch('core.front', { ids });
    const w = this.world_(p);
    this.gesture = { kind: 'drag', ids, clickId: id, shift: e.shiftKey, start: w, applied: { x: 0, y: 0 }, moved: false };
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;
    if (!g) return;
    switch (g.kind) {
      case 'pinch': {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()];
        const d = dist(a, b);
        const m = midpoint(a, b);
        this.app.viewport.panBy(m.x - g.mid.x, m.y - g.mid.y);
        this.app.viewport.zoomAt(m.x, m.y, d / g.dist);
        g.dist = d;
        g.mid = m;
        return;
      }
      case 'pan':
        this.app.viewport.panBy(p.x - g.last.x, p.y - g.last.y);
        g.last = p;
        if (dist(p, g.start) > DRAG_THRESHOLD) g.moved = true;
        return;
      case 'drag': {
        const w = this.world_(p);
        const tx = Math.round(w.x - g.start.x);
        const ty = Math.round(w.y - g.start.y);
        if (!g.moved && Math.hypot(tx, ty) * this.app.viewport.zoom < DRAG_THRESHOLD) return;
        if (!g.moved) {
          g.moved = true;
          for (const id of g.ids) this.els.get(id)?.classList.add('cv-dragging');
        }
        const dx = tx - g.applied.x;
        const dy = ty - g.applied.y;
        if (dx || dy) {
          this.app.dispatch('core.move', { ids: g.ids, dx, dy });
          g.applied = { x: tx, y: ty };
        }
        return;
      }
      case 'marquee': {
        const w = this.world_(p);
        const r = rect(g.start, w);
        const s1 = this.app.viewport;
        Object.assign(this.marquee.style, {
          display: 'block',
          left: `${r.x * s1.zoom + s1.x}px`,
          top: `${r.y * s1.zoom + s1.y}px`,
          width: `${r.w * s1.zoom}px`,
          height: `${r.h * s1.zoom}px`,
        });
        const hits = this.app.store.doc.nodes.filter(
          (n) => n.x < r.x + r.w && n.x + n.width > r.x && n.y < r.y + r.h && n.y + n.height > r.y,
        );
        this.app.store.select([...g.base, ...hits.map((n) => n.id)]);
        return;
      }
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.root.hasPointerCapture(e.pointerId)) this.root.releasePointerCapture(e.pointerId);
    const g = this.gesture;
    if (g?.kind === 'pinch') {
      if (this.pointers.size === 0) this.gesture = null;
      return;
    }
    this.gesture = null;
    if (!g) return;

    if (g.kind === 'pan' && !g.moved && g.onEmpty) this.app.store.select([]);
    if (g.kind === 'marquee') this.marquee.style.display = 'none';
    if (g.kind !== 'drag') return;

    for (const id of g.ids) this.els.get(id)?.classList.remove('cv-dragging');
    if (g.moved) {
      const dragged = new Set(g.ids);
      const targetEl = document
        .elementsFromPoint(e.clientX, e.clientY)
        .map((x) => x.closest<HTMLElement>('[data-node-id]'))
        .find((x) => x && !dragged.has(x.dataset.nodeId!));
      const target = targetEl && this.app.node(targetEl.dataset.nodeId!);
      if (target) this.app.typeOf(target)?.onDrop?.(target, g.ids, this.app);
      return;
    }
    // plain click
    if (!g.shift && this.app.store.selection.size > 1) this.app.store.select([g.clickId]);
    const now = performance.now();
    if (this.lastClick.id === g.clickId && now - this.lastClick.t < DOUBLE_CLICK_MS) {
      this.lastClick = { id: '', t: 0 };
      const node = this.app.node(g.clickId);
      if (node) this.app.typeOf(node)?.onDoubleClick?.(node, this.app);
    } else {
      this.lastClick = { id: g.clickId, t: now };
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.local(e);
    const vp = this.app.viewport;
    if (e.ctrlKey) {
      // trackpad pinch (and ctrl+wheel)
      vp.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.01));
      return;
    }
    // Mouse wheels send line deltas or big round vertical steps; trackpads send small pixel deltas.
    const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
    if (mouseWheel) vp.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    else vp.panBy(-e.deltaX, -e.deltaY);
  }

  private onKeyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === ' ') {
      e.preventDefault();
      this.spaceDown = true;
      this.root.classList.add('cv-space');
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const store = this.app.store;
    if (e.key === 'Escape') {
      this.closeMenu();
      store.select([]);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && store.selection.size) {
      e.preventDefault();
      this.app.dispatch('core.delete', { ids: [...store.selection] });
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      store.select(store.doc.nodes.map((n) => n.id));
      return;
    }
    const combo = `${mod ? 'mod+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`;
    const binding = this.app.keys.get(combo);
    if (binding) {
      e.preventDefault();
      binding.run(this.app);
    }
  }

  // ---------------------------------------------------------------- context menu

  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    const nodeEl = (e.target as Element).closest<HTMLElement>('[data-node-id]');
    const store = this.app.store;
    if (nodeEl && !store.selection.has(nodeEl.dataset.nodeId!)) store.select([nodeEl.dataset.nodeId!]);
    if (!nodeEl) store.select([]);
    const selected = this.app.selected();
    const items = this.app.menu.filter((i) => i.when(this.app, selected));
    this.closeMenu();
    if (!items.length) return;
    const menu = el('div', 'cv-menu');
    for (const item of items) {
      const b = el('button', 'cv-menu-item');
      b.innerHTML = `<span></span><kbd></kbd>`;
      b.children[0].textContent = item.label;
      b.children[1].textContent = item.hint ?? '';
      b.addEventListener('click', () => {
        this.closeMenu();
        item.run(this.app, this.app.selected());
      });
      menu.append(b);
    }
    const p = this.local(e);
    menu.style.left = `${p.x}px`;
    menu.style.top = `${p.y}px`;
    menu.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    this.root.append(menu);
    this.menuEl = menu;
  }

  private closeMenu() {
    this.menuEl?.remove();
    this.menuEl = null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function renderFallback(n: CanvasNode, box: HTMLElement) {
  const d = el('div', 'cv-text');
  d.textContent = n.text ?? n.file ?? n.url ?? n.label ?? n.type;
  box.append(d);
}

/** Everything but position: if this is unchanged, the content doesn't need re-rendering. */
function contentKey(n: CanvasNode) {
  const { x: _x, y: _y, ...rest } = n;
  return JSON.stringify(rest);
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const rect = (a: Pt, b: Pt) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
