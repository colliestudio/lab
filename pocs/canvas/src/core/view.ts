import type { App } from './app';
import { raise } from './commands';
import type { CanvasNode } from './doc';
import { Menu } from './menu';
import type { MenuEntry, ObjectType, RenderCtx } from './plugin';
import { Viewport, wheelZoomFactor } from './viewport';

type Pt = { x: number; y: number };

type Gesture =
  | { kind: 'pan'; last: Pt; start: Pt; moved: boolean; onEmpty: boolean }
  | {
      kind: 'drag';
      ids: string[];
      clickId: string;
      shift: boolean;
      /** The pointerdown that started it (types decide from it what a drag means, e.g. grip vs body). */
      down: PointerEvent;
      start: Pt;
      applied: Pt;
      moved: boolean;
      target?: string;
      mode?: string;
      /** A local drag (see ObjectType.dragsLocally): moves on this screen only until the drop. */
      local?: boolean;
      /** Nothing it would move can move (ObjectType.movable): the drag does nothing. */
      still?: boolean;
    }
  | { kind: 'marquee'; start: Pt; base: Set<string>; /** the object the press fell through (never box-selected) */ skip?: string }
  | { kind: 'pinch'; dist: number; mid: Pt };

const DRAG_THRESHOLD = 4; // screen px
const DOUBLE_CLICK_MS = 350;
/** A drop onto another object needs the pointer over it and this much overlap (of the smaller box). */
const DROP_OVERLAP = 0.5;

/** Renders the doc as DOM boxes inside a transformed "world" layer and turns input into commands. */
export class View {
  readonly world: HTMLElement;
  private els = new Map<string, HTMLElement>();
  private contentKeys = new Map<string, string>();
  /** Box geometry last written per node: unchanged boxes get no style writes. */
  private boxKeys = new Map<string, string>();
  /** Nodes moving with the current drag (promoted to their own layers: moving them repaints nothing). */
  private moving: string[] = [];
  private marquee: HTMLElement;
  readonly menu: Menu;
  private gesture: Gesture | null = null;
  private pointers = new Map<number, Pt>();
  private spaceDown = false;
  /** Active tool: select (default) or hand (plain drag pans). */
  tool: 'select' | 'hand' = 'select';
  private toolListeners = new Set<(t: 'select' | 'hand') => void>();
  private lastClick = { id: '', t: 0 };
  /** Where the last right-click menu opened, in world coordinates (e.g. "new … here"). */
  menuPoint: Pt | undefined;
  /** Node under the mouse when no button is pressed (for "hovered" keyboard targets). */
  hovered: string | undefined;
  /** The local drag in progress: what moves and by how much (world units). */
  private localDrag: { ids: Set<string>; dx: number; dy: number } | null = null;

  constructor(
    private app: App,
    readonly root: HTMLElement,
  ) {
    root.classList.add('cv-root');
    root.tabIndex = 0;
    this.world = el('div', 'cv-world');
    this.marquee = el('div', 'cv-marquee');
    root.append(this.world, this.marquee);
    this.menu = new Menu(root);

    app.viewport.onChange(() => this.applyViewport());
    app.store.subscribe(() => this.render());
    this.applyViewport();

    root.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    root.addEventListener('pointerleave', () => {
      this.hovered = undefined;
      this.app.presence?.setCursor(null);
    });
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
    const doc = this.app.store.doc;
    const ctx: RenderCtx = { doc, viewer: this.app.viewer };
    const sel = this.app.store.selection;
    const alive = new Set<string>();
    // z-index by rendered position: numbering by doc order would skip one per concealed node (a count leak)
    let z = 0;
    doc.visible.forEach((n) => {
      const type = this.app.typeOf(n);
      if (type?.concealed?.(n, ctx)) return;
      z++;
      alive.add(n.id);
      let box = this.els.get(n.id);
      if (!box) {
        box = el('div', 'cv-node');
        box.dataset.nodeId = n.id;
        this.world.append(box);
        this.els.set(n.id, box);
      }
      const angle = doc.styleOf(n.id)?.angle;
      const off = this.localDrag?.ids.has(n.id) ? this.localDrag : undefined;
      const bx = n.x + (off?.dx ?? 0);
      const by = n.y + (off?.dy ?? 0);
      const bz = off ? 1e6 : z;
      const geo = `${bx},${by},${angle ?? 0},${bz},${n.width},${n.height},${sel.has(n.id)}`;
      if (this.boxKeys.get(n.id) !== geo) {
        this.boxKeys.set(n.id, geo);
        box.style.transform = `translate(${bx}px, ${by}px)` + (angle ? ` rotate(${angle}deg)` : '');
        box.style.zIndex = String(bz);
        box.style.width = `${n.width}px`;
        box.style.height = `${n.height}px`;
        box.classList.toggle('cv-selected', sel.has(n.id));
      }
      const key = (type?.id ?? '') + '\n' + (type?.renderKey?.(n, ctx) ?? contentKey(n));
      if (this.contentKeys.get(n.id) !== key) {
        this.contentKeys.set(n.id, key);
        box.dataset.kind = type?.id ?? n.type;
        box.replaceChildren();
        if (type) type.render(n, box, ctx);
        else renderFallback(n, box);
      }
    });
    for (const [id, box] of this.els) {
      if (!alive.has(id)) {
        box.remove();
        this.els.delete(id);
        this.contentKeys.delete(id);
        this.boxKeys.delete(id);
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
  fit(padding = 60, nodes = this.app.store.doc.visible, maxZoom = 1.5) {
    if (!nodes.length) return this.app.viewport.set(this.root.clientWidth / 2, this.root.clientHeight / 2, 1);
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + n.width));
    const maxY = Math.max(...nodes.map((n) => n.y + n.height));
    const w = this.root.clientWidth - padding * 2;
    const h = this.root.clientHeight - padding * 2;
    const zoom = Math.min(maxZoom, Math.max(Viewport.MIN, Math.min(w / (maxX - minX), h / (maxY - minY))));
    const x = (this.root.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom;
    const y = (this.root.clientHeight - (maxY - minY) * zoom) / 2 - minY * zoom;
    this.app.viewport.set(x, y, zoom);
  }

  /** Where a locally dragged node is shown right now (world box), else undefined. */
  dragBox(id: string): { x: number; y: number; width: number; height: number } | undefined {
    const n = this.localDrag?.ids.has(id) ? this.app.node(id) : undefined;
    return n && { x: n.x + this.localDrag!.dx, y: n.y + this.localDrag!.dy, width: n.width, height: n.height };
  }

  /** The DOM box of a rendered node (for overlays like remote selections). */
  boxOf(id: string): HTMLElement | undefined {
    return this.els.get(id);
  }

  /** Zoom so the selection fills the view (no-op without a selection). */
  zoomToSelection() {
    const sel = this.app.selected();
    if (sel.length) this.fit(80, sel, Viewport.MAX);
  }

  setTool(t: 'select' | 'hand') {
    this.tool = t;
    this.root.classList.toggle('cv-hand', t === 'hand');
    for (const fn of this.toolListeners) fn(t);
  }
  onToolChange(fn: (t: 'select' | 'hand') => void) {
    this.toolListeners.add(fn);
    return () => this.toolListeners.delete(fn);
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
      if (this.localDrag) {
        this.localDrag = null;
        this.render();
      }
      return;
    }
    if (this.pointers.size > 2) return;

    const nodeEl = (e.target as Element).closest<HTMLElement>('[data-node-id]');
    const actionEl = nodeEl && !this.spaceDown && e.button === 0 ? (e.target as Element).closest<HTMLElement>('[data-action]') : null;
    if (nodeEl && actionEl && nodeEl.contains(actionEl)) {
      const node = this.app.node(nodeEl.dataset.nodeId!);
      const type = node && this.app.typeOf(node);
      this.app.store.newUndoStep();
      if (node) type?.onAction?.(node, actionEl.dataset.action!, this.app);
      return;
    }
    // Pan: Space+drag or middle button (wheel pans too). Plain drag on empty table = box select;
    // Shift adds to the current selection.
    if (this.spaceDown || e.button === 1 || this.tool === 'hand') {
      this.gesture = { kind: 'pan', last: p, start: p, moved: false, onEmpty: !nodeEl };
      this.root.classList.add('cv-panning');
      return;
    }
    if (!nodeEl) {
      this.gesture = { kind: 'marquee', start: this.world_(p), base: new Set(e.shiftKey ? this.app.store.selection : []) };
      if (!e.shiftKey) this.app.store.select([]);
      return;
    }

    const id = nodeEl.dataset.nodeId!;
    const node = this.app.node(id);
    if (!node) return;
    if (this.app.typeOf(node)?.grabbable?.(node, e, this.app) === false) {
      // the press falls through to the table under the object; the box never selects that object
      // (else a box drawn on a locked board would take the board and all its pieces along)
      this.gesture = { kind: 'marquee', start: this.world_(p), base: new Set(e.shiftKey ? this.app.store.selection : []), skip: id };
      if (!e.shiftKey) this.app.store.select([]);
      return;
    }
    // another player is dragging it: hands off
    const holder = this.app.presence?.heldBy(id);
    if (holder) {
      this.app.notify(`${holder.name} is holding that`);
      return;
    }
    this.app.store.newUndoStep(); // the whole press-drag-drop is one undo step
    const store = this.app.store;
    if (e.shiftKey) {
      const next = new Set(store.selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      store.select(next);
      if (!next.has(id)) return; // shift-click deselect: no drag
    } else if (!store.selection.has(id)) {
      store.select([id]);
    }
    const ids = this.app.selected().map((n) => n.id);
    raise(this.app.store, ids.filter((x) => this.app.canMove(x)));
    const w = this.world_(p);
    this.gesture = { kind: 'drag', ids, clickId: id, shift: e.shiftKey, down: e, start: w, applied: { x: 0, y: 0 }, moved: false };
    this.app.presence?.setHeld(this.app.publicIds(ids));
  }

  private onPointerMove(e: PointerEvent) {
    if (this.app.presence) this.app.presence.setCursor(this.app.publicCursor(this.world_(this.local(e))));
    if (!this.pointers.size) this.hovered = (e.target as Element).closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
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
          const clicked = this.app.node(g.clickId);
          const ct = clicked && this.app.typeOf(clicked);
          if (clicked && !g.shift && ct?.dragsLocally?.(clicked, this.app)) {
            g.local = true;
            g.ids = [g.clickId];
            this.localDrag = { ids: new Set(g.ids), dx: 0, dy: 0 };
            ct.onLocalDrag?.(clicked, 'start', this.app);
          } else this.maybeSwapDragged(g);
          // pinned objects (a mat's zones outside edit mode) stay where they are
          g.ids = g.ids.filter((x) => this.app.canMove(x));
          if (!g.ids.length) g.still = true;
          for (const id of g.ids) this.els.get(id)?.classList.add('cv-dragging');
          this.promote(g.ids);
        }
        if (g.still) return;
        if (g.local && this.localDrag) {
          this.localDrag.dx = tx;
          this.localDrag.dy = ty;
          g.applied = { x: tx, y: ty };
          this.render();
        } else {
          const dx = tx - g.applied.x;
          const dy = ty - g.applied.y;
          if (dx || dy) {
            this.app.dispatch('core.move', { ids: g.ids, dx, dy }, { merge: true });
            g.applied = { x: tx, y: ty };
          }
        }
        const t = this.findDropTarget(g, e);
        this.setDropTarget(g, t?.id, t?.mode);
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
        // touching by default; Alt = only objects fully inside the box
        const hits = this.app.store.doc.visible.filter((n) =>
          n.id === g.skip || this.app.isConcealed(n) || !this.app.boxSelectable(n)
            ? false
            : e.altKey
            ? n.x >= r.x && n.x + n.width <= r.x + r.w && n.y >= r.y && n.y + n.height <= r.y + r.h
            : n.x < r.x + r.w && n.x + n.width > r.x && n.y < r.y + r.h && n.y + n.height > r.y,
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
    this.root.classList.remove('cv-panning');
    if (g?.kind === 'drag') this.app.presence?.setHeld([]);
    if (!g) return;

    if (g.kind === 'pan' && !g.moved && g.onEmpty) this.app.store.select([]);
    if (g.kind === 'marquee') this.marquee.style.display = 'none';
    if (g.kind !== 'drag') return;

    for (const id of g.ids) this.els.get(id)?.classList.remove('cv-dragging');
    this.promote([]);
    if (g.moved && g.still) return;
    if (g.moved) {
      const found = this.findDropTarget(g, e);
      this.setDropTarget(g, undefined);
      const target = found && this.app.node(found.id);
      const at = this.world_(this.local(e));
      if (target) this.app.store.merged(() => this.app.typeOf(target)?.onDrop?.(target, g.ids, this.app, at, found.mode));
      if (g.local) {
        const node = this.app.node(g.clickId);
        const box = this.dragBox(g.clickId);
        const type = node && this.app.typeOf(node);
        if (!target && node && box) this.app.store.merged(() => type?.onLocalDrop?.(node, { x: Math.round(box.x), y: Math.round(box.y) }, this.app));
        this.localDrag = null;
        if (node) type?.onLocalDrag?.(node, 'end', this.app);
        this.render();
      }
      this.endDrag(g.ids, target ? target.id : undefined);
      return;
    }
    // plain click
    if (!g.shift && this.app.store.selection.size > 1) this.app.store.select([g.clickId]);
    const clicked = this.app.node(g.clickId);
    if (clicked && !g.shift && this.app.typeOf(clicked)?.onClick?.(clicked, g.down, this.app)) {
      this.lastClick = { id: '', t: 0 };
      return;
    }
    const now = performance.now();
    if (this.lastClick.id === g.clickId && now - this.lastClick.t < DOUBLE_CLICK_MS) {
      this.lastClick = { id: '', t: 0 };
      const node = this.app.node(g.clickId);
      if (node) this.app.typeOf(node)?.onDoubleClick?.(node, this.app);
    } else {
      this.lastClick = { id: g.clickId, t: now };
    }
  }

  /** Figma-style: wheel pans (Shift = horizontal), ⌘/Ctrl+wheel and trackpad pinch zoom at the pointer. */
  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const vp = this.app.viewport;
    if (e.metaKey || e.ctrlKey) {
      // trackpad pinch arrives as ctrlKey + deltaY
      const p = this.local(e);
      vp.zoomAt(p.x, p.y, wheelZoomFactor(e.deltaY, e.deltaMode));
      return;
    }
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.root.clientHeight : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    // Shift+wheel scrolls sideways (some browsers already swap the axes for us)
    if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
    vp.panBy(-dx, -dy);
  }

  /** Zoom around the middle of the table (buttons, keys). */
  zoomCenter(how: 'in' | 'out' | number) {
    const vp = this.app.viewport;
    const cx = this.root.clientWidth / 2;
    const cy = this.root.clientHeight / 2;
    if (typeof how === 'number') vp.zoomTo(cx, cy, how);
    else vp.zoomStep(how === 'in' ? 1 : -1, cx, cy);
  }

  private onKeyDown(e: KeyboardEvent) {
    const t = e.target;
    if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === ' ') {
      e.preventDefault();
      const sb = this.app.keys.get('space');
      if (sb && !this.spaceDown && !this.pointers.size && (!sb.when || sb.when(this.app))) {
        if (!e.repeat) sb.run(this.app);
        return;
      }
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
      store.select(store.doc.visible.filter((n) => !this.app.isConcealed(n)).map((n) => n.id));
      return;
    }
    const arrow = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (arrow && !mod && store.selection.size) {
      // nudge 1px (Shift 10px); a held-down key's repeats form one undo step
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const ids = [...store.selection].filter((x) => this.app.canMove(x));
      if (!ids.length) return;
      this.app.dispatch('core.move', { ids, dx: arrow[0] * step, dy: arrow[1] * step }, { merge: e.repeat });
      this.endDrag(ids, undefined, 'keys');
      return;
    }
    if (!mod && !e.altKey && !e.shiftKey && (e.key === 'v' || e.key === 'h')) {
      this.setTool(e.key === 'h' ? 'hand' : 'select');
      return;
    }
    if (mod && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      if (e.key.toLowerCase() === 'y' || e.shiftKey) store.redo();
      else store.undo();
      return;
    }
    // digits by physical key, so Shift+1 is "shift+1" (not "!") on every layout
    const key = e.code.startsWith('Digit') ? e.code.slice(5) : e.key.toLowerCase();
    const combo = `${mod ? 'mod+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${key}`;
    const binding = this.app.keys.get(combo);
    if (binding && (!binding.when || binding.when(this.app))) {
      e.preventDefault();
      binding.run(this.app);
    }
  }

  /** Tell each moved type its move ended (state after any drop): a drag, or a nudge with the arrow keys. */
  private endDrag(ids: string[], target: string | undefined, via: 'drag' | 'keys' = 'drag') {
    const byType = new Map<ObjectType, CanvasNode[]>();
    for (const id of ids) {
      const n = this.app.node(id);
      const t = n && this.app.typeOf(n);
      if (!n || !t?.onDragEnd) continue;
      let l = byType.get(t);
      if (!l) byType.set(t, (l = []));
      l.push(n);
    }
    for (const [t, nodes] of byType) this.app.store.merged(() => t.onDragEnd!(nodes, this.app, target, via));
  }

  /**
   * Give what a drag moves (the dragged nodes, the cards a container lays out, riders) its own
   * compositor layer for the drag, so each move is a transform change only: no repaint of 52 cards.
   */
  private promote(ids: string[]) {
    for (const id of this.moving) this.els.get(id)?.classList.remove('cv-moving');
    const doc = this.app.store.doc;
    const out = new Set<string>();
    const add = (id: string) => {
      if (out.has(id)) return;
      out.add(id);
      for (const c of doc.children(id)) if (doc.isVisible(c.id)) add(c.id);
      for (const r of doc.riders(id)) add(r.id);
    };
    ids.forEach(add);
    this.moving = [...out];
    for (const id of this.moving) this.els.get(id)?.classList.add('cv-moving');
  }

  /** A single object being dragged may hand the drag to another node (a deck gives its top card). */
  private maybeSwapDragged(g: Extract<Gesture, { kind: 'drag' }>) {
    if (g.shift || g.ids.length !== 1 || g.ids[0] !== g.clickId) return;
    const node = this.app.node(g.clickId);
    const type = node && this.app.typeOf(node);
    if (!node || !type?.onDragStart) return;
    const out: { id?: string | void } = {};
    this.app.store.merged(() => (out.id = type.onDragStart!(node, g.down, this.app)));
    if (!out.id || !this.app.node(out.id)) return;
    g.ids = [out.id];
    g.clickId = out.id;
    this.app.store.select([out.id]);
    this.app.presence?.setHeld(this.app.publicIds([node.id, out.id])); // keep the deck held too while pulling from it
  }

  /** The object a drag would land on: topmost under the pointer, overlapping enough, and willing. */
  private findDropTarget(g: Extract<Gesture, { kind: 'drag' }>, e: PointerEvent): { id: string; mode?: string } | undefined {
    // what moves with the drag (a container's laid-out cards too) is never a target
    const dragged = new Set([...g.ids, ...this.moving]);
    const node = this.app.node(g.clickId);
    if (!node) return;
    const primary = { ...node, ...this.dragBox(g.clickId) };
    // cheap geometric pre-check: over empty table, skip the DOM hit test (it forces a style recalc)
    const w = this.world_(this.local(e));
    const M = 32; // tabs and grips stick out of a node's box
    const near = this.app.store.doc.visible.some(
      (n) => !dragged.has(n.id) && w.x >= n.x - M && w.x <= n.x + n.width + M && w.y >= n.y - M && w.y <= n.y + n.height + M,
    );
    if (!near) return;
    const under = document
      .elementsFromPoint(e.clientX, e.clientY)
      .map((x) => x.closest<HTMLElement>('[data-node-id]'))
      .find((x) => x && !dragged.has(x.dataset.nodeId!));
    let target = under && this.app.node(under.dataset.nodeId!);
    const proxy = target && this.app.typeOf(target)?.dropProxy?.(target, this.app);
    if (proxy) target = this.app.node(proxy);
    if (!target || dragged.has(target.id)) return;
    const type = this.app.typeOf(target);
    if (!type?.onDrop) return;
    const ov = overlap(primary, target);
    if (!type.canDrop) return ov >= DROP_OVERLAP ? { id: target.id } : undefined;
    const dropped = g.ids.map((id) => (id === g.clickId ? primary : this.app.node(id))).filter((n): n is CanvasNode => !!n);
    const verdict = type.canDrop(target, dropped, this.app, ov);
    if (!verdict) return;
    return { id: target.id, mode: typeof verdict === 'string' ? verdict : undefined };
  }

  private setDropTarget(g: Extract<Gesture, { kind: 'drag' }>, id: string | undefined, mode?: string) {
    if (g.target === id && g.mode === mode) return;
    if (g.target) {
      const old = this.els.get(g.target);
      old?.classList.remove('cv-drop-target');
      if (old) delete old.dataset.dropLabel;
    }
    g.target = id;
    g.mode = mode;
    const box = id ? this.els.get(id) : undefined;
    if (box) {
      box.classList.add('cv-drop-target');
      if (mode) box.dataset.dropLabel = mode;
    }
  }

  // ---------------------------------------------------------------- context menu

  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    this.menuPoint = this.world_(this.local(e));
    const nodeEl = (e.target as Element).closest<HTMLElement>('[data-node-id]');
    const store = this.app.store;
    if (nodeEl && !store.selection.has(nodeEl.dataset.nodeId!)) store.select([nodeEl.dataset.nodeId!]);
    if (!nodeEl) store.select([]);
    const selected = this.app.selected();
    const groups: MenuEntry[][] = [];
    let title: string | undefined;
    const plain = this.app.menu
      .filter((i) => i.when(this.app, selected))
      .map((i): MenuEntry => ({ label: i.label, hint: i.hint, run: () => i.run(this.app, this.app.selected()) }));
    if (plain.length) groups.push(plain);
    for (const provide of this.app.menuProviders) {
      const out = provide(this.app, selected);
      if (!out?.entries.length) continue;
      title ??= out.title;
      groups.push(out.entries);
    }
    // every selection can be deleted (a carrier takes its riders along)
    if (selected.length) groups.push([{ label: 'Delete', hint: '⌫', run: () => this.app.dispatch('core.delete', { ids: this.app.selected().map((n) => n.id) }) }]);
    const entries = groups.flatMap((g, k) => g.map((x, i) => (k > 0 && i === 0 ? { ...x, separator: true } : x)));
    this.openMenu(entries, this.local(e), title);
  }

  /** Show a menu at a table point, or anchored below an element (e.g. an object's tab). */
  openMenu(entries: MenuEntry[], at: { x: number; y: number } | Element, title?: string) {
    this.menu.open(entries, at, title);
  }

  closeMenu() {
    this.menu.close();
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

/** Everything but position/z: if this is unchanged, the content doesn't need re-rendering. */
function contentKey(n: CanvasNode) {
  const { x: _x, y: _y, z: _z, ...rest } = n;
  return JSON.stringify(rest);
}

/** Intersection area over the smaller box's area. */
function overlap(a: CanvasNode, b: CanvasNode) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.width * a.height, b.width * b.height);
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const rect = (a: Pt, b: Pt) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
