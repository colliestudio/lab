import './frames.css';
import type { App, CanvasNode, Command, Plugin, Store } from '../../core';
import { askText } from '../mats/textDialog';
import { flyTo, stopFlight } from './camera';
import { commands } from './commands';
import { seedDemo } from './demo';
import { frameAt, frameField, frameTitle, isFrame, isPortal, isRoomId, memberships, orderedFrames, outline, portalRoom, portalTitle, slides } from './model';
import { mountOutline } from './outline';
import { PortalViews, type Connect } from './portals';
import { Presenter } from './present';

export interface FramesOptions {
  /** The room this page is in (null = the solo table): a portal can't show its own room. */
  room: string | null;
  /** Go into another room (double-click on a portal). */
  enter(room: string): void;
  /** Transport for portal rooms (tests: null = local only). */
  connect?: Connect | null;
  /**
   * Portals on (default off). A portal joins the other room as a full peer, so until the host can
   * enforce read-only and refuse rooms they stay behind this flag. Frames, outline, keys and
   * presenting don't depend on it.
   */
  portals?: boolean;
}

const PORTALS_KEY = 'canvas-poc:portals';
/**
 * The portals flag for this browser: `?portals=1` turns it on (and remembers it, so rooms entered
 * through a portal keep it), `?portals=0` turns it off again.
 */
export function portalsEnabled(): boolean {
  if (typeof location === 'undefined') return false;
  try {
    const q = new URLSearchParams(location.search).get('portals');
    if (q === '1') localStorage.setItem(PORTALS_KEY, '1');
    else if (q === '0') localStorage.removeItem(PORTALS_KEY);
    return localStorage.getItem(PORTALS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Membership rule state: while a pointer is down the frame of every node is frozen at what it was
 * at the press, so a frame dragged over other objects doesn't scoop them up on the way (geometry
 * decides again on release).
 */
let frozen: Map<string, string> | null = null;
/** Freeze frame membership as it is in `nodes` (until `thaw`). */
export function freezeMembership(nodes: readonly CanvasNode[]) {
  frozen = memberships(nodes);
}
/** Back to geometry; true if it was frozen (the caller should invalidate its store). */
export function thawMembership(): boolean {
  const was = frozen !== null;
  frozen = null;
  return was;
}

/** The data side (commands, rider rule). No DOM; used by tests and could run in a bridge/agent host. */
export function registerFramesLogic(store: Store) {
  for (const [name, cmd] of Object.entries(commands)) store.register(`frames.${name}`, cmd as Command);
  // Registered after other plugins' rider rules (a piece rides its board, the board rides the frame).
  store.addRiderRule((n, get, all) => {
    if (!frozen) return frameAt(n, all);
    const f = frozen.get(n.id);
    return f && get(f) ? f : undefined;
  });
}

/** Which frame the camera is on: the one holding the screen center (innermost), else the nearest. */
export function currentFrame(app: App): CanvasNode | undefined {
  const c = app.viewCenter();
  const list = orderedFrames(app.doc);
  const holding = list.filter((f) => c.x > f.x && c.x < f.x + f.width && c.y > f.y && c.y < f.y + f.height).sort((a, b) => a.width * a.height - b.width * b.height);
  if (holding[0]) return holding[0];
  let best: CanvasNode | undefined;
  let bd = Infinity;
  for (const f of list) {
    const d = Math.hypot(f.x + f.width / 2 - c.x, f.y + f.height / 2 - c.y);
    if (d < bd) [best, bd] = [f, d];
  }
  return best;
}

export function createFramesPlugin(opts: FramesOptions): Plugin & { portals?: PortalViews; presenter?: Presenter } {
  const plugin: Plugin & { portals?: PortalViews; presenter?: Presenter } = {
    id: 'frames',
    setup(app) {
      registerFramesLogic(app.store);
      const portalsOn = !!opts.portals;
      const portals = portalsOn ? new PortalViews(app, { currentRoom: opts.room, connect: opts.connect }) : undefined;
      const presenter = new Presenter(app);
      plugin.portals = portals;
      plugin.presenter = presenter;

      // freeze membership for the length of a press (see `frozen`)
      const root = app.view.root;
      // Slide order is reading order until written down; do that before a frame can move.
      const pin = () => {
        if (app.doc.nodes.filter(isFrame).length > 1) app.dispatch('frames.pin', {});
      };
      root.addEventListener(
        'pointerdown',
        (e) => {
          if ((e.target as Element | null)?.closest?.('.fr-title') || app.selected().some(isFrame)) pin();
          freezeMembership(app.doc.nodes);
          stopFlight(app);
        },
        true,
      );
      window.addEventListener(
        'keydown',
        (e) => {
          if (e.key.startsWith('Arrow') && app.selected().some(isFrame)) pin();
        },
        true,
      );
      const thaw = () => {
        if (thawMembership()) app.store.invalidate();
      };
      window.addEventListener('pointerup', thaw);
      window.addEventListener('pointercancel', thaw);
      root.addEventListener('wheel', () => stopFlight(app), { capture: true, passive: true });

      const go = (n: CanvasNode | undefined) => {
        if (n) void flyTo(app, n, { pad: 48 });
      };
      const rename = async (n: CanvasNode) => {
        const v = await askText(isFrame(n) ? 'Rename the frame' : 'Name the portal', n.label ?? (isFrame(n) ? frameTitle(n) : portalTitle(n)), 'Save', 80);
        if (v) app.dispatch('frames.rename', { id: n.id, label: v });
      };
      const askRoom = async (current = '') => {
        const v = await askText('Portal to which room? (its id, e.g. the ?room= of its link)', current, 'Open portal', 63);
        const id = v?.toLowerCase();
        if (id && !isRoomId(id)) app.notify('A room id is lowercase letters, digits and dashes');
        return id && isRoomId(id) ? id : null;
      };
      const frameSelection = () => {
        const sel = app.selected().filter((n) => !isFrame(n) || app.store.selection.size > 1);
        if (sel.length) app.dispatch('frames.create', { around: sel.map((n) => n.id) });
        else {
          const c = app.viewCenter();
          app.dispatch('frames.create', { x: c.x - 320, y: c.y - 210 });
        }
      };
      const resizeFrom = (id: string, e: PointerEvent) => {
        e.stopPropagation();
        e.preventDefault();
        const n0 = app.node(id);
        if (!n0) return;
        const [x0, y0] = [e.clientX, e.clientY];
        const zoom = app.viewport.zoom;
        app.store.newUndoStep();
        const move = (ev: PointerEvent) => app.dispatch('frames.resize', { id, width: n0.width + (ev.clientX - x0) / zoom, height: n0.height + (ev.clientY - y0) / zoom }, { merge: true });
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };
      const onTitle = (down: PointerEvent) => !!(down.target as Element | null)?.closest?.('.fr-title, .fr-portal-head');

      // ------------------------------------------------------------ frame
      app.registerType({
        id: 'frame',
        match: isFrame,
        render(node, el, ctx) {
          const i = orderedFrames(ctx.doc).findIndex((f) => f.id === node.id);
          const n = slides(ctx.doc).findIndex((f) => f.id === node.id);
          el.innerHTML = `<div class="fr-frame"><div class="fr-title"><b></b><span class="fr-num"></span></div><div class="fr-resize" title="Resize"></div></div>`;
          el.querySelector('b')!.textContent = frameTitle(node, i);
          const num = el.querySelector<HTMLElement>('.fr-num')!;
          num.textContent = n >= 0 ? String(n + 1) : 'not in slides';
          num.classList.toggle('fr-skipped', n < 0);
          if (node.color) el.style.setProperty('--fr-color', /^[1-6]$/.test(node.color) ? `var(--fr-c${node.color})` : node.color);
          el.querySelector<HTMLElement>('.fr-resize')!.addEventListener('pointerdown', (e) => resizeFrom(node.id, e));
        },
        renderKey(node, ctx) {
          const n = slides(ctx.doc).findIndex((f) => f.id === node.id);
          const i = orderedFrames(ctx.doc).findIndex((f) => f.id === node.id);
          return `${node.label ?? ''}|${node.color ?? ''}|${i}|${n}`;
        },
        grabbable: (_n, down) => onTitle(down),
        boxSelectable: () => false,
        canDrop: () => false,
        onDoubleClick: (n) => void rename(n),
      });

      // ------------------------------------------------------------ portal
      if (portals)
      app.registerType({
        id: 'portal',
        match: isPortal,
        render(node, el) {
          el.innerHTML = `<div class="fr-portal"><div class="fr-portal-head"><span class="fr-portal-name"></span><span class="fr-portal-status"></span><button class="fr-portal-enter" data-action="enter" title="Go into this room (or double-click)">Enter ↗</button></div><div class="fr-portal-body"></div><div class="fr-resize" title="Resize"></div></div>`;
          el.querySelector('.fr-portal-name')!.textContent = `⧉ ${portalTitle(node)}`;
          el.querySelector<HTMLElement>('.fr-resize')!.addEventListener('pointerdown', (e) => resizeFrom(node.id, e));
          portals!.mount(node, el.querySelector<HTMLElement>('.fr-portal-body')!, el.querySelector<HTMLElement>('.fr-portal-status')!);
        },
        renderKey: (node) => `${portalRoom(node) ?? ''}|${node.label ?? ''}|${node.width}x${node.height}`,
        canDrop: () => false,
        onAction(node, action) {
          const room = portalRoom(node);
          if (action === 'enter' && room && room !== opts.room) opts.enter(room);
        },
        onDoubleClick(node) {
          const room = portalRoom(node);
          if (room && room !== opts.room) opts.enter(room);
        },
      });

      // ------------------------------------------------------------ menus, keys, kits
      app.registerMenu((a, sel) => {
        if (sel.length === 1 && isFrame(sel[0])) {
          const f = sel[0];
          const list = orderedFrames(a.doc);
          const i = list.findIndex((x) => x.id === f.id);
          const skip = !!frameField(f).skip;
          return {
            title: `Frame: ${frameTitle(f, i)}`,
            entries: [
              { label: 'Rename…', run: () => void rename(f) },
              { label: 'In the presentation', checked: !skip, run: () => a.dispatch('frames.skip', { id: f.id, skip: !skip }) },
              { label: 'Earlier in order', disabled: i === 0, run: () => a.dispatch('frames.reorder', { id: f.id, to: i - 1 }) },
              { label: 'Later in order', disabled: i === list.length - 1, run: () => a.dispatch('frames.reorder', { id: f.id, to: i + 1 }) },
              { label: 'Present from here', hint: '⌘↵', disabled: skip && 'Not in the presentation', run: () => presenter.start(f.id) },
              { label: 'Remove frame, keep contents', separator: true, run: () => a.dispatch('frames.unframe', { id: f.id }) },
              { label: 'Delete frame and contents', hint: '⌫', run: () => a.dispatch('core.delete', { ids: [f.id] }) },
            ],
          };
        }
        if (portalsOn && sel.length === 1 && isPortal(sel[0])) {
          const p = sel[0];
          const room = portalRoom(p);
          return {
            title: `Portal: ${portalTitle(p)}`,
            entries: [
              { label: 'Enter the room', hint: 'double-click', disabled: !room ? 'No room set' : room === opts.room && 'It is this room', run: () => room && opts.enter(room) },
              { label: 'Name…', run: () => void rename(p) },
              {
                label: 'Point at another room…',
                run: async () => {
                  const r = await askRoom(room);
                  if (r) a.dispatch('frames.retarget', { id: p.id, room: r });
                },
              },
            ],
          };
        }
        if (sel.length && !sel.every(isFrame)) return { entries: [{ label: 'Frame selection', hint: '⇧F', run: frameSelection }] };
        return undefined;
      });

      app.registerKey({ key: 'shift+f', label: 'Frame the selection (or a new frame)', run: frameSelection });
      app.registerKey({ key: ']', label: 'Next frame', run: () => step(1) });
      app.registerKey({ key: '[', label: 'Previous frame', run: () => step(-1) });
      for (let d = 1; d <= 9; d++) app.registerKey({ key: String(d), label: `Go to frame ${d}`, run: () => go(orderedFrames(app.doc)[d - 1]) });
      app.registerKey({ key: 'mod+enter', label: 'Present', run: () => presenter.start() });
      const step = (dir: 1 | -1) => {
        const list = orderedFrames(app.doc);
        if (!list.length) return;
        const cur = currentFrame(app);
        const i = cur ? list.indexOf(cur) : -1;
        // not on a frame yet: ] goes to the first, [ to the last
        go(list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length]);
      };

      app.registerKit({
        id: 'frames.frame',
        label: 'Frame (around the selection)',
        create: () => frameSelection(),
      });
      if (portalsOn)
        app.registerKit({
          id: 'frames.portal',
          label: 'Portal to another room…',
          create: async (a, at) => {
            const room = await askRoom();
            if (room) a.dispatch('frames.createPortal', { ...at, room });
          },
        });
      app.registerKit({
        id: 'frames.demo',
        label: portalsOn ? 'Frames demo: 3 frames + a portal into a chess room' : 'Frames demo: 3 frames',
        create: (a) => void seedDemo(a, portalsOn).then((ids) => ids && flyTo(a, boundsOf(a, ids), { pad: 60 })),
      });

      if (typeof document !== 'undefined') mountOutline(app, { portals: portalsOn, go, present: (id) => presenter.start(id), enter: opts.enter, rename, currentRoom: opts.room });
      // for agents and the console: what an outline reader sees
      (app as unknown as { frames?: unknown }).frames = { outline: () => outline(app.doc, { portals: portalsOn }), go: (id: string) => go(app.node(id)), present: (id?: string) => presenter.start(id) };
    },
  };
  return plugin;
}

function boundsOf(app: App, ids: string[]) {
  const ns = ids.map((id) => app.node(id)).filter((n): n is CanvasNode => !!n);
  const x = Math.min(...ns.map((n) => n.x));
  const y = Math.min(...ns.map((n) => n.y));
  return { x, y, width: Math.max(...ns.map((n) => n.x + n.width)) - x, height: Math.max(...ns.map((n) => n.y + n.height)) - y };
}

export { attachFollow } from './present';
export { enterUrl, mountBreadcrumb, trailFromUrl } from './nav';
