import './excalidraw.css';
import type { App, CanvasNode, Plugin } from '../../core';
import { ICONS } from '../../core/icons';
import { TEXT_INPUT, inlineEdit } from '../../core/inlineEdit';
import { useLogic } from '../logic';
import { BAR, NS, FRAME, elementsOf, frameOf, isDrawing, liveElements, logic, viewOf, type View, type XElement } from './logic';
import type { EditorHandle } from './lib';

export { registerExcalidrawLogic } from './logic';

// Excalidraw frames on the table. A frame is an ordinary canvas object (select, move, resize, name
// it, put it in a frame of the frames plugin) showing its drawing through its own saved view.
// Jump in (double-click, ↵, the ✏️ button, or hover + an Excalidraw tool key) and the real
// Excalidraw comes alive inside the frame; click anywhere outside and you're back on the table, and
// that click does what it does there. ⤢ opens the drawing full screen. A locked frame stays a static
// picture. Edits stream into the shared doc per element while it's open; one editing session is one
// undo step on the table.

const lib = () => import('./lib');

/** Excalidraw tools by key (hover a frame and press one to start drawing with it). */
const TOOL_KEYS: Record<string, string> = { r: 'rectangle', o: 'ellipse', d: 'diamond', a: 'arrow', t: 'text', p: 'freedraw', l: 'line' };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Preview renders in flight per box: only the newest one may fill it. */
const renders = new WeakMap<HTMLElement, number>();
let renderSeq = 0;
/** Last picture per frame (scene point at its top-left): kept while the next renders (core empties the box). */
const lastSvg = new Map<string, { svg: SVGSVGElement; x: number; y: number }>();
/** The frame being drawn in (its body shows no picture: the live editor is over it). */
let liveId: string | null = null;
/** The tool last used in each frame, to come back to it. */
const lastTool = new Map<string, string>();

/** Put the picture where the frame's view says. */
function place(n: CanvasNode, body: HTMLElement, p: { svg: SVGSVGElement; x: number; y: number }) {
  const v = viewOf(n);
  const svg = p.svg.cloneNode(true) as SVGSVGElement;
  svg.style.left = `${(p.x - v.x) * v.zoom}px`;
  svg.style.top = `${(p.y - v.y) * v.zoom}px`;
  svg.style.transform = `scale(${v.zoom})`;
  body.replaceChildren(svg);
}

function render(n: CanvasNode, el: HTMLElement, app: App) {
  const f = frameOf(n);
  const live = n.id === liveId;
  el.innerHTML = `<div class="xf${live ? ' xf-on' : ''}${f.locked ? ' xf-locked' : ''}">
    <div class="xf-bar"><span class="xf-title"></span>
      <span class="xf-btns">${
        live
          ? `<button data-action="done" title="Done (Esc, or click anywhere outside)">✓ Done</button>`
          : `${f.locked ? '<span class="xf-lock" title="Locked: a static picture (right-click › Unlock)">🔒</span>' : '<button data-action="edit" title="Draw here (double-click, ↵, or hover + R O D A T P L)">✏️</button>'}<button data-action="full" title="Open full screen">⤢</button>`
      }</span></div>
    <div class="xf-body" style="height:${n.height - BAR}px"></div>
    <div class="xf-grip" title="Resize"></div></div>`;
  (el.querySelector('.xf-title') as HTMLElement).textContent = f.title || 'Excalidraw';
  el.querySelector('.xf-grip')!.addEventListener('pointerdown', (e) => resizeFrame(app, n.id, e as PointerEvent));
  const body = el.querySelector('.xf-body') as HTMLElement;
  if (live) return;
  const els = liveElements(n);
  if (!els.length) {
    lastSvg.delete(n.id);
    body.innerHTML = `<div class="xf-empty">${f.locked ? 'Empty drawing' : 'Double-click to draw<br><small>or hover and press R, O, D, A, T, P, L</small>'}</div>`;
    return;
  }
  const old = lastSvg.get(n.id);
  if (old) place(n, body, old);
  else body.innerHTML = `<small class="xf-loading">Loading drawing…</small>`;
  const seq = ++renderSeq;
  renders.set(el, seq);
  lib()
    .then((m) => m.renderSvg(els))
    .then((p) => {
      if (renders.get(el) !== seq) return;
      lastSvg.set(n.id, p);
      place(n, body, p);
    })
    .catch((e) => {
      if (renders.get(el) === seq) body.innerHTML = `<small class="xf-loading">Can't draw this: ${esc(String(e?.message ?? e).slice(0, 80))}</small>`;
    });
}

/** Drag the corner grip: the frame's size (one undo step). */
function resizeFrame(app: App, id: string, e: PointerEvent) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const n = app.node(id);
  if (!n) return;
  const z = app.viewport.zoom;
  const start = { x: e.clientX, y: e.clientY, w: n.width, h: n.height };
  let first = true;
  // on window: each size change re-renders the frame (the grip element is replaced)
  const move = (m: PointerEvent) => {
    if (m.pointerId !== e.pointerId) return;
    if (first) app.store.newUndoStep();
    app.dispatch('excalidraw.frame', { id, width: start.w + (m.clientX - start.x) / z, height: start.h + (m.clientY - start.y) / z }, { merge: !first });
    first = false;
  };
  const up = (m: PointerEvent) => {
    if (m.pointerId !== e.pointerId) return;
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
}

/** The open editor, if any (one at a time). */
let editing: { id: string; close(): void } | null = null;

const bodyOf = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"] .xf-body`);

/**
 * Open a frame's drawing. In the frame (default): Excalidraw over the frame's body, with the frame's
 * view; it follows the frame as the table pans, zooms or the frame moves. Full screen: on its own
 * white page.
 */
async function open(app: App, id: string, o: { full?: boolean; tool?: string } = {}) {
  if (editing?.id === id) return;
  editing?.close();
  const n0 = app.node(id);
  if (!n0 || !isDrawing(n0)) return;
  const locked = !!frameOf(n0).locked;
  if (locked && !o.full) return app.notify('Locked: a static picture. Right-click › Unlock to draw in it');
  const inFrame = !o.full;
  const overlay = document.createElement('div');
  overlay.className = inFrame ? 'xd-overlay xd-inframe' : 'xd-overlay';
  document.body.append(overlay);
  if (inFrame) {
    liveId = id;
    app.view.render();
  }
  // keys typed in the editor are Excalidraw's (it listens on document): keep them from the table (window)
  const stopKeys = (e: KeyboardEvent) => e.stopPropagation();
  // leave keys: seen first (capture), before Excalidraw acts on them (it stops Escape)
  const leaveKeys = (e: KeyboardEvent) => {
    // typing (Excalidraw's text, its inputs, the frame's title being renamed): its keys are the text's
    if (e.type !== 'keydown' || (document.activeElement instanceof Element && document.activeElement.closest(TEXT_INPUT))) return;
    // Esc: first lets go of the selection (Excalidraw keeps it), then leaves
    if (e.key === 'Escape' && handle && !handle.idle() && handle.deselect()) return;
    if (((e.metaKey || e.ctrlKey) && e.key === 'Enter') || (e.key === 'Escape' && handle?.idle())) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  // a file dropped on the editor is Excalidraw's too (the table would open it as the whole board)
  const stopDrop = (e: DragEvent) => e.stopPropagation();
  // in the frame: a press anywhere outside it leaves, and still does what it does on the table
  const outside = (e: PointerEvent) => {
    if (!inFrame) return;
    const t = e.target as Element;
    // Excalidraw's own UI (menus in the overlay, dialogs it puts on <body>); the frame's bar and grip
    if (overlay.contains(t) || t.closest?.(`.excalidraw, [data-node-id="${CSS.escape(id)}"]`)) return;
    close();
  };
  const events = [['keydown', stopKeys], ['keyup', stopKeys], ['dragover', stopDrop], ['drop', stopDrop]] as const;
  for (const [t, f] of events) document.addEventListener(t, f as EventListener);
  window.addEventListener('keydown', leaveKeys, true);
  window.addEventListener('pointerdown', outside, true);
  let session: unknown; // this editing session's table undo step
  const unsubs: (() => void)[] = [];
  let closed = false;
  let handle: EditorHandle | undefined;
  /** The frame's view as Excalidraw moves it (saved when you leave). */
  let inner: View = viewOf(n0);
  let moved = false;
  let tableZoom = app.viewport.zoom;
  let raf = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    if (handle) lastTool.set(id, handle.tool());
    handle?.close();
    for (const u of unsubs) u();
    for (const [t, f] of events) document.removeEventListener(t, f as EventListener);
    window.removeEventListener('keydown', leaveKeys, true);
    window.removeEventListener('pointerdown', outside, true);
    overlay.remove();
    if (editing?.id === id) editing = null;
    if (liveId === id) liveId = null;
    // where you left the drawing is where the frame shows it (not an undo step)
    if (inFrame && moved && app.node(id)) app.dispatch('excalidraw.frame', { id, view: inner }, { undoable: false });
    app.view.render();
  };
  editing = { id, close };
  let m: typeof import('./lib');
  try {
    m = await lib();
  } catch (e) {
    close();
    app.notify(`Couldn't load Excalidraw: ${(e as Error).message}`);
    return;
  }
  const n = app.node(id); // read after the load: changes made meanwhile are in
  if (closed) return;
  if (!n) return close(); // deleted meanwhile
  // keep the overlay on the frame's body: the table pans/zooms, the frame moves or is resized
  const follow = () => {
    raf = requestAnimationFrame(follow);
    const body = bodyOf(id);
    if (!body) return;
    const r = body.getBoundingClientRect();
    const s = overlay.style;
    const want = [`${r.left}px`, `${r.top}px`, `${r.width}px`, `${r.height}px`];
    if (s.left !== want[0] || s.top !== want[1] || s.width !== want[2] || s.height !== want[3]) Object.assign(s, { left: want[0], top: want[1], width: want[2], height: want[3] });
    const z = app.viewport.zoom;
    if (z !== tableZoom) {
      tableZoom = z;
      handle?.camera({ scrollX: -inner.x, scrollY: -inner.y, zoom: inner.zoom * z });
    }
  };
  if (inFrame) follow();
  handle = m.mountEditor(overlay, {
    elements: elementsOf(n),
    title: frameOf(n).title || 'Drawing',
    onDone: close,
    tool: o.tool ?? lastTool.get(id),
    viewOnly: locked,
    onLocal(changed: XElement[]) {
      if (!app.node(id)) return; // deleted meanwhile (someone else)
      const stack = app.store.undoManager.undoStack;
      // one undo step per session; a new one if the table's undo took the session's step back
      const merge = !!session && stack.at(-1) === session;
      if (!merge) app.store.newUndoStep();
      app.dispatch('excalidraw.put', { id, elements: changed }, { merge });
      session = stack.at(-1);
    },
    inPlace: inFrame
      ? {
          // Excalidraw: screen = (scene + scroll) * zoom, inside the frame's body (scaled by the table)
          camera: { scrollX: -inner.x, scrollY: -inner.y, zoom: inner.zoom * tableZoom },
          onCamera(c) {
            inner = { x: -c.scrollX, y: -c.scrollY, zoom: c.zoom / tableZoom };
            moved = true;
          },
        }
      : undefined,
  });
  let last = n[NS];
  unsubs.push(
    app.store.subscribe(() => {
      const cur = app.node(id);
      if (!cur) return close(); // the drawing was deleted
      if (inFrame && frameOf(cur).locked) return close(); // someone locked it
      if (cur[NS] === last) return;
      last = cur[NS];
      handle!.remote(elementsOf(cur));
    }),
  );
}

const shapesCount = (n: CanvasNode) => liveElements(n).filter((e) => !(e.type === 'text' && e.containerId)).length;

/** The frame whose title is being renamed, and its render key at the start. */
let renaming: string | null = null;
let frozenKey: string | null = null;

function rename(app: App, id: string) {
  const t = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"] .xf-title`);
  const n = app.node(id);
  if (!t || !n) return;
  renaming = id;
  frozenKey = JSON.stringify([n[NS], n[FRAME], n.width, n.height, n.id === liveId]);
  const end = () => {
    renaming = frozenKey = null;
  };
  inlineEdit(t, {
    enterCommits: true,
    escapeCancels: true,
    onCommit: (title) => {
      end();
      app.dispatch('excalidraw.frame', { id, title });
      app.view.render();
    },
    onCancel: () => {
      end();
      app.view.render();
    },
  });
}

export const excalidrawPlugin: Plugin = {
  id: 'excalidraw',
  setup(app) {
    useLogic(app.store, logic);
    // pictures of frames that are gone
    app.store.subscribe(() => {
      for (const id of lastSvg.keys()) if (!app.node(id)) lastSvg.delete(id);
    });
    // Lucide "pencil" (ISC, see LICENSES/lucide.txt)
    ICONS.pencil ??= '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>';
    app.registerType({
      id: 'excalidraw',
      match: isDrawing,
      // while its title is being renamed the frame isn't redrawn (that would drop the edit)
      renderKey: (n) => (n.id === renaming && frozenKey ? frozenKey : JSON.stringify([n[NS], n[FRAME], n.width, n.height, n.id === liveId])),
      render: (n, el) => render(n, el, app),
      onDoubleClick: (n, a) => void open(a, n.id),
      onAction(n, action, a) {
        if (action === 'edit') void open(a, n.id);
        else if (action === 'full') void open(a, n.id, { full: true });
        else if (action === 'done') editing?.close();
      },
    });

    // the frame tool: drag a frame out on the table (a click: default size), then draw in it
    const make = (a: App, box: { x: number; y: number; width: number; height: number }) => {
      const sized = box.width > 20 && box.height > 20;
      const id = a.dispatch('excalidraw.create', sized ? box : { x: box.x, y: box.y }).select?.[0];
      if (id) void open(a, id);
    };
    app.registerTool({ id: 'excalidraw.frame', label: 'Excalidraw frame', title: 'Excalidraw frame: drag on the table (or click), then draw', owns: isDrawing, create: make });
    app.registerDockItem({
      id: 'excalidraw.frame',
      label: 'Excalidraw frame',
      icon: 'pencil',
      section: 'create',
      active: (a) => a.view.tool === 'excalidraw.frame',
      run: (a) => a.view.setTool(a.view.tool === 'excalidraw.frame' ? 'select' : 'excalidraw.frame'),
    });
    app.registerKit({ id: 'excalidraw.frame', label: 'Excalidraw frame', create: (a, at) => make(a, { ...at, width: 0, height: 0 }) });

    // Enter and the tool letters are shared (event storm, prototype, diagram, cards): chain onto what's bound
    const chain = (key: string, mine: (a: App) => boolean, run: (a: App) => void, label: string) => {
      const prev = app.keys.get(key);
      app.registerKey({
        key,
        label,
        when: (a) => mine(a) || (!!prev && (!prev.when || prev.when(a))),
        run: (a) => (mine(a) ? run(a) : prev?.run(a)),
      });
    };
    const selFrame = (a: App) => (a.selected().length === 1 && isDrawing(a.selected()[0]) ? a.selected()[0] : undefined);
    chain('enter', (a) => !!selFrame(a), (a) => void open(a, selFrame(a)!.id), 'Draw in the frame');
    // hover a frame + an Excalidraw tool key: jump in with that tool
    const hoveredFrame = (a: App) => {
      const h = a.view.hovered ? a.node(a.view.hovered) : undefined;
      return h && isDrawing(h) && !frameOf(h).locked && h.id !== liveId ? h : undefined;
    };
    // (seen before the table's own key handling, so plugins loaded later can't take these letters over a frame)
    window.addEventListener(
      'keydown',
      (e) => {
        const tool = TOOL_KEYS[e.key.toLowerCase()];
        // only a plain letter with nothing selected (a selection keeps its keys: cards, notes…)
        if (!tool || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || editing || app.store.selection.size) return;
        if (e.target instanceof Element && e.target.closest(TEXT_INPUT)) return;
        const f = hoveredFrame(app);
        if (!f) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        void open(app, f.id, { tool });
      },
      true,
    );

    app.registerMenu((a, sel) => {
      if (sel.length !== 1 || !isDrawing(sel[0])) return undefined;
      const n = sel[0];
      const f = frameOf(n);
      const count = shapesCount(n);
      return {
        title: f.title ? `${f.title} (Excalidraw)` : 'Excalidraw frame',
        entries: [
          { label: 'Draw here', hint: '↵', disabled: f.locked ? 'Locked' : false, run: () => void open(a, n.id) },
          { label: 'Open full screen', run: () => void open(a, n.id, { full: true }) },
          { label: 'Rename…', separator: true, run: () => rename(a, n.id) },
          { label: f.locked ? 'Unlock (draw in it again)' : 'Lock (static picture)', checked: !!f.locked, run: () => void a.dispatch('excalidraw.frame', { id: n.id, locked: !f.locked }) },
          { label: 'Fit the drawing in the frame', disabled: f.view ? false : 'Already fitted', run: () => void a.dispatch('excalidraw.frame', { id: n.id, view: null }) },
          { label: count ? `${count} shape${count === 1 ? '' : 's'}` : 'Empty drawing', disabled: true },
        ],
      };
    });
  },
};
