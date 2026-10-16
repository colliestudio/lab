import { beforeEach, describe, expect, it } from 'vitest';
import { serialize, parse } from '../../core';
import { queryNodes } from '../../core/query';
import { layoutRule } from './layout';
import { FIELD, assigneeSeated, board, byOrder, clock, columnsOf, derivedLinks, dirtyFields, isRecent, seatOf, shownIn, task, tasksOf, visibleTasks } from './model';
import { hashFields } from './markdown';
import { NOW, addBoard, addTask, kanbanStore, resetCounter, stampDaysAgo, taskField } from './testkit';

beforeEach(() => {
  resetCounter();
  clock.now = () => NOW;
});

describe('columns and order', () => {
  it('columns are the board statuses in order, plus any status a task uses that the config lacks', () => {
    const s = kanbanStore();
    addBoard(s);
    addTask(s, 'b1', { title: 'odd', status: 'Blocked' });
    expect(columnsOf(s.doc, s.doc.get('b1')!)).toEqual(['To Do', 'In Progress', 'Done', 'Blocked']);
  });

  it('orders by ordinal, then by id numerically (2, 2.1, 10), new unsaved tasks last, and is stable', () => {
    const s = kanbanStore();
    addBoard(s);
    addTask(s, 'b1', { title: 'c', ordinal: 3000, taskId: 'TASK-3' }, 'c');
    addTask(s, 'b1', { title: 'a', ordinal: 1000, taskId: 'TASK-1' }, 'a');
    addTask(s, 'b1', { title: 'u10', taskId: 'TASK-10' }, 'u10');
    addTask(s, 'b1', { title: 'u2', taskId: 'TASK-2' }, 'u2');
    addTask(s, 'b1', { title: 'u2.1', taskId: 'TASK-2.1' }, 'u21');
    addTask(s, 'b1', { title: 'new', taskId: undefined }, 'new');
    const order = tasksOf(s.doc, 'b1').sort(byOrder).map((t) => t.id);
    expect(order).toEqual(['a', 'c', 'u2', 'u21', 'u10', 'new']);
    expect(tasksOf(s.doc, 'b1').sort(byOrder).map((t) => t.id)).toEqual(order);
  });
});

describe('filters and Done collapse', () => {
  const build = () => {
    const s = kanbanStore();
    addBoard(s);
    addTask(s, 'b1', { title: 'todo canvas', labels: ['canvas'], parent: 'TASK-3' }, 'a');
    addTask(s, 'b1', { title: 'todo ui', labels: ['ui'] }, 'b');
    addTask(s, 'b1', { title: 'done 14', status: 'Done', labels: ['canvas'], updated: stampDaysAgo(14) }, 'd14');
    addTask(s, 'b1', { title: 'done 15', status: 'Done', labels: ['canvas'], updated: stampDaysAgo(15) }, 'd15');
    addTask(s, 'b1', { title: 'done created only', status: 'Done', created: stampDaysAgo(2) }, 'dc');
    addTask(s, 'b1', { title: 'done no date', status: 'Done' }, 'dn');
    return s;
  };
  const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id).sort();

  it('exactly 14 days is recent, 15 is not; created_date stands in for updated; no date counts as old', () => {
    const s = build();
    const { shown, hidden, filtered } = shownIn(s.doc, s.doc.get('b1')!, 'Done');
    expect(ids(shown)).toEqual(['d14', 'dc']);
    expect(hidden).toBe(2);
    expect(filtered).toHaveLength(4);
    expect(isRecent(taskField(s, 'dn'), 14, NOW)).toBe(false);
  });

  it('+N counts what the filter leaves; label filter is any-of, parent filter is the subtasks of that task', () => {
    const s = build();
    s.dispatch('kanban.filter', { board: 'b1', labels: ['canvas'] });
    expect(ids(visibleTasks(s.doc, s.doc.get('b1')!))).toEqual(['a', 'd14']);
    expect(shownIn(s.doc, s.doc.get('b1')!, 'Done').hidden).toBe(1);
    s.dispatch('kanban.filter', { board: 'b1', labels: ['canvas', 'ui'] });
    expect(ids(visibleTasks(s.doc, s.doc.get('b1')!))).toEqual(['a', 'b', 'd14']);
    s.dispatch('kanban.filter', { board: 'b1', labels: null, parent: 'task-3' });
    expect(board(s.doc.get('b1')!).filter).toEqual({ parent: 'TASK-3' });
    expect(ids(visibleTasks(s.doc, s.doc.get('b1')!))).toEqual(['a']);
    s.dispatch('kanban.filter', { board: 'b1', parent: null });
    expect(board(s.doc.get('b1')!).filter).toBeUndefined();
  });

  it('expanding Done shows the older ones too; a column over the limit cuts to 8 until expanded', () => {
    const s = build();
    s.dispatch('kanban.expand', { id: 'b1', status: 'Done', on: true });
    expect(shownIn(s.doc, s.doc.get('b1')!, 'Done').shown).toHaveLength(4);
    for (let i = 0; i < 12; i++) addTask(s, 'b1', { title: `x${i}`, status: 'In Progress', ordinal: i + 1 });
    expect(shownIn(s.doc, s.doc.get('b1')!, 'In Progress')).toMatchObject({ hidden: 4 });
    expect(shownIn(s.doc, s.doc.get('b1')!, 'In Progress').shown).toHaveLength(8);
  });

  it('a task whose edit is still being written stays in view: a new one past the cut, an old one just dragged to Done', () => {
    const s = kanbanStore();
    addBoard(s);
    for (let i = 0; i < 9; i++) addTask(s, 'b1', { title: `t${i}`, ordinal: i + 1 });
    const b = () => s.doc.get('b1')!;
    expect(shownIn(s.doc, b(), 'To Do')).toMatchObject({ hidden: 1 });
    const fresh = s.dispatch('kanban.create', { board: 'b1', titles: ['just added'] }).select![0];
    expect(shownIn(s.doc, b(), 'To Do').shown.map((t) => t.id)).toContain(fresh);
    expect(shownIn(s.doc, b(), 'To Do').hidden).toBe(1);
    // an old task dragged into Done is dirty until the file has it: it shows meanwhile
    const fields = { title: 'x', status: 'To Do', labels: [], assignee: [], description: '', plan: '', notes: '', ac: [] };
    addTask(s, 'b1', { ...fields, title: 'ancient', status: 'Done', updated: stampDaysAgo(90), base: { ...hashFields({ ...fields, title: 'ancient' }), status: 'stale' } }, 'anc');
    expect(shownIn(s.doc, b(), 'Done').shown.map((t) => t.id)).toContain('anc');
    s.apply([{ op: 'set', id: 'anc', key: 'x-kanban.base', value: hashFields({ ...fields, title: 'ancient', status: 'Done' }) }]);
    expect(shownIn(s.doc, b(), 'Done').shown.map((t) => t.id)).not.toContain('anc');
  });

  it('the filter is saved on the node: it survives a reload through the board file, and a second viewer sees it', () => {
    const s = build();
    s.dispatch('kanban.filter', { board: 'b1', labels: ['canvas'], parent: 'TASK-3' });
    s.dispatch('kanban.expand', { id: 'b1', status: 'Done', on: true });
    const text = serialize(s.exportDoc());
    const back = kanbanStore();
    back.load(parse(text));
    expect(board(back.doc.get('b1')!)).toMatchObject({ filter: { labels: ['canvas'], parent: 'TASK-3' }, expanded: ['Done'], source: 'demo' });
  });

  it('layout places only what shows: filtered-out and old Done tasks have no box', () => {
    const s = build();
    const placed = layoutRule(s.doc);
    const shown = (id: string) => s.doc.isVisible(id);
    expect(shown('a') && shown('b') && shown('d14') && shown('dc')).toBe(true);
    expect(shown('d15') || shown('dn')).toBe(false);
    expect(placed.get('d14')!.height).toBeLessThan(placed.get('a')!.height!); // Done rows are one line
    s.dispatch('kanban.filter', { board: 'b1', labels: ['canvas'] });
    expect(s.doc.isVisible('b')).toBe(false);
  });
});

describe('export', () => {
  it('the board file keeps the card face and the filter; not hashes, sections, comments, outbox, the sync state or a path', () => {
    const s = kanbanStore();
    addBoard(s);
    addTask(s, 'b1', { title: 'T', description: 'D', plan: 'P', notes: 'N', ac: [{ text: 'a', done: false }], comments: [{ text: 'c' }], 'outbox:k': { key: 'k', at: 1, author: '@a', text: 'x' }, base: { title: 'zz' }, note: 'n' }, 't1');
    const exported = s.exportDoc();
    const t = exported.nodes.find((n) => n.id === 't1')!;
    expect(t[FIELD]).toMatchObject({ kind: 'task', title: 'T', taskId: 'TASK-1' });
    for (const k of ['base', 'description', 'plan', 'notes', 'ac', 'comments', 'outbox', 'note']) expect(t[FIELD], k).not.toHaveProperty(k);
    expect(Object.keys(t[FIELD] as object).some((k) => k.startsWith('outbox'))).toBe(false);
    expect(t.file).toBe('TASK-1');
    const b = exported.nodes.find((n) => n.id === 'b1')!;
    expect(b[FIELD]).not.toHaveProperty('state');
    expect(JSON.stringify(exported)).not.toMatch(/\/Users|\/tmp|\.md/);
  });
});

describe('dirty fields', () => {
  it('a field whose value differs from the hash the source had at the last sync is dirty; no base = nothing to compare', () => {
    const s = kanbanStore();
    addBoard(s);
    const fields = { title: 'T', status: 'To Do', labels: [], assignee: [], description: '', plan: '', notes: '', ac: [] };
    addTask(s, 'b1', { ...fields, base: hashFields(fields) }, 't1');
    expect(dirtyFields(taskField(s, 't1'))).toEqual([]);
    s.dispatch('kanban.edit', { id: 't1', patch: { title: 'T2', labels: ['x'] } });
    expect(dirtyFields(taskField(s, 't1'))).toEqual(['title', 'labels']);
    addTask(s, 'b1', { ...fields }, 't2');
    expect(dirtyFields(taskField(s, 't2'))).toEqual([]);
  });
});

describe('who is on it (C50) and links (C51)', () => {
  const seats = [{ id: 'agent:claude-task-3-48', name: 'Claude · task-3.48', color: '#d97757' }, { id: 'p1', name: 'Alex', color: '#00f' }];
  it('matches the first word of a seat name to the assignee: @ and case ignored, any of several assignees', () => {
    expect(seatOf(['@claude'], seats)?.id).toBe('agent:claude-task-3-48');
    expect(seatOf(['CLAUDE'], seats)?.id).toBe('agent:claude-task-3-48');
    expect(seatOf(['@bob', '@alex'], seats)?.id).toBe('p1');
    expect(assigneeSeated(['claude'], seats)).toBe(true);
  });
  it('no match: nobody, another name, an empty list, a seat that left', () => {
    expect(seatOf([], seats)).toBeUndefined();
    expect(seatOf(undefined, seats)).toBeUndefined();
    expect(seatOf(['@codex'], seats)).toBeUndefined();
    expect(seatOf(['@cla'], seats)).toBeUndefined(); // a prefix is not the name
    expect(seatOf(['@claude'], seats.slice(1))).toBeUndefined();
  });
  it('derives worktree, branch and notes from the id alone; read-only text; a subtask id derives too', () => {
    expect(derivedLinks('TASK-12')).toEqual([
      { label: 'Worktree', text: 'wt/<repo>/task-12' },
      { label: 'Branch', text: 'task-12-…' },
      { label: 'Notes', text: 'work/task-12' },
    ]);
    expect(derivedLinks('TASK-3.48')[0].text).toBe('wt/<repo>/task-3.48');
    expect(derivedLinks(undefined)).toEqual([]);
    expect(derivedLinks('../x')).toEqual([]);
  });
});

describe('listings for agents', () => {
  it('canvas_list shows the board node, not its many task nodes (the kanban.board view lists those)', () => {
    const s = kanbanStore();
    addBoard(s);
    for (let i = 0; i < 20; i++) addTask(s, 'b1', { title: `t${i}` });
    const listed = queryNodes(s.doc, {}, s.summaryExt, s.unlisted);
    expect(listed.map((n) => n.id)).toEqual(['b1']);
    expect(queryNodes(s.doc, {})).toHaveLength(21);
  });
});

describe('shape of the task node', () => {
  it('a task is contained in its board, hidden unless placed', () => {
    const s = kanbanStore();
    addBoard(s);
    addTask(s, 'b1', { title: 'T' }, 't1');
    expect(s.doc.parentOf('t1')).toBe('b1');
    expect(task(s.doc.get('t1')!).title).toBe('T');
  });
});
