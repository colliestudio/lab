import type { App, CanvasNode } from '../../core';
import { visibleWorld } from './camera';
import { isFrame, isPortal, outline, type OutlineEntry } from './model';

// Outline panel (top right): frames in presentation order with the portals inside them, a
// minimap of the whole canvas with the current view, and the Present button. O toggles it.

export interface OutlineHooks {
  go(n: CanvasNode | undefined): void;
  present(fromId?: string): void;
  enter(room: string): void;
  rename(n: CanvasNode): void;
  currentRoom: string | null;
}

const MM_W = 220;
const MM_H = 140;

export function mountOutline(app: App, hooks: OutlineHooks) {
  const panel = document.createElement('div');
  panel.className = 'fr-outline';
  panel.innerHTML = `
    <div class="fr-ol-head"><b>Outline</b><button class="fr-ol-present" title="Present the frames as slides (⌘↵)">▶ Present</button><button class="fr-ol-fold" title="Hide / show (O)">–</button></div>
    <div class="fr-ol-list"></div>
    <canvas class="fr-ol-map" width="${MM_W * 2}" height="${MM_H * 2}" title="Click or drag to move the view"></canvas>
    <div class="fr-ol-hint">1–9 jump · [ ] prev/next · ⇧F frame selection</div>`;
  document.body.append(panel);
  const list = panel.querySelector<HTMLElement>('.fr-ol-list')!;
  const map = panel.querySelector<HTMLCanvasElement>('.fr-ol-map')!;
  map.style.width = `${MM_W}px`;
  map.style.height = `${MM_H}px`;
  const fold = () => {
    panel.classList.toggle('fr-folded');
    schedule();
  };
  panel.querySelector('.fr-ol-fold')!.addEventListener('click', fold);
  panel.querySelector('.fr-ol-present')!.addEventListener('click', () => hooks.present());
  app.registerKey({ key: 'o', label: 'Outline', run: fold });

  // ---------------------------------------------------------------- list
  let listKey = '';
  const drawList = (entries: OutlineEntry[]) => {
    const cur = currentId(app, entries);
    const key = JSON.stringify([entries.map((e) => [e.id, e.title, e.slide, e.depth, e.count, e.room]), cur]);
    if (key === listKey) return;
    listKey = key;
    if (!entries.length) {
      list.innerHTML = `<div class="fr-ol-empty">No frames yet. Select some objects and press ⇧F, or Add… → Frame.</div>`;
      return;
    }
    const frames = entries.filter((e) => e.kind === 'frame');
    list.replaceChildren(
      ...entries.map((e) => {
        const row = document.createElement('div');
        row.className = `fr-ol-row fr-ol-${e.kind}`;
        row.dataset.id = e.id;
        row.style.paddingLeft = `${8 + e.depth * 14}px`;
        row.classList.toggle('fr-ol-current', e.id === cur);
        const badge = document.createElement('span');
        badge.className = 'fr-ol-badge';
        const title = document.createElement('span');
        title.className = 'fr-ol-title';
        title.textContent = e.title;
        const meta = document.createElement('span');
        meta.className = 'fr-ol-meta';
        if (e.kind === 'frame') {
          badge.textContent = e.slide ? String(e.slide) : '–';
          badge.title = e.slide ? `Slide ${e.slide}` : 'Not in the presentation';
          meta.textContent = e.count ? String(e.count) : '';
          meta.title = `${e.count} object${e.count === 1 ? '' : 's'} in it`;
          const i = frames.indexOf(e);
          const up = btn('↑', 'Earlier', () => app.dispatch('frames.reorder', { id: e.id, to: i - 1 }), i === 0);
          const down = btn('↓', 'Later', () => app.dispatch('frames.reorder', { id: e.id, to: i + 1 }), i === frames.length - 1);
          row.append(badge, title, meta, up, down);
        } else {
          badge.textContent = '⧉';
          meta.textContent = e.room ?? '?';
          const enter = btn('↗', 'Enter the room', () => e.room && hooks.enter(e.room), !e.room || e.room === hooks.currentRoom);
          row.append(badge, title, meta, enter);
        }
        row.addEventListener('click', (ev) => {
          if ((ev.target as Element).closest('button')) return;
          hooks.go(app.node(e.id));
        });
        row.addEventListener('dblclick', (ev) => {
          if ((ev.target as Element).closest('button')) return;
          const n = app.node(e.id);
          if (n && isFrame(n)) hooks.rename(n);
          else if (e.room && e.room !== hooks.currentRoom) hooks.enter(e.room);
        });
        return row;
      }),
    );
  };

  // ---------------------------------------------------------------- minimap
  let mapT = { s: 1, ox: 0, oy: 0 };
  const drawMap = (keepScale = false) => {
    if (panel.classList.contains('fr-folded')) return;
    const ctx = map.getContext('2d');
    if (!ctx) return;
    const doc = app.doc;
    const nodes = doc.visible.filter((n) => !app.isConcealed(n));
    const root = app.view.root;
    const seen = visibleWorld(app.viewport, root.clientWidth || 1, root.clientHeight || 1);
    const all = [...nodes, { ...seen }];
    const minX = Math.min(...all.map((n) => n.x));
    const minY = Math.min(...all.map((n) => n.y));
    const maxX = Math.max(...all.map((n) => n.x + n.width));
    const maxY = Math.max(...all.map((n) => n.y + n.height));
    const pad = 8;
    if (!keepScale) {
      const s = Math.min((MM_W - 2 * pad) / Math.max(1, maxX - minX), (MM_H - 2 * pad) / Math.max(1, maxY - minY));
      mapT = { s, ox: (MM_W - (maxX - minX) * s) / 2 - minX * s, oy: (MM_H - (maxY - minY) * s) / 2 - minY * s };
    }
    const { s, ox, oy } = mapT;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, MM_W, MM_H);
    const r = (n: { x: number; y: number; width: number; height: number }) => [n.x * s + ox, n.y * s + oy, Math.max(1, n.width * s), Math.max(1, n.height * s)] as const;
    for (const n of nodes) {
      if (isFrame(n)) {
        ctx.fillStyle = 'rgba(120, 190, 255, 0.10)';
        ctx.fillRect(...r(n));
        ctx.strokeStyle = 'rgba(140, 200, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(...r(n));
      } else {
        ctx.fillStyle = isPortal(n) ? 'rgba(190, 140, 255, 0.85)' : 'rgba(230, 236, 232, 0.55)';
        ctx.fillRect(...r(n));
      }
    }
    ctx.strokeStyle = '#ffd54a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(...r(seen));
  };
  const moveTo = (e: PointerEvent) => {
    const b = map.getBoundingClientRect();
    const wx = (e.clientX - b.left - mapT.ox) / mapT.s;
    const wy = (e.clientY - b.top - mapT.oy) / mapT.s;
    const vp = app.viewport;
    const root = app.view.root;
    vp.set(root.clientWidth / 2 - wx * vp.zoom, root.clientHeight / 2 - wy * vp.zoom, vp.zoom);
  };
  map.addEventListener('pointerdown', (e) => {
    map.setPointerCapture(e.pointerId);
    // the map's scale is frozen while dragging (else the box under the pointer would run away)
    dragging = true;
    moveTo(e);
  });
  map.addEventListener('pointermove', (e) => dragging && moveTo(e));
  const end = () => {
    dragging = false;
    schedule();
  };
  map.addEventListener('pointerup', end);
  map.addEventListener('pointercancel', end);
  let dragging = false;

  // ---------------------------------------------------------------- redraw (one per frame)
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      drawList(outline(app.doc));
      drawMap(dragging);
    });
  };
  app.store.subscribe(schedule);
  app.viewport.onChange(schedule);
  window.addEventListener('resize', schedule);
  schedule();
  return panel;
}

function btn(text: string, title: string, run: () => void, disabled = false) {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.disabled = disabled;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

/** The entry the camera is on: the innermost frame holding the view's center. */
function currentId(app: App, entries: OutlineEntry[]): string | undefined {
  const c = app.viewCenter();
  let best: OutlineEntry | undefined;
  for (const e of entries) {
    if (e.kind !== 'frame') continue;
    const r = e.rect;
    if (c.x > r.x && c.x < r.x + r.width && c.y > r.y && c.y < r.y + r.height && (!best || r.width * r.height < best.rect.width * best.rect.height)) best = e;
  }
  return best?.id;
}
