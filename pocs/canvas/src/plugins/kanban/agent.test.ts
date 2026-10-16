import { beforeEach, describe, expect, it } from 'vitest';
import { applyAc, boardText, needBoard, needTask } from './agent';
import { clock, task } from './model';
import { NOW, addBoard, addTask, kanbanStore, resetCounter, stampDaysAgo } from './testkit';

beforeEach(() => {
  resetCounter();
  clock.now = () => NOW;
});

const seeded = () => {
  const s = kanbanStore();
  addBoard(s);
  addTask(s, 'b1', { title: 'Serve: fail loudly', taskId: 'TASK-3.45', priority: 'high', ordinal: 1 }, 'a');
  addTask(s, 'b1', { title: 'Real kanban plugin', taskId: 'TASK-3.48', assignee: ['@claude'], ac: [{ text: 'x', done: true }, { text: 'y', done: false }], ordinal: 2 }, 'b');
  addTask(s, 'b1', { title: 'Real kanban plugin, part two', taskId: 'TASK-3.49', ordinal: 3 }, 'c');
  addTask(s, 'b1', { title: 'Shipped', taskId: 'TASK-3.1', status: 'Done', updated: stampDaysAgo(2), ordinal: 4 }, 'd');
  addTask(s, 'b1', { title: 'Shipped long ago', taskId: 'TASK-3.2', status: 'Done', updated: stampDaysAgo(60), ordinal: 5 }, 'e');
  return s;
};

describe('naming a task and a node', () => {
  it('by id (any case, or just the number), by exact title, by a unique part of the title', () => {
    const s = seeded();
    const b = s.doc.get('b1')!;
    expect(needTask(s.doc, b, 'TASK-3.48').id).toBe('b');
    expect(needTask(s.doc, b, 'task-3.45').id).toBe('a');
    expect(needTask(s.doc, b, '3.45').id).toBe('a');
    expect(needTask(s.doc, b, 'serve: fail loudly').id).toBe('a');
    expect(needTask(s.doc, b, 'fail loud').id).toBe('a');
    expect(needTask(s.doc, b, 'Real kanban plugin').id).toBe('b'); // the exact title beats the longer one
  });
  it('an ambiguous part, a missing task and a missing board say what is there', () => {
    const s = seeded();
    const b = s.doc.get('b1')!;
    expect(() => needTask(s.doc, b, 'kanban')).toThrow(/matches 2 tasks: TASK-3.48 \(Real kanban plugin\), TASK-3.49/);
    expect(() => needTask(s.doc, b, 'TASK-9')).toThrow(/no task "TASK-9"/);
    expect(() => needBoard(kanbanStore().doc)).toThrow(/no kanban node on this board/);
    addBoard(s, {}, 'b2');
    expect(() => needBoard(s.doc)).toThrow(/there are 2 kanban nodes; say which one with board: “demo” \(b1\), “demo” \(b2\)/);
    expect(needBoard(s.doc, 'b2').id).toBe('b2');
    expect(() => needBoard(s.doc, 'a')).toThrow(/is not a kanban node/);
  });
});

describe('a node that is not live', () => {
  it('commands refuse with the reason and the view still reads', () => {
    const s = seeded();
    s.apply([{ op: 'set', id: 'b1', key: 'x-kanban.state', value: { error: 'this serve has no kanban folder named "x"' } }]);
    expect(() => needBoard(s.doc)).toThrow(/is not live: this serve has no kanban folder named "x"; nothing was changed/);
    expect(needBoard(s.doc, undefined, false).id).toBe('b1');
    for (const [name, args] of [['kanban.move', { task: 'TASK-1', status: 'Done' }], ['kanban.create', { title: 'x' }], ['kanban.edit', { task: 'TASK-1', title: 'y' }], ['kanban.comment', { task: 'TASK-1', text: 'c' }]] as const) {
      expect(() => s.spec(name)!.toCommand!(args as never, { doc: s.doc } as never), name).toThrow(/not live/);
    }
    s.apply([{ op: 'set', id: 'b1', key: 'x-kanban.state', value: undefined }]);
    expect(() => needBoard(s.doc)).toThrow(/no canvas serve is syncing it/);
    expect(String(s.viewSpec('kanban.board')!.read(s.doc, {}, { id: 'x', name: 'x', color: '#000' }))).toContain('not synced yet');
  });
});

describe('marker lines in agent text', () => {
  it('kanban.edit and kanban.comment refuse a line that is a block marker; the UI command drops the field', () => {
    const s = seeded();
    const ctx = { doc: s.doc } as never;
    expect(() => s.spec('kanban.edit')!.toCommand!({ task: 'TASK-3.45', notes: 'x\n<!-- AC:END -->' } as never, ctx)).toThrow(/block markers/);
    expect(() => s.spec('kanban.comment')!.toCommand!({ task: 'TASK-3.45', text: '<!-- COMMENTS:END -->' } as never, ctx)).toThrow(/block markers/);
    expect(() => s.spec('kanban.create')!.toCommand!({ title: 'x', description: '<!-- AC:BEGIN -->' } as never, ctx)).toThrow(/block markers/);
    const made = s.dispatch('kanban.create', { board: 'b1', titles: ['y'], description: '<!-- AC:BEGIN -->' });
    expect(s.doc.get(made.select![0])!['x-kanban']).toMatchObject({ description: '' });
    s.dispatch('kanban.edit', { id: 'a', patch: { notes: '<!-- SECTION:NOTES:END -->', title: 'ok' } });
    expect(s.doc.get('a')!['x-kanban']).toMatchObject({ title: 'ok', notes: '' });
  });
});

describe('acceptance list ops (1-based, like --check-ac)', () => {
  const t = (ac: { text: string; done: boolean }[]) => ({ ac }) as never;
  const list = [{ text: 'a', done: false }, { text: 'b', done: true }];
  it('check, uncheck, set, remove and add; one call can add an item and tick it', () => {
    expect(applyAc(t(list), { check: [1], uncheck: [2] })).toEqual([{ text: 'a', done: true }, { text: 'b', done: false }]);
    expect(applyAc(t(list), { set: [{ index: 2, text: 'B!' }] })).toEqual([{ text: 'a', done: false }, { text: 'B!', done: true }]);
    expect(applyAc(t(list), { remove: [1] })).toEqual([{ text: 'b', done: true }]);
    expect(applyAc(t(list), { add: ['c'], check: [3] })).toEqual([...list, { text: 'c', done: true }]);
    expect(applyAc(t([]), { add: ['first'] })).toEqual([{ text: 'first', done: false }]);
  });
  it('a number out of range names the range', () => {
    expect(() => applyAc(t(list), { check: [3] })).toThrow(/#3 does not exist \(1 to 2\)/);
    expect(() => applyAc(t([]), { uncheck: [1] })).toThrow(/this task has none/);
    expect(() => applyAc(t(list), { remove: [0] })).toThrow(/#0/);
  });
  it('never changes the task it was given', () => {
    const task = { ac: list.map((x) => ({ ...x })) } as never;
    applyAc(task, { check: [1] });
    expect((task as { ac: typeof list }).ac).toEqual(list);
  });
});

describe('the board as text (C65)', () => {
  it('columns, one line per task with id, priority, AC progress, assignee; Done collapsed to recent with +N older', () => {
    const s = seeded();
    const text = boardText(s.doc, s.doc.get('b1')!);
    expect(text).toBe(
      [
        'demo (demo) · live · b1',
        'To Do (3)',
        '  TASK-3.45 [high] Serve: fail loudly',
        '  TASK-3.48 Real kanban plugin · AC 1/2 · @claude',
        '  TASK-3.49 Real kanban plugin, part two',
        'In Progress (0)',
        'Done (2) · last 14 days: 1',
        '  TASK-3.1 Shipped',
        '  +1 older (all: true shows them)',
      ].join('\n'),
    );
    expect(boardText(s.doc, s.doc.get('b1')!, true)).toContain('TASK-3.2 Shipped long ago');
  });
  it('shows the filter, a node that is not live, and stays small for 30 tasks', () => {
    const s = seeded();
    s.dispatch('kanban.filter', { board: 'b1', labels: ['canvas'], parent: 'TASK-3' });
    expect(boardText(s.doc, s.doc.get('b1')!).split('\n')[0]).toBe('demo (demo) · live · filter: label canvas, parent TASK-3 · b1');
    s.apply([{ op: 'set', id: 'b1', key: 'x-kanban.state', value: { error: 'the tasks folder is missing' } }, { op: 'set', id: 'b1', key: 'x-kanban.filter', value: undefined }]);
    expect(boardText(s.doc, s.doc.get('b1')!).split('\n')[0]).toBe('demo (demo) · NOT LIVE: the tasks folder is missing · b1');
    for (let i = 0; i < 30; i++) addTask(s, 'b1', { title: `A reasonably long task title number ${i} for size`, priority: 'medium', assignee: ['@claude'], ac: [{ text: 'a', done: false }], ordinal: 100 + i });
    expect(boardText(s.doc, s.doc.get('b1')!, false).length).toBeLessThan(4000);
  });
  it('one task in full: sections, criteria with numbers, comments', () => {
    const s = seeded();
    s.apply([{ op: 'set', id: 'b', key: 'x-kanban.description', value: 'About it' }, { op: 'set', id: 'b', key: 'x-kanban.comments', value: [{ author: '@lead', created: '2026-10-16 11:05', text: 'a\nb' }] }]);
    const v = s.viewSpec('kanban.board')!;
    const text = String(v.read(s.doc, { task: 'TASK-3.48' }, { id: 'x', name: 'x', color: '#000' }));
    expect(text).toContain('TASK-3.48 Real kanban plugin');
    expect(text).toContain('Description:\nAbout it');
    expect(text).toContain('Acceptance criteria:\n1. [x] x\n2. [ ] y');
    expect(text).toContain('- @lead 2026-10-16 11:05: a / b');
    expect(task(s.doc.get('b')!).title).toBe('Real kanban plugin');
  });
});
