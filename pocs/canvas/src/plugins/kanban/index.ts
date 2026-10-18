import './kanban.css';
import type { App, CanvasNode, MenuEntry, Plugin } from '../../core';
import { useLogic } from '../logic';
import { PRIORITIES } from './commands';
import { logic } from './logic';
import { CARD_GAP, COL_GAP, PAD, board, cardsTop, clock, colWidth, columnsOf, isBoard, isTask, shownIn, task, tasksOf, type Seat } from './model';
import { closeTask, openTask, panelOpen, type PanelEnv } from './panel';
import { boardHtml, cardHtml, rowHtml, seatKey, stateChip } from './render';

export { logic as kanbanLogic } from './logic';

// Kanban: a board node that is a live view of a Backlog.md folder the canvas serve hosts. This is the
// browser side: it draws the board from the doc and turns drags, quick adds and panel edits into
// kanban.* commands. Files are never touched here; the serve syncs them (src/plugins/kanban/sync.ts).

/** A quick-add field open in a column of a board (kept here so a redraw of the board keeps the text); one per app. */
interface Quick {
  board: string;
  col: number;
  text: string;
  /** When it opened (ms): the press that opened it ends by focusing the table again, which must not close it. */
  at: number;
}
const quicks = new WeakMap<App, Quick | null>();
const pressGuarded = new WeakSet<HTMLElement>();
/** The press that is going on started on a control of the board (its pointerdown ran `onAction`); its mousedown must not move the focus. */
let pressedAction = false;
/** Per dragged card: the file's status and order hashes when the drag started. */
const dragSeen = new Map<string, [string | undefined, string | undefined]>();
const quickOf = (app: App) => quicks.get(app) ?? null;

const served = (app: App) => app.hosted === 'served';

function seatsOf(app: App): Seat[] {
  const peers = (app.presence?.peers() ?? []).map((p) => ({ id: p.id, name: p.name, color: p.color }));
  const me = app.me();
  return [...peers, { id: me.id, name: me.name, color: me.color }];
}

/** The board is live: served page, and the serve has read its folder. */
const liveBoard = (app: App, b: CanvasNode) => stateChip(b, { served: served(app) }).live;

/** Which column and slot a drop at world point `at` means. */
function slotAt(app: App, b: CanvasNode, at: { x: number; y: number }, moving: string[]) {
  const cols = columnsOf(app.doc, b);
  let i = cols.length - 1;
  let x = b.x + PAD;
  for (let k = 0; k < cols.length; k++) {
    const w = colWidth(b, cols[k]);
    if (at.x < x + w + COL_GAP / 2) {
      i = k;
      break;
    }
    x += w + COL_GAP;
  }
  const others = shownIn(app.doc, b, cols[i]).shown.filter((t) => !moving.includes(t.id));
  const index = others.filter((t) => t.y + t.height / 2 < at.y).length;
  return { status: cols[i], index, col: i, others };
}

/** The tasks a drag stands for, if all belong to board `b`. */
function tasksIn(b: CanvasNode, nodes: CanvasNode[]): string[] | undefined {
  const ids: string[] = [];
  for (const n of nodes) {
    if (!isTask(n) || task(n).board !== b.id) return;
    ids.push(n.id);
  }
  return ids.length ? ids : undefined;
}

let marker: HTMLElement | null = null;
function showMarker(app: App, b: CanvasNode, slot: { col: number; index: number; others: CanvasNode[] } | undefined) {
  const box = app.view.boxOf(b.id);
  if (!slot || !box) return marker?.remove();
  marker ??= Object.assign(document.createElement('div'), { className: 'kb-marker' });
  const cols = columnsOf(app.doc, b);
  const prev = slot.others[slot.index - 1];
  const next = slot.others[slot.index];
  const top = prev ? prev.y + prev.height - b.y + CARD_GAP / 2 : next ? next.y - b.y - CARD_GAP / 2 : cardsTop(b) - b.y;
  let left = PAD;
  for (let k = 0; k < slot.col; k++) left += colWidth(b, cols[k]) + COL_GAP;
  marker.style.left = `${left + 8}px`;
  marker.style.top = `${top - 2}px`;
  marker.style.width = `${colWidth(b, cols[slot.col]) - 16}px`;
  if (marker.parentElement !== box) box.append(marker);
}

function boardMenu(app: App, b: CanvasNode): MenuEntry[] {
  const f = board(b);
  const labels = f.labels ?? [];
  const cur = f.filter?.labels ?? [];
  const parents = [...new Set(tasksOf(app.doc, b.id).flatMap((t) => (task(t).parent ? [task(t).parent!] : [])))].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  const live = liveBoard(app, b);
  return [
    { label: 'New task…', disabled: live ? false : 'Not live here', run: () => openQuick(app, b, f.columns.indexOf(f.defaultColumn)) },
    {
      label: 'Filter by label',
      separator: true,
      disabled: labels.length ? false : 'No labels in the config',
      items: labels.map((l) => ({ label: l, checked: cur.includes(l), run: () => app.dispatch('kanban.filter', { board: b.id, labels: cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l] }) })),
    },
    {
      label: 'Subtasks of…',
      disabled: parents.length ? false : 'No task has subtasks',
      items: parents.map((p) => ({ label: p, checked: f.filter?.parent === p, run: () => app.dispatch('kanban.filter', { board: b.id, parent: f.filter?.parent === p ? null : p }) })),
    },
    { label: 'Clear filters', disabled: f.filter ? false : 'No filter', run: () => app.dispatch('kanban.filter', { board: b.id, labels: null, parent: null }) },
    ...(f.doneColumn ? [{ label: f.expanded?.includes(f.doneColumn) ? 'Done: recent only' : 'Done: show all', separator: true, run: () => app.dispatch('kanban.expand', { id: b.id, status: f.doneColumn!, on: !f.expanded?.includes(f.doneColumn!) }) }] : []),
  ];
}

function taskMenu(app: App, n: CanvasNode, env: PanelEnv): MenuEntry[] {
  if (!isTask(n)) return [];
  const f = task(n);
  const b = app.node(f.board);
  const live = !!b && liveBoard(app, b);
  const off = live ? false : 'Not live here';
  const labels = [...new Set([...(b ? board(b).labels : []), ...(f.labels ?? [])])];
  return [
    { label: 'Open', hint: '⏎', run: () => openTask(app, n.id, env) },
    {
      label: 'Status',
      disabled: off,
      items: (b ? columnsOf(app.doc, b) : [f.status]).map((s) => ({ label: s, checked: s === f.status, run: () => app.dispatch('kanban.move', { board: f.board, ids: [n.id], status: s, index: 1e9 }) })),
    },
    { label: 'Priority', disabled: off, items: ['', ...PRIORITIES].map((p) => ({ label: p || 'None', checked: (f.priority ?? '') === p, run: () => app.dispatch('kanban.edit', { id: n.id, patch: { priority: p || null } }) })) },
    {
      label: 'Labels',
      disabled: off || (labels.length ? false : 'No labels'),
      items: labels.map((l) => ({ label: l, checked: f.labels?.includes(l), run: () => app.dispatch('kanban.edit', { id: n.id, patch: { labels: f.labels?.includes(l) ? f.labels.filter((x) => x !== l) : [...(f.labels ?? []), l] } }) })),
    },
  ];
}

function openQuick(app: App, b: CanvasNode, col: number) {
  if (!liveBoard(app, b) || col < 0) return;
  quicks.set(app, { board: b.id, col, text: '', at: Date.now() });
  app.view.render();
}

function closeQuick(app: App) {
  if (!quickOf(app)) return;
  quicks.set(app, null);
  app.view.render();
}

/** Wire the quick-add field a board redraw just made. */
function wireQuick(app: App, b: CanvasNode, el: HTMLElement) {
  const input = el.querySelector<HTMLTextAreaElement>('[data-quick]');
  const state = quickOf(app);
  if (!input || !state || state.board !== b.id) return;
  input.value = state.text;
  const rows = () => (input.rows = Math.min(4, Math.max(1, input.value.split('\n').length)));
  rows();
  const focus = () => {
    if (quickOf(app) !== state || !input.isConnected || document.activeElement === input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  };
  // the press that opened the field still has its default focus change to make: focus after it
  queueMicrotask(focus);
  setTimeout(focus, 40);
  const submit = (open: boolean) => {
    const titles = input.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const status = columnsOf(app.doc, b)[state.col];
    quicks.set(app, null);
    if (titles.length) {
      const r = app.dispatch('kanban.create', { board: b.id, titles, status });
      if (open && r.select?.[0]) openTask(app, r.select[0], envOf(app));
    }
    app.view.render();
  };
  input.addEventListener('input', () => {
    state.text = input.value;
    rows();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeQuick(app);
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submit(e.shiftKey);
    }
  });
  input.addEventListener('blur', () => {
    // the press that opened it hands the focus back to the table: take it again
    if (Date.now() - state.at < 500 && quickOf(app) === state && input.isConnected) return void setTimeout(focus, 0);
    // a redraw replaces the field (blur first): only a real leave closes it
    setTimeout(() => {
      if (quickOf(app) === state && !input.isConnected) return;
      if (quickOf(app) === state && document.activeElement !== input) closeQuick(app);
    }, 0);
  });
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
}

const envOf = (app: App): PanelEnv => ({
  live: (boardId) => {
    const b = app.node(boardId);
    return !!b && isBoard(b) && liveBoard(app, b);
  },
  seats: () => seatsOf(app),
  me: () => app.me().name,
});

async function addBoard(app: App, at: { x: number; y: number }) {
  if (!served(app)) return app.notify('A kanban board needs a canvas serve with a kanban folder (the board is a view of that folder). Open this board through a serve.');
  let names: string[] = [];
  try {
    const info = await (await fetch('/api/info')).json();
    names = Array.isArray(info.kanban) ? info.kanban.filter((n: unknown): n is string => typeof n === 'string') : [];
  } catch {
    return app.notify('Could not ask the serve which kanban folders it has');
  }
  if (!names.length) return app.notify('This serve has no kanban folder: start it with --kanban name=path (a Backlog.md project)');
  if (names.length === 1) return void app.dispatch('kanban.addBoard', { ...at, source: names[0] });
  const r = app.view.root.getBoundingClientRect();
  app.view.openMenu(
    names.map((n) => ({ label: n, run: () => app.dispatch('kanban.addBoard', { ...at, source: n }) })),
    { x: r.width / 2, y: r.height / 2 },
    'Which kanban folder?',
  );
}

export const kanbanPlugin: Plugin = {
  id: 'kanban',
  setup(app) {
    useLogic(app.store, logic);
    const env = envOf(app);

    app.registerKit({ id: 'kanban.board', label: 'Kanban board (Backlog.md)', create: (a, at) => void addBoard(a, at) });

    app.registerType({
      id: 'kanban.board',
      match: isBoard,
      render(node, el, ctx) {
        // a press on a control must not move the focus (the quick-add field takes it): no default focus change
        if (!pressGuarded.has(el)) {
          pressGuarded.add(el);
          el.addEventListener('mousedown', (e) => {
            if (!pressedAction) return;
            pressedAction = false;
            e.preventDefault();
          });
        }
        el.innerHTML = boardHtml(node, ctx.doc, { served: served(app), quick: quickOf(app)?.board === node.id ? { col: quickOf(app)!.col, text: quickOf(app)!.text } : undefined, seats: [] }, clock.now());
        wireQuick(app, node, el);
      },
      renderKey(node, ctx) {
        const { nextId: _n, ...rest } = board(node);
        const shown = columnsOf(ctx.doc, node).map((s) => {
          const x = shownIn(ctx.doc, node, s);
          return [x.filtered.length, x.hidden];
        });
        return JSON.stringify([rest, node.width, node.height, shown, served(app), quickOf(app)?.board === node.id ? [quickOf(app)!.col] : null]);
      },
      // the board surface doesn't grab: a press on it box-selects (drag the header to move it)
      grabbable: (_n, down) => !!(down.target as Element | null)?.closest?.('.kb-head') && !(down.target as Element).closest('[data-action]'),
      boxSelectable: () => false,
      onAction(node, action, a) {
        pressedAction = true;
        setTimeout(() => (pressedAction = false), 150);
        const [name, arg] = action.split(':');
        const status = arg !== undefined ? columnsOf(a.doc, node)[Number(arg)] : undefined;
        if (name === 'add') openQuick(a, node, Number(arg));
        else if ((name === 'more' || name === 'less') && status) a.dispatch('kanban.expand', { id: node.id, status, on: name === 'more' });
        else if (name === 'menu' || name === 'filter') {
          const btn = a.view.boxOf(node.id)?.querySelector(name === 'menu' ? '.kb-menu' : '.kb-chip');
          a.view.openMenu(boardMenu(a, node), btn ?? { x: 200, y: 120 }, `Board: ${board(node).name}`);
        }
      },
      canDrop(t, dropped) {
        return liveBoard(app, t) && tasksIn(t, dropped) ? 'Move' : false;
      },
      dragOver(t, dropped, a, at) {
        const ids = at && tasksIn(t, dropped);
        showMarker(a, t, ids && at ? slotAt(a, t, at, ids) : undefined);
      },
      onDrop(t, ids, a, at) {
        marker?.remove();
        const nodes = ids.map((id) => a.node(id)).filter((n): n is CanvasNode => !!n);
        const moving = tasksIn(t, nodes);
        if (!moving) return;
        const { status, index } = slotAt(a, t, at, moving);
        // a status or order the file changed since the drag started (on any dragged card): the file wins, the whole drop is dropped
        const what = new Set<string>();
        const changed = moving.filter((id) => {
          const seen = dragSeen.get(id);
          const b = task(a.node(id)!).base;
          if (!seen) return false;
          if (seen[0] !== b?.status) what.add('status');
          if (seen[1] !== b?.ordinal) what.add('order');
          return seen[0] !== b?.status || seen[1] !== b?.ordinal;
        });
        if (changed.length) {
          a.notify(`${changed.map((id) => task(a.node(id)!).taskId).join(', ')} ${[...what].join(' and ')}: changed in the file meanwhile; kept the file's (nothing moved)`);
          return;
        }
        const f = board(t);
        if (status === f.doneColumn) {
          const open = moving.filter((id) => (task(a.node(id)!).ac ?? []).some((c) => !c.done));
          if (open.length) a.notify(`${open.map((id) => task(a.node(id)!).taskId).join(', ')} still ${open.length === 1 ? 'has' : 'have'} open acceptance criteria (moved to ${status} anyway)`);
        }
        a.dispatch('kanban.move', { board: t.id, ids: moving, status, index });
      },
    });

    app.registerType({
      id: 'kanban.task',
      match: isTask,
      render(node, el, ctx) {
        const t = task(node);
        const b = ctx.doc.get(t.board);
        el.innerHTML = b && isBoard(b) && t.status === board(b).doneColumn ? rowHtml(t) : cardHtml(t, seatsOf(app));
      },
      renderKey(node, ctx) {
        const t = task(node);
        const b = ctx.doc.get(t.board);
        const done = !!b && isBoard(b) && t.status === board(b).doneColumn;
        return JSON.stringify([t.taskId, t.title, t.priority, t.assignee, t.labels, t.pending, t.note, t.ac?.length, t.ac?.filter((a) => a.done).length, done, seatKey(t, seatsOf(app))]);
      },
      // cards move only on this screen until dropped: on their board = a move; anywhere else nothing happens
      dragsLocally: (node, a) => !!a.doc.parentOf(node.id) && !!a.node(task(node).board) && liveBoard(app, a.node(task(node).board)!),
      movable: (node, a) => !a.doc.parentOf(node.id) || (!!a.node(task(node).board) && liveBoard(app, a.node(task(node).board)!)),
      dropProxy: (node) => task(node).board,
      onLocalDrop: () => {},
      onLocalDrag(node, phase, a) {
        // every card the drag takes along (the grabbed one and the selected ones)
        for (const n of [node, ...a.selected().filter(isTask)]) {
          if (phase === 'start') dragSeen.set(n.id, [task(n).base?.status, task(n).base?.ordinal]);
          else setTimeout(() => dragSeen.delete(n.id), 0);
        }
      },
      onClick(node, down, a) {
        if (down.shiftKey || down.metaKey || down.ctrlKey) return;
        openTask(a, node.id, env);
        return true;
      },
      onDoubleClick: (node, a) => openTask(a, node.id, env),
      boxSelectable: () => false,
    });

    app.registerMenu((a, sel) => {
      if (sel.length !== 1) return;
      const n = sel[0];
      if (isBoard(n)) return { title: `Board: ${board(n).name}`, entries: boardMenu(a, n) };
      if (isTask(n)) return { title: task(n).taskId ?? 'New task', entries: taskMenu(a, n, env) };
    });
    const target = () => {
      const h = app.view.hovered && app.node(app.view.hovered);
      const n = h && isTask(h) ? h : app.selected().filter(isTask).at(-1);
      return n || undefined;
    };
    app.registerKey({ key: 'enter', label: 'Open the task', when: () => !!target(), run: () => openTask(app, target()!.id, env) });
    app.registerKey({ key: 'escape', label: 'Close the task', when: () => panelOpen() || !!quickOf(app), run: () => (panelOpen() ? closeTask() : closeQuick(app)) });
    app.onTableReplaced(() => {
      closeTask();
      quicks.set(app, null);
    });

    // the dot on a card follows who is at the table
    let attached: unknown;
    let seatSig = '';
    const sig = () => seatsOf(app).map((s) => `${s.name}|${s.color}`).sort().join(',');
    app.store.subscribe(() => {
      const p = app.presence;
      if (!p || p === attached) return;
      attached = p;
      p.onChange(() => {
        const s = sig();
        if (s === seatSig) return;
        seatSig = s;
        app.view.render();
      });
    });

    // a node the serve can not sync says why once (an unknown folder name, an unreadable folder)
    const toldErrors = new Set<string>();
    app.store.subscribe(() => {
      for (const n of app.doc.nodes) {
        const e = isBoard(n) ? board(n).state?.error : undefined;
        if (e && !toldErrors.has(n.id + e)) {
          toldErrors.add(n.id + e);
          if (served(app)) app.notify(`Kanban ${board(n).name}: ${e}`);
        }
      }
    });

    // what the file changed behind a viewer's edit, and what could not be written, reaches everyone as a notice
    const told = new Set<string>();
    app.store.log.observe((ev) => {
      for (const d of ev.changes.delta) {
        for (const e of (d.insert as { id: string; type: string; text: string; time: number }[] | undefined) ?? []) {
          if (!/^kanban\.(conflict|error)$/.test(e.type) || told.has(e.id) || Date.now() - e.time > 15_000) continue;
          told.add(e.id);
          app.notify(e.text);
        }
      }
    });
  },
};
