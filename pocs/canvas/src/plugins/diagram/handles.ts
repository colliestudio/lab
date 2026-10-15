import type { App, CanvasNode, Side } from '../../core';
import { anchor, SIDES } from '../../core';
import { MIN_SIZE, isShape } from './model';

// Handles around a shape: dots on its four sides to pull an arrow out of, and (on the selected
// shape) eight squares to resize it. They live in the world layer so they follow pan and zoom; their
// size is divided by the zoom (--inv) so they stay the same size on screen.

const SVG = 'http://www.w3.org/2000/svg';
const DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Dir = (typeof DIRS)[number];

export interface HandleHooks {
  /** An arrow was pulled out of `from`'s `side` and let go: on a shape (`to`), on empty space (`at`) or not moved (neither). */
  connect(from: string, side: Side, drop: { to?: string; at?: { x: number; y: number } }): void;
}

export function mountHandles(app: App, hooks: HandleHooks) {
  const view = app.view;
  const overlay = document.createElement('div');
  overlay.className = 'dg-overlay';
  const wire = document.createElementNS(SVG, 'svg');
  wire.setAttribute('class', 'dg-wire');
  const wireLine = document.createElementNS(SVG, 'line');
  wire.append(wireLine);
  wire.style.display = 'none';
  overlay.append(wire);
  view.world.append(overlay);

  const boxes = new Map<string, { el: HTMLElement; rz: HTMLElement[]; key: string }>();
  let hover: string | undefined;
  let busy = false; // a handle is being dragged: keep the boxes as they are

  const shapeById = (id: string | undefined): CanvasNode | undefined => {
    const n = id ? app.node(id) : undefined;
    return n && isShape(n) && app.doc.isVisible(n.id) ? n : undefined;
  };

  const make = (id: string) => {
    const el = document.createElement('div');
    el.className = 'dg-box';
    el.dataset.for = id;
    for (const side of SIDES) {
      const c = document.createElement('div');
      c.className = 'dg-conn';
      c.dataset.side = side;
      c.addEventListener('pointerdown', (e) => startConnect(e, id, side));
      el.append(c);
    }
    const rz = DIRS.map((dir) => {
      const h = document.createElement('div');
      h.className = 'dg-rz';
      h.dataset.dir = dir;
      h.addEventListener('pointerdown', (e) => startResize(e, id, dir));
      el.append(h);
      return h;
    });
    overlay.append(el);
    return { el, rz, key: '' };
  };

  const refresh = () => {
    const vp = app.viewport;
    overlay.style.setProperty('--inv', String(1 / vp.zoom));
    const sel = app.selected();
    const selected = sel.length === 1 && isShape(sel[0]) ? sel[0].id : undefined;
    const want = new Set<string>();
    if (selected) want.add(selected);
    if (hover && shapeById(hover)) want.add(hover);
    for (const [id, b] of boxes) {
      if (want.has(id)) continue;
      if (busy) continue;
      b.el.remove();
      boxes.delete(id);
    }
    for (const id of want) {
      const n = shapeById(id)!;
      let b = boxes.get(id);
      if (!b) boxes.set(id, (b = make(id)));
      const key = `${n.x},${n.y},${n.width},${n.height},${id === selected}`;
      if (b.key === key) continue;
      b.key = key;
      b.el.style.transform = `translate(${n.x}px, ${n.y}px)`;
      b.el.style.width = `${n.width}px`;
      b.el.style.height = `${n.height}px`;
      for (const h of b.rz) h.style.display = id === selected ? '' : 'none';
    }
  };
  app.store.subscribe(refresh);
  app.viewport.onChange(refresh);
  refresh();

  // hover: the shape under the pointer (or its handles) shows its dots
  view.root.addEventListener('pointermove', (e) => {
    if (e.buttons || busy) return;
    const t = (e.target as Element).closest<HTMLElement>('[data-node-id], .dg-box');
    const id = t?.dataset.nodeId ?? t?.dataset.for;
    const next = shapeById(id) ? id : undefined;
    if (next !== hover) {
      hover = next;
      refresh();
    }
  });
  view.root.addEventListener('pointerleave', () => {
    if (!hover || busy) return;
    hover = undefined;
    refresh();
  });

  // ---------------------------------------------------------------- pull an arrow out
  const world = (e: PointerEvent) => {
    const r = view.root.getBoundingClientRect();
    const [x, y] = app.viewport.toWorld(e.clientX - r.left, e.clientY - r.top);
    return { x, y };
  };
  const shapeUnder = (e: PointerEvent, not: string): string | undefined => {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const id = el.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
      if (id && id !== not && shapeById(id)) return id;
    }
    return undefined;
  };

  const startConnect = (e: PointerEvent, from: string, side: Side) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const n = shapeById(from);
    if (!n) return;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    busy = true;
    const p0 = anchor({ x: n.x, y: n.y, w: n.width, h: n.height }, side);
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    let over: string | undefined;
    wireLine.setAttribute('x1', String(p0.x));
    wireLine.setAttribute('y1', String(p0.y));
    const mark = (id: string | undefined) => {
      if (id === over) return;
      if (over) view.boxOf(over)?.classList.remove('dg-target');
      over = id;
      if (over) view.boxOf(over)?.classList.add('dg-target');
    };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      moved = true;
      const w = world(ev);
      wire.style.display = '';
      wireLine.setAttribute('x2', String(w.x));
      wireLine.setAttribute('y2', String(w.y));
      mark(shapeUnder(ev, from));
    };
    const up = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.releasePointerCapture?.(ev.pointerId);
      wire.style.display = 'none';
      const to = moved ? shapeUnder(ev, from) : undefined;
      mark(undefined);
      busy = false;
      hover = undefined;
      app.store.newUndoStep();
      if (!moved) hooks.connect(from, side, {});
      else if (to) hooks.connect(from, side, { to });
      else if (ev.type === 'pointerup') hooks.connect(from, side, { at: world(ev) });
      refresh();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  // ---------------------------------------------------------------- resize
  const startResize = (e: PointerEvent, id: string, dir: Dir) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const n = shapeById(id);
    if (!n) return;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    busy = true;
    app.store.newUndoStep();
    const w0 = world(e);
    const o = { x: n.x, y: n.y, w: n.width, h: n.height };
    const move = (ev: PointerEvent) => {
      const w = world(ev);
      const dx = w.x - w0.x;
      const dy = w.y - w0.y;
      let { x, y, w: width, h: height } = o;
      if (dir.includes('e')) width = o.w + dx;
      if (dir.includes('w')) {
        width = o.w - dx;
        x = o.x + dx;
      }
      if (dir.includes('s')) height = o.h + dy;
      if (dir.includes('n')) {
        height = o.h - dy;
        y = o.y + dy;
      }
      if (ev.shiftKey && dir.length === 2) {
        // corners keep the proportions
        const k = Math.max(width / o.w, height / o.h);
        width = o.w * k;
        height = o.h * k;
        if (dir.includes('w')) x = o.x + o.w - width;
        if (dir.includes('n')) y = o.y + o.h - height;
      }
      width = Math.max(MIN_SIZE, width);
      height = Math.max(MIN_SIZE, height);
      if (dir.includes('w')) x = Math.min(x, o.x + o.w - MIN_SIZE);
      if (dir.includes('n')) y = Math.min(y, o.y + o.h - MIN_SIZE);
      app.dispatch('diagram.resize', { id, x, y, width, height }, { merge: true });
    };
    const up = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.releasePointerCapture?.(ev.pointerId);
      busy = false;
      refresh();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
}
