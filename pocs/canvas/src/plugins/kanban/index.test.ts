// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, type CanvasNode } from '../../core';
import { registerBoardLogic } from '../board/logic';
import { kanbanPlugin } from './index';
import { clock, task } from './model';
import { closeTask, panelOpen } from './panel';
import { NOW, addBoard, addTask, resetCounter, stampDaysAgo, taskField } from './testkit';

// The plugin in a DOM (happy-dom: no layout, so geometry comes from the layout rule, not from pixels).

beforeEach(() => {
  resetCounter();
  clock.now = () => NOW;
});
afterEach(() => {
  closeTask();
  document.body.replaceChildren();
});

function setup(hosted: App['hosted'] = 'served', boardOver: Parameters<typeof addBoard>[1] = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const app = new App(root);
  app.player = { id: 'me', name: 'Alex', color: '#00f' };
  app.viewer = 'me';
  app.hosted = hosted;
  app.use(kanbanPlugin);
  addBoard(app.store, boardOver);
  addTask(app.store, 'b1', { title: 'One', taskId: 'TASK-1', ordinal: 1000, ac: [{ text: 'open', done: false }] }, 'one');
  addTask(app.store, 'b1', { title: 'Two', taskId: 'TASK-2', ordinal: 2000, status: 'In Progress' }, 'two');
  addTask(app.store, 'b1', { title: 'Old', taskId: 'TASK-3', status: 'Done', updated: stampDaysAgo(40), ordinal: 3000 }, 'old');
  addTask(app.store, 'b1', { title: 'Fresh', taskId: 'TASK-4', status: 'Done', updated: stampDaysAgo(1), ordinal: 4000 }, 'fresh');
  app.store.undoManager.clear();
  app.view.render();
  return app;
}
const box = (app: App, id: string) => app.view.boxOf(id)!;
const kx = (n: CanvasNode | undefined) => n?.['x-kanban'] as { kind?: string; filter?: unknown } | undefined;
const type = (app: App, id: string) => app.typeOf(app.node(id)!)!;

describe('kanban node in the DOM', () => {
  it('draws the board and a card per shown task; Done shows its recent task as a row and the older ones behind +N (C8, C10)', () => {
    const app = setup();
    expect(box(app, 'b1').querySelector('.kb-live')).toBeTruthy();
    expect(box(app, 'b1').textContent).toContain('+1 older');
    expect(box(app, 'one').querySelector('.kb-card')).toBeTruthy();
    expect(box(app, 'fresh').querySelector('.kb-row')).toBeTruthy();
    expect(app.view.boxOf('old')).toBeUndefined(); // not placed, so not drawn
    type(app, 'b1').onAction!(app.node('b1')!, 'more:2', app);
    app.view.render();
    expect(box(app, 'old').querySelector('.kb-row')).toBeTruthy();
    type(app, 'b1').onAction!(app.node('b1')!, 'less:2', app);
    app.view.render();
    expect(app.view.boxOf('old')).toBeUndefined();
  });

  it('a page that is not a serve board: not live, read-only, no plus buttons, nothing to drop on (C79)', () => {
    const app = setup(null);
    expect(box(app, 'b1').textContent).toContain('not live here');
    expect(box(app, 'b1').querySelector('[data-action^="add"]')).toBeNull();
    expect(type(app, 'b1').canDrop!(app.node('b1')!, [app.node('one')!], app, 1)).toBe(false);
    type(app, 'b1').onAction!(app.node('b1')!, 'add:0', app);
    expect(box(app, 'b1').querySelector('[data-quick]')).toBeNull();
    expect(type(app, 'one').dragsLocally!(app.node('one')!, app)).toBe(false);
  });

  it('a board whose folder the serve lacks shows the serve\'s message instead of live', () => {
    const app = setup('served', { state: { error: 'this serve has no kanban folder named "x" (start it with --kanban name=path)' } });
    expect(box(app, 'b1').querySelector('.kb-bad')).toBeTruthy();
    expect(box(app, 'b1').textContent).toContain('no kanban folder named');
  });
});

describe('moving cards (C15, C28)', () => {
  it('a drop on a column slot dispatches kanban.move with the slot; a card dropped anywhere else does nothing', () => {
    const app = setup();
    const b = app.node('b1')!;
    const t = type(app, 'b1');
    expect(t.canDrop!(b, [app.node('one')!], app, 1)).toBe('Move');
    expect(t.canDrop!(b, [app.node('one')!, b], app, 1)).toBe(false);
    // into In Progress, above "Two"
    const two = app.node('two')!;
    t.onDrop!(b, ['one'], app, { x: two.x + 20, y: two.y + 2 });
    expect(taskField(app.store, 'one').status).toBe('In Progress');
    expect(app.store.doc.get('one')).toBeDefined();
    expect(type(app, 'one').dragsLocally!(app.node('one')!, app)).toBe(true);
    expect(type(app, 'one').dropProxy!(app.node('one')!, app)).toBe('b1');
    // dropped on empty table: the local drag ends, nothing changes
    const before = JSON.stringify(app.store.doc.nodes.map((n) => n['x-kanban']));
    type(app, 'one').onLocalDrop!(app.node('one')!, { x: 5000, y: 5000 }, app, ['one']);
    expect(JSON.stringify(app.store.doc.nodes.map((n) => n['x-kanban']))).toBe(before);
  });

  it('dropping a card with open acceptance criteria on Done warns and still moves it; with none, no warning', () => {
    const app = setup();
    const told: string[] = [];
    app.onNotify((m) => told.push(m));
    const b = app.node('b1')!;
    const done = app.node('fresh')!;
    type(app, 'b1').onDrop!(b, ['one'], app, { x: done.x + 10, y: done.y + done.height + 30 });
    expect(taskField(app.store, 'one').status).toBe('Done');
    expect(told).toEqual(['TASK-1 still has open acceptance criteria (moved to Done anyway)']);
    told.length = 0;
    type(app, 'b1').onDrop!(b, ['two'], app, { x: done.x + 10, y: done.y + done.height + 30 });
    expect(told).toEqual([]);
    // and undo puts the card back
    app.store.undo();
    expect(taskField(app.store, 'two').status).toBe('In Progress');
  });
});

describe('a drag the file overtook (C41)', () => {
  it('if the file changed the status after the drag started, the drop does nothing and says so', () => {
    const app = setup();
    app.store.apply([{ op: 'set', id: 'one', key: 'x-kanban.base', value: { status: 'a', ordinal: 'o' } }]);
    const told: string[] = [];
    app.onNotify((m) => told.push(m));
    type(app, 'one').onLocalDrag!(app.node('one')!, 'start', app);
    app.store.apply([{ op: 'set', id: 'one', key: 'x-kanban.base', value: { status: 'b', ordinal: 'o' } }]);
    const two = app.node('two')!;
    type(app, 'b1').onDrop!(app.node('b1')!, ['one'], app, { x: two.x + 20, y: two.y + 2 });
    expect(taskField(app.store, 'one').status).toBe('To Do');
    expect(told).toEqual(["TASK-1 status: changed in the file meanwhile; kept the file's (nothing moved)"]);
    // order only, on a second dragged card: the whole drop is dropped and the field is named
    told.length = 0;
    app.store.apply([{ op: 'set', id: 'two', key: 'x-kanban.base', value: { status: 'a', ordinal: 'o1' } }, { op: 'set', id: 'one', key: 'x-kanban.base', value: { status: 'b', ordinal: 'o' } }]);
    app.store.select(['one', 'two']);
    type(app, 'one').onLocalDrag!(app.node('one')!, 'start', app);
    app.store.apply([{ op: 'set', id: 'two', key: 'x-kanban.base', value: { status: 'a', ordinal: 'o2' } }]);
    type(app, 'b1').onDrop!(app.node('b1')!, ['one', 'two'], app, { x: two.x + 20, y: two.y + 2 });
    expect(told).toEqual(["TASK-2 order: changed in the file meanwhile; kept the file's (nothing moved)"]);
    expect(taskField(app.store, 'one').status).toBe('To Do');
  });
});

describe('notices and node removal', () => {
  it('a node the serve can not sync tells the viewer why, once', () => {
    const app = setup();
    const told: string[] = [];
    app.onNotify((m) => told.push(m));
    app.dispatch('kanban.addBoard', { x: 3000, y: 0, source: 'nowhere' });
    const id = app.doc.nodes.filter((n) => kx(n)?.kind === 'board').find((n) => n.id !== 'b1')!.id;
    app.store.apply([{ op: 'set', id, key: 'x-kanban.state', value: { error: 'this serve has no kanban folder named "nowhere"' } }]);
    app.store.apply([{ op: 'set', id, key: 'x-kanban.labels', value: ['x'] }]);
    expect(told).toEqual(['Kanban nowhere: this serve has no kanban folder named "nowhere"']);
  });

  it('board.remove of a kanban node takes its cards; a card alone stays', () => {
    const app = setup();
    registerBoardLogic(app.store);
    app.dispatch('board.remove', { ids: ['one'] });
    expect(app.node('one')).toBeDefined();
    app.dispatch('board.remove', { ids: ['b1'] });
    expect(app.doc.nodes.filter((n) => kx(n)?.kind === 'task')).toEqual([]);
  });
});

describe('quick add (C26, C27)', () => {
  const open = (app: App, col = 0) => {
    type(app, 'b1').onAction!(app.node('b1')!, `add:${col}`, app);
    return box(app, 'b1').querySelector<HTMLTextAreaElement>('[data-quick]')!;
  };
  const enter = (el: HTMLElement, shift = false) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift, bubbles: true, cancelable: true }));

  it('the plus opens a field in that column; Enter makes the task there and closes it', () => {
    const app = setup();
    const input = open(app, 1);
    expect(input).toBeTruthy();
    input.value = 'Brand new';
    input.dispatchEvent(new Event('input'));
    enter(input);
    const made = app.doc.nodes.filter((n) => task(n)?.title === 'Brand new' && n['x-kanban']);
    expect(made).toHaveLength(1);
    expect(taskField(app.store, made[0].id)).toMatchObject({ status: 'In Progress', pending: true, taskId: 'TASK-5' });
    expect(box(app, 'b1').querySelector('[data-quick]')).toBeNull();
    expect(panelOpen()).toBe(false);
  });

  it('Shift+Enter makes it and opens the card; Esc and an empty Enter make nothing', () => {
    const app = setup();
    let input = open(app);
    input.value = 'Open me';
    enter(input, true);
    expect(panelOpen()).toBe(true);
    closeTask();
    input = open(app);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(box(app, 'b1').querySelector('[data-quick]')).toBeNull();
    input = open(app);
    enter(input);
    expect(app.doc.nodes.filter((n) => kx(n)?.kind === 'task')).toHaveLength(5);
  });

  it('a paste of several lines makes several tasks, blank lines skipped; one line makes one', () => {
    const app = setup();
    const input = open(app);
    input.value = 'first\n\n  second  \nthird\n';
    input.dispatchEvent(new Event('input'));
    expect(Number(input.rows)).toBe(4);
    enter(input);
    const titles = app.doc.nodes.filter((n) => kx(n)?.kind === 'task' && task(n).pending).map((n) => task(n).title);
    expect(titles).toEqual(['first', 'second', 'third']);
  });

  it('typing in the field is not the table\'s: keys do not bubble', () => {
    const app = setup();
    const input = open(app);
    const seen: string[] = [];
    app.view.root.addEventListener('keydown', (e) => seen.push(e.key));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(seen).toEqual([]);
  });

  it('a redraw of the board (the sync changed something) keeps the text typed so far', () => {
    const app = setup();
    const input = open(app);
    input.value = 'half way';
    input.dispatchEvent(new Event('input'));
    app.store.apply([{ op: 'set', id: 'b1', key: 'x-kanban.labels', value: ['canvas', 'ui', 'new'] }]);
    const again = box(app, 'b1').querySelector<HTMLTextAreaElement>('[data-quick]')!;
    expect(again).toBeTruthy();
    expect(again.value).toBe('half way');
  });
});

describe('menus, keys and opening (C52, C81)', () => {
  it('the board menu filters by label and by parent and clears; the filter lands on the node', () => {
    const app = setup();
    addTask(app.store, 'b1', { title: 'Child', taskId: 'TASK-1.1', parent: 'TASK-1', labels: ['canvas'] }, 'child');
    const entries = (app.menuProviders[0](app, [app.node('b1') as CanvasNode])!).entries;
    const labels = entries.find((e) => e.label === 'Filter by label')!;
    (labels.items as { label: string; run(): void }[]).find((i) => i.label === 'canvas')!.run();
    expect(kx(app.node('b1'))!.filter).toEqual({ labels: ['canvas'] });
    const subs = entries.find((e) => e.label === 'Subtasks of…')!;
    expect((subs.items as { label: string }[]).map((i) => i.label)).toEqual(['TASK-1']);
    (subs.items as { run(): void }[])[0].run();
    expect(kx(app.node('b1'))!.filter).toEqual({ labels: ['canvas'], parent: 'TASK-1' });
    app.menuProviders[0](app, [app.node('b1') as CanvasNode])!.entries.find((e) => e.label === 'Clear filters')!.run!();
    expect(kx(app.node('b1'))!.filter).toBeUndefined();
  });

  it('no menu or panel offers a folder or a path: nothing in the plugin mentions the file picker (C80, C81)', () => {
    const app = setup();
    const labels = JSON.stringify(app.menuProviders.map((p) => p(app, [app.node('b1') as CanvasNode])?.entries.map((e) => e.label)));
    expect(labels).not.toMatch(/folder|path|directory/i);
  });

  it('clicking a card or pressing Enter on it opens the panel; Esc closes it', () => {
    const app = setup();
    type(app, 'one').onClick!(app.node('one')!, new PointerEvent('pointerdown'), app);
    expect(panelOpen()).toBe(true);
    closeTask();
    app.store.select(['one']);
    app.keys.get('enter')!.run(app);
    expect(panelOpen()).toBe(true);
    app.keys.get('escape')!.run(app);
    expect(panelOpen()).toBe(false);
  });

  it('a task menu changes status, priority and labels through the commands', () => {
    const app = setup();
    const entries = app.menuProviders[0](app, [app.node('one') as CanvasNode])!.entries;
    (entries.find((e) => e.label === 'Status')!.items as { label: string; run(): void }[]).find((i) => i.label === 'Done')!.run();
    expect(taskField(app.store, 'one').status).toBe('Done');
    (entries.find((e) => e.label === 'Priority')!.items as { label: string; run(): void }[]).find((i) => i.label === 'high')!.run();
    expect(taskField(app.store, 'one').priority).toBe('high');
  });
});

describe('seats and notices', () => {
  it('a card gets a dot while its assignee is seated, and loses it when they leave', () => {
    const app = setup();
    app.store.apply([{ op: 'set', id: 'two', key: 'x-kanban.assignee', value: ['@claude'] }]);
    expect(box(app, 'two').querySelector('.kb-seated')).toBeNull();
    let peers = [{ clientId: 2, id: 'agent:claude', name: 'Claude · task-3.48', color: '#d97757', cursor: null, sel: [], held: [] }];
    const listeners = new Set<() => void>();
    app.presence = { me: { id: 'me', name: 'Alex', color: '#00f' }, peers: () => peers, onChange: (fn: () => void) => listeners.add(fn) } as never;
    app.store.apply([{ op: 'set', id: 'b1', key: 'x-kanban.labels', value: ['canvas'] }]); // any store change attaches the presence listener
    listeners.forEach((f) => f());
    expect(box(app, 'two').querySelector('.kb-seated')).toBeTruthy();
    peers = [];
    listeners.forEach((f) => f());
    expect(box(app, 'two').querySelector('.kb-seated')).toBeNull();
  });

  it('a conflict or error entry in the log reaches the notice line once, for entries that are fresh', () => {
    const app = setup();
    const told: string[] = [];
    app.onNotify((m) => told.push(m));
    app.store.appendLog([
      { type: 'kanban.conflict', text: "TASK-2 title: changed in the file meanwhile; kept the file's" },
      { type: 'kanban.error', text: 'could not write TASK-1: the file is read-only' },
      { type: 'kanban.file', text: 'moved TASK-2 to Done' },
    ]);
    expect(told).toEqual(["TASK-2 title: changed in the file meanwhile; kept the file's", 'could not write TASK-1: the file is read-only']);
  });
});
