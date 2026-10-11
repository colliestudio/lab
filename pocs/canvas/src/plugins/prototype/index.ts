import './prototype.css';
import type { CanvasNode, MenuEntry, Plugin } from '../../core';
import { pageFrame, readMessage } from './bridge';
import { NOTE_H, autoLinkChanges } from './commands';
import { mountEdges, type EdgeLayer } from './edges';
import { editNote, editPage } from './editor';
import { History } from './history';
import { registerPrototypeLogic } from './logic';
import { DEVICES, HEADER, docHeight, isNote, isPage, note, outgoing, page, pages, resolveLink, startPage, titleOf } from './model';
import { Player, mountFollowBanner } from './play';
import { askText } from '../mats/textDialog';

export { registerPrototypeLogic } from './logic';

// Prototype pages on the canvas: each page is a live, sandboxed HTML document scaled into its node.
// A page is a draggable thumbnail until you turn on Interact (I, or its ✋ button): then it takes
// clicks, and its links follow the canvas edges (the view glides to the next page). Play (⇧↵)
// shows the flow full screen.

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export const prototypePlugin: Plugin = {
  id: 'prototype',
  setup(app) {
    registerPrototypeLogic(app.store);
    const player = new Player(app);
    let edges: EdgeLayer | undefined;
    queueMicrotask(() => (edges = mountEdges(app)));
    (app as any).prototype = { player }; // console / agents

    // ------------------------------------------------------------ interact mode (local to this screen)
    const live = new Set<string>();
    /** Form state of pages clicked through on the canvas (Play keeps its own). */
    const state: Record<string, string> = {};
    const trail = new History('');
    const setLive = (id: string, on: boolean) => {
      if (on) live.add(id);
      else live.delete(id);
      const box = app.view.boxOf(id);
      box?.classList.toggle('pg-live', on);
      const b = box?.querySelector<HTMLElement>('[data-action="live"]');
      if (b) b.title = on ? 'Interacting: clicks go to the page (I to stop)' : 'Interact with the page (I)';
    };
    const reload = (id: string) => {
      const n = app.node(id);
      const f = app.view.boxOf(id)?.querySelector<HTMLIFrameElement>('iframe');
      if (f && isPage(n)) f.srcdoc = pageFrame(page(n).html, page(n).vw, 1, 1, state).srcdoc;
    };

    /** Glide the view so page `id` is in the middle (zoom kept unless it doesn't fit). */
    const glideTo = (id: string) => {
      const n = app.node(id);
      if (!n) return;
      const r = app.view.root;
      const vp = app.viewport;
      const zoom = Math.min(vp.zoom, (r.clientWidth - 80) / n.width, (r.clientHeight - 80) / n.height);
      const tx = r.clientWidth / 2 - (n.x + n.width / 2) * zoom;
      const ty = r.clientHeight / 2 - (n.y + n.height / 2) * zoom;
      const from = { x: vp.x, y: vp.y, zoom: vp.zoom };
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / 380);
        const e = 1 - Math.pow(1 - k, 3);
        vp.set(from.x + (tx - from.x) * e, from.y + (ty - from.y) * e, from.zoom + (zoom - from.zoom) * e);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    const goFrom = (from: string, target: string) => {
      const r = resolveLink(app.doc, from, target);
      if (!r) {
        app.notify(target ? `No link “${target}” from ${titleOf(app.node(from))}` : `${titleOf(app.node(from))} has no single next page`);
        return;
      }
      if (!r.edge) app.notify(`Went to ${titleOf(app.node(r.to))} (no edge on the canvas: right-click › Auto-link adds it)`);
      if (r.edge) edges?.flash(r.edge.id);
      if (trail.current !== from) trail.path = [from];
      trail.go(r.to);
      setLive(r.to, true);
      reload(r.to);
      app.store.select([r.to]);
      glideTo(r.to);
    };

    // messages from page frames on the canvas (Play's frame is handled by the player)
    window.addEventListener('message', (e) => {
      const m = readMessage(e.data);
      if (!m) return;
      const frame = [...app.view.world.querySelectorAll<HTMLIFrameElement>('iframe.pg-frame')].find((f) => f.contentWindow === e.source);
      const id = frame?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
      // only a page you're interacting with may act: an idle thumbnail's script can't move your view
      if (!id || !live.has(id)) return;
      if (m.kind === 'set') state[m.key] = m.value;
      else if (m.kind === 'goto') goFrom(id, m.target);
      else if (m.kind === 'escape') {
        setLive(id, false);
        app.view.root.focus({ preventScroll: true });
      }
      else if (trail.current === id && trail.back()) {
        reload(trail.current);
        app.store.select([trail.current]);
        glideTo(trail.current);
      } else app.notify('Back: nothing before this page on the canvas (Play keeps a full path)');
    });

    const play = (id?: string) => {
      const start = id ?? startPage(app.doc, [...app.store.selection]);
      if (!start) return app.notify('No pages to play: Add… › Prototype: example flow');
      player.start(start);
    };

    // ------------------------------------------------------------ object types
    app.registerType({
      id: 'page',
      match: isPage,
      renderKey: (n) => JSON.stringify([page(n), n.width, n.height]),
      render(n, el) {
        const f = page(n);
        const vh = docHeight(n);
        const s = n.width / f.vw;
        el.classList.toggle('pg-live', live.has(n.id));
        el.innerHTML = `<div class="pg-page${f.start ? ' pg-start' : ''}">
          <div class="pg-bar"><span class="pg-title">${f.start ? '<b class="pg-flag" title="Start page">▶</b>' : ''}${esc(f.title)}</span>
          <button data-action="live" title="Interact with the page (I)">✋</button><button data-action="play" title="Play from here (⇧↵)">▶</button></div>
          <div class="pg-body" style="height:${n.height - HEADER}px"></div></div>`;
        el.querySelector('.pg-body')!.append(pageFrame(f.html, f.vw, vh, s, state));
      },
      onAction(n, action) {
        if (action === 'live') setLive(n.id, !live.has(n.id));
        else if (action === 'play') play(n.id);
      },
      onDoubleClick: (n) => void edit(n),
    });
    app.registerType({
      id: 'page-note',
      match: isNote,
      render(n, el) {
        el.innerHTML = `<div class="pg-sticky"></div>`;
        el.firstElementChild!.textContent = n.text ?? '';
      },
      onDoubleClick: async (n) => {
        const t = await editNote(n.text ?? '');
        if (t !== null) app.dispatch('page.noteText', { id: n.id, text: t });
      },
      onDragEnd: (dragged) => void app.dispatch('page.attach', { ids: dragged.map((n) => n.id) }, { merge: true }),
    });

    const edit = async (n: CanvasNode) => {
      const f = page(n);
      const res = await editPage({ title: f.title, html: f.html, vw: f.vw }, (vw) => (vw === f.vw ? docHeight(n) : (DEVICES.find((d) => d.vw === vw)?.vh ?? 800)));
      if (!res) return;
      app.store.newUndoStep();
      app.store.merged(() => {
        app.dispatch('page.edit', { id: n.id, title: res.title, html: res.html });
        if (res.vw !== f.vw) app.dispatch('page.device', { id: n.id, vw: res.vw });
      });
    };

    // ------------------------------------------------------------ keys
    const selPage = () => app.selected().find(isPage);
    app.registerKey({ key: 'i', label: 'Interact with the page', when: () => !!selPage(), run: () => setLive(selPage()!.id, !live.has(selPage()!.id)) });
    app.registerKey({ key: 'shift+enter', label: 'Play the prototype', run: () => play() });
    app.registerKey({ key: 'enter', label: 'Edit the page', when: () => !!selPage(), run: () => void edit(selPage()!) });

    // ------------------------------------------------------------ menus
    const linkLabel = async (from: CanvasNode, to: CanvasNode, label = '') => {
      const l = await askText(`Link ${titleOf(from)} → ${titleOf(to)}: action label`, label || titleOf(to), 'Link', 60);
      if (l !== null) app.dispatch('page.link', { from: from.id, to: to.id, label: l });
    };
    app.registerMenu((app, sel) => {
      const doc = app.doc;
      if (!sel.length) {
        const any = pages(doc).length > 0;
        const at = app.viewCenter();
        return {
          entries: [
            { label: 'New page', run: () => app.dispatch('page.create', { x: at.x - 100, y: at.y - 200 }) },
            { label: 'Play prototype', hint: '⇧↵', disabled: !any && 'No pages yet', run: () => play() },
            { label: 'Arrange pages as a flow', disabled: !any && 'No pages yet', run: () => app.dispatch('page.arrange', {}) },
            { label: 'Auto-link page links', disabled: !any && 'No pages yet', run: () => autoLink() },
          ],
        };
      }
      if (sel.length === 1 && isPage(sel[0])) {
        const n = sel[0];
        const f = page(n);
        const others = pages(doc).filter((p) => p.id !== n.id);
        const out = outgoing(doc, n.id);
        const entries: MenuEntry[] = [
          { label: 'Edit page…', hint: '↵ / double-click', run: () => void edit(n) },
          { label: 'Interact', hint: 'I', checked: live.has(n.id), run: () => setLive(n.id, !live.has(n.id)) },
          { label: 'Play from here', hint: '▶', run: () => play(n.id) },
          { label: 'Start page', checked: !!f.start, run: () => app.dispatch('page.start', { id: n.id }) },
          {
            label: 'Link to',
            separator: true,
            items: others.length ? others.map((p) => ({ label: titleOf(p), checked: out.some((e) => e.toNode === p.id), run: () => void linkLabel(n, p, out.find((e) => e.toNode === p.id)?.label) })) : [{ label: 'No other pages', disabled: true }],
          },
          {
            label: `Links from here (${out.length})`,
            disabled: !out.length && 'No links yet',
            items: () =>
              out.map((e) => ({
                label: `${e.label ?? '(no label)'} → ${titleOf(doc.get(e.toNode))}`,
                items: [
                  { label: 'Rename…', run: () => void linkLabel(n, doc.get(e.toNode)!, e.label) },
                  { label: 'Remove', run: () => app.dispatch('page.unlink', { edge: e.id }) },
                ],
              })),
          },
          { label: 'Auto-link this page’s links', run: () => autoLink([n.id]) },
          { label: 'Device', separator: true, items: DEVICES.map((d) => ({ label: d.label, checked: d.vw === f.vw, run: () => app.dispatch('page.device', { id: n.id, vw: d.vw }) })) },
          {
            label: 'Size on canvas',
            items: [
              { label: 'Larger', run: () => app.dispatch('page.scale', { id: n.id, factor: 1.25 }) },
              { label: 'Smaller', run: () => app.dispatch('page.scale', { id: n.id, factor: 0.8 }) },
            ],
          },
          { label: 'Add note', run: () => app.dispatch('page.note', { x: n.x + 16, y: n.y + n.height + 24, on: n.id, text: 'Note' }) },
        ];
        return { title: `Page: ${f.title}`, entries };
      }
      if (sel.length === 2 && sel.every(isPage)) {
        const [a, b] = sel;
        return {
          entries: [
            { label: `Link ${titleOf(a)} → ${titleOf(b)}…`, run: () => void linkLabel(a, b) },
            { label: `Link ${titleOf(b)} → ${titleOf(a)}…`, run: () => void linkLabel(b, a) },
          ],
        };
      }
      if (sel.length === 1 && isNote(sel[0])) {
        const n = sel[0];
        return {
          title: 'Note',
          entries: [
            {
              label: 'Edit note…',
              run: async () => {
                const t = await editNote(n.text ?? '');
                if (t !== null) app.dispatch('page.noteText', { id: n.id, text: t });
              },
            },
            { label: note(n).on ? `On page ${titleOf(doc.get(note(n).on!))} (drag off to detach)` : 'Not on a page (drag it onto one)', disabled: true },
          ],
        };
      }
    });
    const autoLink = (ids?: string[]) => {
      const { changes, missing } = autoLinkChanges(app.doc, ids, () => '');
      app.dispatch('page.autoLink', { ids });
      app.notify(`${changes.length ? `Linked ${changes.length}` : 'Nothing new to link'}${missing.length ? `; no page for: ${missing.join(', ')}` : ''}`);
    };

    // ------------------------------------------------------------ kits
    app.registerKit({ id: 'prototype-flow', label: 'Prototype: example signup flow', create: (app, at) => {
      app.dispatch('page.seed', { x: at.x - 900, y: at.y - 200 });
      app.view.fit(80, app.selected(), 1);
    } });
    app.registerKit({ id: 'prototype-page', label: 'Prototype: blank page', create: (app, at) => void app.dispatch('page.create', { x: at.x - 100, y: at.y - 200 }) });
    app.registerKit({ id: 'prototype-note', label: 'Sticky note', create: (app, at) => void app.dispatch('page.note', { x: at.x - 90, y: at.y - NOTE_H / 2 }) });

    // multiplayer: follow a presenter (presence exists only in a room, set after setup)
    let mounted = false;
    app.store.subscribe(() => {
      if (mounted || !app.presence) return;
      mounted = true;
      mountFollowBanner(app, player);
    });
  },
};
