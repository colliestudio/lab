import './kanban.css';
import type { App, CanvasNode, MenuEntry, Plugin } from '../../core';
import { askText } from '../mats/textDialog';
import { canPick, disconnect, hostOf, localState, pickFolder, resume, resumeFolder, tabId, useDevFolder, useService } from './connect';
import { registerKanbanLogic } from './logic';
import { CARD_GAP, CARD_H, COL_GAP, COL_W, PAD, board, cardsTop, column, columnsOf, isBoard, isRef, isTask, isWeb, ref, task, web } from './model';
import { closeTask, openTask } from './panel';
import { boardHtml, cardHtml, refHtml, webHtml } from './render';

// Kanban: a board node backed by a Backlog.md project (a folder of markdown, or a running Backlog.md
// server). Same data as files and as a board; cards drag out onto the canvas as linked references.

/** Which column and slot a drop at world point `at` means. */
function slotAt(app: App, b: CanvasNode, at: { x: number; y: number }, moving: string[]) {
  const cols = columnsOf(app.doc, b);
  const i = Math.max(0, Math.min(cols.length - 1, Math.floor((at.x - b.x - PAD + COL_GAP / 2) / (COL_W + COL_GAP))));
  const others = column(app.doc, b.id, cols[i]).filter((t) => !moving.includes(t.id) && app.doc.isVisible(t.id));
  const index = others.filter((t) => t.y + CARD_H / 2 < at.y).length;
  return { status: cols[i], index, col: i };
}

/** The tasks a drag stands for (refs stand for their task), if all belong to board `b`. */
function tasksIn(app: App, b: CanvasNode, nodes: CanvasNode[]): string[] | undefined {
  const ids: string[] = [];
  for (const n of nodes) {
    const t = isRef(n) ? app.node(ref(n).task) : n;
    if (!isTask(t) || task(t).board !== b.id) return;
    ids.push(t.id);
  }
  return ids.length ? ids : undefined;
}

let marker: HTMLElement | null = null;
function showMarker(app: App, b: CanvasNode, slot: { col: number; index: number } | undefined) {
  const box = app.view.boxOf(b.id);
  if (!slot || !box) return marker?.remove();
  marker ??= Object.assign(document.createElement('div'), { className: 'kb-marker' });
  const top = cardsTop(b) - b.y + slot.index * (CARD_H + CARD_GAP) - CARD_GAP / 2 - 2;
  marker.style.left = `${PAD + slot.col * (COL_W + COL_GAP) + 8}px`;
  marker.style.top = `${top}px`;
  marker.style.width = `${COL_W - 16}px`;
  if (marker.parentElement !== box) box.append(marker);
}

async function newTaskIn(app: App, b: CanvasNode, status?: string) {
  const title = await askText(`New task${status ? ` in ${status}` : ''}`, '', 'Add', 200);
  if (title) app.dispatch('kanban.newTask', { board: b.id, status, title });
}

async function rename(app: App, n: CanvasNode) {
  const t = isRef(n) ? app.node(ref(n).task) : n;
  if (!isTask(t)) return;
  const title = await askText('Rename task', task(t).title, 'Save', 200);
  if (title) app.dispatch('kanban.edit', { id: t.id, patch: { title } });
}

function taskMenu(app: App, n: CanvasNode): MenuEntry[] {
  const t = isRef(n) ? app.node(ref(n).task) : n;
  if (!isTask(t)) return [{ label: 'Task is gone', disabled: true }];
  const f = task(t);
  const b = app.node(f.board);
  const labels = [...new Set([...(b ? board(b).labels : []), ...(f.labels ?? [])])];
  return [
    { label: 'Open as document', hint: '⏎', run: () => openTask(app, t.id) },
    { label: 'Rename…', hint: 'F2', run: () => rename(app, n) },
    {
      label: 'Status',
      items: (b ? columnsOf(app.doc, b) : [f.status]).map((s) => ({ label: s, checked: s === f.status, run: () => app.dispatch('kanban.move', { board: f.board, ids: [t.id], status: s, index: 1e9 }) })),
    },
    {
      label: 'Labels',
      items: () => [
        ...labels.map((l) => ({
          label: l,
          checked: f.labels?.includes(l),
          run: () => app.dispatch('kanban.edit', { id: t.id, patch: { labels: f.labels?.includes(l) ? f.labels.filter((x) => x !== l) : [...(f.labels ?? []), l] } }),
        })),
        {
          label: 'New label…',
          separator: labels.length > 0,
          run: async () => {
            const l = await askText('New label', '', 'Add', 40);
            if (l) app.dispatch('kanban.edit', { id: t.id, patch: { labels: [...(f.labels ?? []), l] } });
          },
        },
      ],
    },
    ...(isTask(n) ? [{ label: 'Put a linked copy on the canvas', separator: true, run: () => app.dispatch('kanban.ref', { task: t.id, x: (b?.x ?? 0) + (b?.width ?? 0) + 40, y: t.y }) }] : []),
    ...(isRef(n) ? [{ label: 'Show on its board', separator: true, run: () => b && (app.store.select([t.id]), app.view.zoomToSelection()) }] : []),
  ];
}

function boardMenu(app: App, b: CanvasNode): MenuEntry[] {
  const f = board(b);
  const mine = f.ownerTab === tabId && !!hostOf(b.id);
  return [
    { label: 'New task…', run: () => newTaskIn(app, b) },
    {
      label: mine ? 'Change source' : f.source ? 'Take over as host' : 'Connect',
      separator: true,
      items: [
        { label: 'Folder… (File System Access)', disabled: canPick() ? false : 'Chromium browsers only', run: () => pickFolder(app, b.id) },
        { label: `Dev server folder${localState(b.id).devFolder ? ` (${localState(b.id).devFolder})` : ''}`, disabled: localState(b.id).devFolder ? false : 'Start vite with KANBAN_ROOT=…', run: () => useDevFolder(app, b.id) },
        { label: 'Backlog.md server (/backlog-api)', run: () => useService(app, b.id) },
      ],
    },
    ...(mine ? [{ label: 'Sync now', run: () => hostOf(b.id)?.cycle().then(() => app.view.render()) }, { label: 'Stop hosting in this tab', run: () => disconnect(app, b.id) }] : []),
  ];
}

const target = (app: App) => {
  const h = app.view.hovered && app.node(app.view.hovered);
  const n = h && (isTask(h) || isRef(h)) ? h : app.selected().filter((x) => isTask(x) || isRef(x)).at(-1);
  return n || undefined;
};

export const kanbanPlugin: Plugin = {
  id: 'kanban',
  setup(app) {
    registerKanbanLogic(app.store);
    app.registerKit({ id: 'kanban.board', label: 'Kanban board (Backlog.md)', create: (a, at) => a.dispatch('kanban.create', at) });
    app.registerKit({
      id: 'kanban.web',
      label: 'Backlog.md web UI (iframe)',
      create: async (a, at) => {
        const url = await askText('Backlog.md web UI address', 'http://localhost:6421', 'Add', 200);
        if (url) a.dispatch('kanban.web', { ...at, url });
      },
    });

    app.registerType({
      id: 'kanban.board',
      match: isBoard,
      render(node, el, ctx) {
        el.innerHTML = boardHtml(node, ctx.doc, app.me().id, tabId, localState(node.id));
      },
      renderKey(node, ctx) {
        const counts = columnsOf(ctx.doc, node).map((s) => column(ctx.doc, node.id, s).length);
        return JSON.stringify([node[`x-kanban`], node.width, node.height, counts, localState(node.id), app.me().id]);
      },
      // the board surface doesn't grab: a press on it box-selects (drag the header to move it)
      grabbable: (_n, down) => !!(down.target as Element | null)?.closest?.('.kb-head'),
      boxSelectable: () => false,
      onAction(node, action, a) {
        const [name, arg] = action.split(':');
        const status = arg !== undefined ? columnsOf(a.doc, node)[Number(arg)] : undefined;
        if (name === 'pick') void pickFolder(a, node.id);
        else if (name === 'dev') void useDevFolder(a, node.id);
        else if (name === 'service') useService(a, node.id);
        else if (name === 'resume') void resumeFolder(a, node.id);
        else if (name === 'new' || name === 'add') void newTaskIn(a, node, status);
        else if ((name === 'more' || name === 'less') && status) a.dispatch('kanban.expand', { id: node.id, status, on: name === 'more' });
      },
      canDrop(t, dropped, a) {
        return tasksIn(a, t, dropped) ? 'Move' : false;
      },
      dragOver(t, dropped, a, at) {
        const ids = at && tasksIn(a, t, dropped);
        showMarker(a, t, ids && at ? slotAt(a, t, at, ids) : undefined);
      },
      onDrop(t, ids, a, at) {
        const nodes = ids.map((id) => a.node(id)).filter((n): n is CanvasNode => !!n);
        const tasks = tasksIn(a, t, nodes);
        if (!tasks) return;
        const { status, index } = slotAt(a, t, at, tasks);
        a.dispatch('kanban.move', { board: t.id, ids, status, index });
      },
    });

    app.registerType({
      id: 'kanban.task',
      match: isTask,
      render(node, el) {
        el.innerHTML = cardHtml(task(node));
      },
      // cards move only on this screen until dropped: on their board = a move, elsewhere = a linked copy
      dragsLocally: (node, a) => !!a.doc.parentOf(node.id),
      dropProxy: (node) => task(node).board,
      onLocalDrop(node, at, a) {
        a.dispatch('kanban.ref', { task: node.id, x: at.x, y: at.y });
      },
      onDoubleClick: (node, a) => openTask(a, node.id),
      boxSelectable: () => false,
    });

    app.registerType({
      id: 'kanban.ref',
      match: isRef,
      render(node, el, ctx) {
        const t = ctx.doc.get(ref(node).task);
        const b = isTask(t) ? ctx.doc.get(task(t).board) : undefined;
        el.innerHTML = refHtml(isTask(t) ? task(t) : undefined, isBoard(b) ? board(b).name : undefined);
      },
      renderKey(node, ctx) {
        const t = ctx.doc.get(ref(node).task);
        const b = isTask(t) ? ctx.doc.get(task(t).board) : undefined;
        return JSON.stringify([t?.['x-kanban'], isBoard(b) ? board(b).name : '']);
      },
      onDoubleClick: (node, a) => openTask(a, node.id),
    });

    // comparison: the Backlog.md web UI in an iframe; double-click to use it, Done / Esc / click outside to stop
    const live = new Set<string>();
    const setLive = (id: string, on: boolean) => {
      if (on) live.add(id);
      else live.delete(id);
      app.view.boxOf(id)?.classList.toggle('kb-live', on);
    };
    app.registerType({
      id: 'kanban.web',
      match: isWeb,
      render(node, el) {
        el.innerHTML = webHtml(web(node).url);
        el.classList.toggle('kb-live', live.has(node.id));
      },
      onDoubleClick: (node) => setLive(node.id, true),
      onAction: (node, action) => action === 'done' && setLive(node.id, false),
    });
    if (typeof window !== 'undefined') {
      app.view.root.addEventListener('pointerdown', () => [...live].forEach((id) => setLive(id, false)), true);
      window.addEventListener('keydown', (e) => e.key === 'Escape' && [...live].forEach((id) => setLive(id, false)));
    }

    app.registerMenu((a, sel) => {
      if (sel.length !== 1) return;
      const n = sel[0];
      if (isBoard(n)) return { title: `Board: ${board(n).name}`, entries: boardMenu(a, n) };
      if (isTask(n) || isRef(n)) {
        const t = isRef(n) ? a.node(ref(n).task) : n;
        return { title: isTask(t) ? `${task(t).taskId ?? 'New task'}${isRef(n) ? ' (linked)' : ''}` : 'Linked task', entries: taskMenu(a, n) };
      }
    });
    app.registerKey({ key: 'enter', label: 'Open the task', when: (a) => !!target(a), run: (a) => openTask(a, target(a)!.id) });
    app.registerKey({ key: 'f2', label: 'Rename the task', when: (a) => !!target(a), run: (a) => void rename(a, target(a)!) });
    app.registerKey({ key: 'escape', label: 'Close the task', when: () => !!document.querySelector('.kb-panel'), run: () => closeTask() });

    if (typeof window === 'undefined') return;
    // resume hosting after a reload, and follow boards that arrive or leave (sync, undo, file open)
    let boards = '';
    app.store.subscribe(() => {
      const key = app.doc.nodes
        .filter(isBoard)
        .map((b) => `${b.id}:${board(b).ownerTab ?? ''}`)
        .join(',');
      if (key === boards) return;
      boards = key;
      void resume(app);
    });
    void resume(app);
  },
};
