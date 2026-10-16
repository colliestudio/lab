import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { board, clock, column, task, tasksOf } from './model';
import { cleanEdit } from './commands';
import { NOW, addBoard, addTask, kanbanStore, resetCounter, taskField } from './testkit';

beforeEach(() => {
  resetCounter();
  clock.now = () => NOW;
});

const seeded = () => {
  const s = kanbanStore();
  addBoard(s);
  addTask(s, 'b1', { title: 'one', taskId: 'TASK-1', ordinal: 1000 }, 'one');
  addTask(s, 'b1', { title: 'two', taskId: 'TASK-2', ordinal: 2000 }, 'two');
  addTask(s, 'b1', { title: 'three', taskId: 'TASK-3', ordinal: 3000 }, 'three');
  addTask(s, 'b1', { title: 'doing', taskId: 'TASK-4', status: 'In Progress', ordinal: 4000 }, 'doing');
  s.undoManager.clear();
  return s;
};
const order = (s: ReturnType<typeof kanbanStore>, status: string) => column(s.doc, 'b1', status).map((t) => t.id);

describe('move (C15)', () => {
  it('a drag to another column changes the status only when the order already fits', () => {
    const s = seeded();
    s.dispatch('kanban.move', { board: 'b1', ids: ['one'], status: 'In Progress', index: 0 });
    expect(taskField(s, 'one')).toMatchObject({ status: 'In Progress' });
    expect(order(s, 'In Progress')).toEqual(['one', 'doing']); // 1000 < 4000
    expect(taskField(s, 'one').ordinal).toBe(1000); // no ordinal write
  });

  it('reorders with as few ordinal writes as possible: one card between its neighbours', () => {
    const s = seeded();
    s.dispatch('kanban.move', { board: 'b1', ids: ['three'], status: 'To Do', index: 1 });
    expect(order(s, 'To Do')).toEqual(['one', 'three', 'two']);
    expect(taskField(s, 'three').ordinal).toBe(1500);
    expect([taskField(s, 'one').ordinal, taskField(s, 'two').ordinal]).toEqual([1000, 2000]);
  });

  it('to the end uses the last ordinal + 1000; to the top halves the first', () => {
    const s = seeded();
    s.dispatch('kanban.move', { board: 'b1', ids: ['one'], status: 'To Do', index: 99 });
    expect(order(s, 'To Do')).toEqual(['two', 'three', 'one']);
    expect(taskField(s, 'one').ordinal).toBe(4000);
    s.dispatch('kanban.move', { board: 'b1', ids: ['one'], status: 'To Do', index: 0 });
    expect(order(s, 'To Do')).toEqual(['one', 'two', 'three']);
    expect(taskField(s, 'one').ordinal).toBe(1000);
  });

  it('dropped where it was: no change at all, no undo step', () => {
    const s = seeded();
    const r = s.dispatch('kanban.move', { board: 'b1', ids: ['two'], status: 'To Do', index: 1 });
    expect(r.changes).toEqual([]);
    expect(s.undoManager.undoStack).toHaveLength(0);
  });

  it('renumbers the column when there is no room between ordinals; unordered neighbours get numbers', () => {
    const s = kanbanStore();
    addBoard(s);
    addTask(s, 'b1', { title: 'a', ordinal: 1000, taskId: 'TASK-1' }, 'a');
    addTask(s, 'b1', { title: 'b', ordinal: 1001, taskId: 'TASK-2' }, 'b');
    addTask(s, 'b1', { title: 'c', taskId: 'TASK-3' }, 'c');
    s.dispatch('kanban.move', { board: 'b1', ids: ['c'], status: 'To Do', index: 1 });
    expect(order(s, 'To Do')).toEqual(['a', 'c', 'b']);
    expect(['a', 'c', 'b'].map((id) => taskField(s, id).ordinal)).toEqual([1000, 2000, 3000]);
  });

  it('several cards at once keep their order; a bad status, board or id does nothing', () => {
    const s = seeded();
    s.dispatch('kanban.move', { board: 'b1', ids: ['three', 'one'], status: 'Done', index: 0 });
    expect(order(s, 'Done')).toEqual(['three', 'one']);
    const before = JSON.stringify(s.doc.nodes);
    for (const bad of [{ board: 'b1', ids: ['one'], status: 'Nowhere', index: 0 }, { board: 'nope', ids: ['one'], status: 'Done', index: 0 }, { board: 'b1', ids: ['nope'], status: 'Done', index: 0 }, { board: 'b1', ids: ['b1'], status: 'Done', index: 0 }]) s.dispatch('kanban.move', bad);
    expect(JSON.stringify(s.doc.nodes)).toBe(before);
  });

  it('index counts the tasks that show: hidden ones (filtered, old Done) keep their place', () => {
    const s = seeded();
    addTask(s, 'b1', { title: 'ui only', labels: ['ui'], ordinal: 1500, taskId: 'TASK-5' }, 'ui');
    s.dispatch('kanban.filter', { board: 'b1', labels: ['canvas'] });
    addTask(s, 'b1', { title: 'c1', labels: ['canvas'], ordinal: 900, taskId: 'TASK-6' }, 'c1');
    // shown To Do: c1, (one, two, three have no label canvas -> hidden)... all hidden but c1
    s.dispatch('kanban.move', { board: 'b1', ids: ['doing'], status: 'To Do', index: 99 });
    expect(order(s, 'To Do').at(-1)).toBe('doing');
  });

  it('a move that changes the status logs it; undo puts status and ordinal back', () => {
    const s = seeded();
    s.dispatch('kanban.move', { board: 'b1', ids: ['three'], status: 'In Progress', index: 0 });
    expect(s.log.toArray().map((e) => e.type)).toContain('kanban.move');
    expect(s.log.toArray().at(-1)!.text).toBe('moved TASK-3 to In Progress');
    s.undo();
    expect(taskField(s, 'three')).toMatchObject({ status: 'To Do', ordinal: 3000 });
  });
});

describe('edit (C45)', () => {
  it('changes only what differs; every field is separate; clears with null / empty', () => {
    const s = seeded();
    expect(s.dispatch('kanban.edit', { id: 'one', patch: { title: 'one' } }).changes).toEqual([]);
    s.dispatch('kanban.edit', { id: 'one', patch: { title: ' New  title ', labels: ['a', 'a', ' b '], assignee: ['@x'], priority: 'high', description: 'D', plan: 'P', notes: 'N', ac: [{ text: 'a1', done: true }, { text: 'a2', done: false }] } });
    expect(taskField(s, 'one')).toMatchObject({ title: 'New title', labels: ['a', 'b'], assignee: ['@x'], priority: 'high', description: 'D', plan: 'P', notes: 'N', ac: [{ text: 'a1', done: true }, { text: 'a2', done: false }] });
    s.dispatch('kanban.edit', { id: 'one', patch: { priority: null } });
    expect(taskField(s, 'one').priority).toBeUndefined();
    s.undo();
    expect(taskField(s, 'one').priority).toBe('high');
  });

  it('refuses what is not a task field: status, ordinal, base, taskId, unknown keys, bad priority, huge input', () => {
    const s = seeded();
    const before = JSON.stringify(taskField(s, 'one'));
    s.dispatch('kanban.edit', { id: 'one', patch: { status: 'Done', ordinal: 5, base: { title: 'x' }, taskId: 'TASK-99', board: 'zz', path: '/etc/passwd', priority: 'urgent', title: '   ' } });
    expect(JSON.stringify(taskField(s, 'one'))).toBe(before);
    expect(cleanEdit({ title: 'x'.repeat(2000) }).title).toHaveLength(500);
    expect(cleanEdit({ ac: Array(500).fill({ text: 't' }) }).ac).toHaveLength(200);
    expect(cleanEdit({ ac: [{ text: '  ' }, { done: true }, 'str', null] }).ac).toEqual([]);
    expect(cleanEdit(null)).toEqual({});
    s.dispatch('kanban.edit', { id: 'b1', patch: { title: 'x' } });
    expect(board(s.doc.get('b1')!).name).toBe('demo');
  });

  it('a note on the card (a conflict) is cleared by the next edit of it', () => {
    const s = seeded();
    s.apply([{ op: 'set', id: 'one', key: 'x-kanban.note', value: 'title: the file won' }]);
    s.dispatch('kanban.edit', { id: 'one', patch: { title: 'again' } });
    expect(taskField(s, 'one').note).toBeUndefined();
  });
});

describe('create: quick add and paste (C16, C17)', () => {
  it('one title makes one task at the end of the column, with the next id and an ordinal past every task', () => {
    const s = seeded();
    const r = s.dispatch('kanban.create', { board: 'b1', titles: ['New thing'] });
    const id = r.select![0];
    expect(taskField(s, id)).toMatchObject({ title: 'New thing', status: 'To Do', taskId: 'TASK-5', pending: true, ordinal: 5000, labels: [] });
    expect(taskField(s, id).parent).toBeUndefined();
    expect(column(s.doc, 'b1', 'To Do').at(-1)!.id).toBe(id);
    expect(board(s.doc.get('b1')!).nextId).toBe('TASK-6');
    expect(s.doc.parentOf(id)).toBe('b1');
  });

  it('a paste of lines makes one task per non-empty line, in order, ids consecutive; blank lines are skipped', () => {
    const s = seeded();
    const r = s.dispatch('kanban.create', { board: 'b1', titles: ['first', '', '  ', 'second', 'third'], status: 'In Progress' });
    expect(r.select).toHaveLength(3);
    expect(r.select!.map((id) => task(s.doc.get(id)!).title)).toEqual(['first', 'second', 'third']);
    expect(r.select!.map((id) => taskField(s, id).taskId)).toEqual(['TASK-5', 'TASK-6', 'TASK-7']);
    expect(order(s, 'In Progress').slice(-3)).toEqual(r.select);
    expect(board(s.doc.get('b1')!).nextId).toBe('TASK-8');
    // asking again continues the numbering
    const again = s.dispatch('kanban.create', { board: 'b1', titles: ['next'] });
    expect(taskField(s, again.select![0]).taskId).toBe('TASK-8');
  });

  it('is not undoable: undo leaves the new task (a file exists by then) and undoes the step before', () => {
    const s = seeded();
    s.dispatch('kanban.edit', { id: 'one', patch: { title: 'edited' } });
    const r = s.dispatch('kanban.create', { board: 'b1', titles: ['kept'] });
    expect(s.undoManager.undoStack).toHaveLength(1);
    s.undo();
    expect(taskField(s, 'one').title).toBe('one');
    expect(s.doc.get(r.select![0])).toBeDefined();
  });

  it('inherits the node filter: labels and parent; subtasks get TASK-n.m ids', () => {
    const s = seeded();
    addTask(s, 'b1', { title: 'sub', taskId: 'TASK-3.1', parent: 'TASK-3' }, 'sub');
    s.dispatch('kanban.filter', { board: 'b1', labels: ['canvas'], parent: 'TASK-3' });
    const r = s.dispatch('kanban.create', { board: 'b1', titles: ['child'] });
    expect(taskField(s, r.select![0])).toMatchObject({ labels: ['canvas'], parent: 'TASK-3', taskId: 'TASK-3.2' });
    const own = s.dispatch('kanban.create', { board: 'b1', titles: ['own'], labels: ['ui'], parent: 'TASK-1' });
    expect(taskField(s, own.select![0])).toMatchObject({ labels: ['ui'], parent: 'TASK-1', taskId: 'TASK-1.1' });
  });

  it('refuses a bad board, no titles, a status that does not exist (falls back to the default column)', () => {
    const s = seeded();
    const n = s.doc.nodes.length;
    s.dispatch('kanban.create', { board: 'nope', titles: ['x'] });
    s.dispatch('kanban.create', { board: 'b1', titles: [] });
    s.dispatch('kanban.create', { board: 'b1', titles: ['', ' '] });
    expect(s.doc.nodes).toHaveLength(n);
    const r = s.dispatch('kanban.create', { board: 'b1', titles: ['x'], status: 'Nowhere' });
    expect(taskField(s, r.select![0]).status).toBe('To Do');
  });

  it('title with punctuation and unicode is kept as typed (one line)', () => {
    const s = seeded();
    const r = s.dispatch('kanban.create', { board: 'b1', titles: ['Fix: it\'s "x" #1 é 🎉\n second line'] });
    expect(taskField(s, r.select![0]).title).toBe('Fix: it\'s "x" #1 é 🎉 second line');
  });
});

describe('comment', () => {
  it('queues the comment for the serve, as @<first word of the actor>, and is not undoable', () => {
    const s = kanbanStore({ actor: { id: 'p1', name: 'Alex Luong', color: '#000' } });
    addBoard(s);
    addTask(s, 'b1', { title: 'T' }, 't1');
    s.undoManager.clear();
    s.dispatch('kanban.comment', { id: 't1', text: '  hello\nthere ' });
    expect(taskField(s, 't1').outbox).toEqual([{ key: 'id1', author: '@alex', text: 'hello\nthere' }]);
    expect(s.undoManager.undoStack).toHaveLength(0);
    s.dispatch('kanban.comment', { id: 't1', text: 'again' });
    expect(taskField(s, 't1').outbox).toHaveLength(2);
    expect(s.dispatch('kanban.comment', { id: 't1', text: '   ' }).changes).toEqual([]);
    expect(s.dispatch('kanban.comment', { id: 'b1', text: 'x' }).changes).toEqual([]);
  });
});

describe('boards and duplicates', () => {
  it('addBoard needs a source name, never a path', () => {
    const s = kanbanStore();
    expect(s.dispatch('kanban.addBoard', { x: 0, y: 0, source: 'cs' }).select).toHaveLength(1);
    const n = s.doc.nodes.length;
    for (const source of ['../x', '/etc', 'a b', '', 'A', 'x'.repeat(40), 'c:\\x', '~']) s.dispatch('kanban.addBoard', { x: 0, y: 0, source });
    expect(s.doc.nodes).toHaveLength(n);
  });

  it('⌘D copies neither a task nor a board', () => {
    const s = seeded();
    const n = s.doc.nodes.length;
    s.dispatch('core.duplicate', { ids: ['one', 'b1'] });
    expect(s.doc.nodes).toHaveLength(n);
    expect(tasksOf(s.doc, 'b1')).toHaveLength(4);
  });

  it('two viewers: one moves a card, the other sees it (the doc is the shared state)', () => {
    const a = seeded();
    const b = kanbanStore({ prefix: 'p' });
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    a.ydoc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'b' && Y.applyUpdate(b.ydoc, u, 'a'));
    b.ydoc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'a' && Y.applyUpdate(a.ydoc, u, 'b'));
    b.dispatch('kanban.move', { board: 'b1', ids: ['two'], status: 'In Progress', index: 0 });
    expect(taskField(a, 'two').status).toBe('In Progress');
    // undo is per viewer: a's undo does not revert b's move
    a.dispatch('kanban.edit', { id: 'one', patch: { title: 'A edit' } });
    a.undo();
    expect(taskField(a, 'two').status).toBe('In Progress');
    expect(taskField(a, 'one').title).toBe('one');
  });
});
