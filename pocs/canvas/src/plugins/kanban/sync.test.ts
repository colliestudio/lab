import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Store } from '../../core';
import { FIELDS } from './markdown';
import { board, clock, outboxOf, column, dirtyFields, tasksOf, task } from './model';
import { MemSource, SourceError, type Card, type CardPatch } from './source';
import { KanbanSync, TRACKER_ACTOR, patchFor, type SyncHost } from './sync';
import { NOW, addBoard, kanbanStore, resetCounter, stampDaysAgo, taskField } from './testkit';
import { BOARD } from './testkit';
import { FIELD } from './model';

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

beforeEach(() => {
  resetCounter();
  clock.now = () => NOW;
});

const SYS = Symbol('system');
function hostOf(s: Store): SyncHost {
  let n = 0;
  return {
    doc: () => s.doc,
    apply: (changes, events) => {
      s.apply(changes, SYS);
      s.appendLog(events);
    },
    newId: () => `s${++n}`,
    onDocChange: (fn) => {
      const h = (tr: Y.Transaction) => tr.origin !== SYS && fn();
      s.ydoc.on('afterTransaction', h);
      return () => s.ydoc.off('afterTransaction', h);
    },
  };
}

const cards = (): Card[] => [
  MemSource.card('TASK-1', { title: 'One', order: 1000, labels: ['canvas'], sections: { description: 'about one' }, checklist: [{ text: 'a', done: false }, { text: 'b', done: true }], created: stampDaysAgo(20), updated: stampDaysAgo(1) }),
  MemSource.card('TASK-2', { title: 'Two', order: 2000, priority: 'high', assignee: ['@claude'], created: stampDaysAgo(3) }),
  MemSource.card('TASK-3', { title: 'Three', order: 3000, column: 'In Progress' }),
  MemSource.card('TASK-4', { title: 'Old done', column: 'Done', updated: stampDaysAgo(40), created: stampDaysAgo(50) }),
];

async function setup(over: { cards?: Card[]; info?: Parameters<typeof MemSource.info>[1] } = {}) {
  const s = kanbanStore();
  s.apply([{ op: 'add', node: { id: 'b1', type: 'group', label: 'x', x: 0, y: 0, width: 800, height: 400, z: 1, [FIELD]: { ...BOARD, state: undefined, columns: [], name: 'x' } } }]);
  s.undoManager.clear();
  const source = new MemSource(MemSource.info(undefined, over.info), over.cards ?? cards());
  const sync = new KanbanSync(hostOf(s), 'b1', source, { pushDelayMs: 0, now: () => new Date(NOW) });
  await sync.cycle();
  const byId = (id: string) => tasksOf(s.doc, 'b1').find((t) => task(t).taskId === id)!;
  const events = () => s.log.toArray();
  return { s, source, sync, byId, events };
}

describe('first read', () => {
  it('fills the board node and a contained task node per card, with the base the source had; the log stays quiet', async () => {
    const { s, byId, events } = await setup();
    expect(board(s.doc.get('b1')!)).toMatchObject({ name: 'mem', columns: ['To Do', 'In Progress', 'Done'], defaultColumn: 'To Do', doneColumn: 'Done', state: { live: true }, nextId: 'TASK-5' });
    expect(s.doc.get('b1')!.label).toBe('mem');
    expect(tasksOf(s.doc, 'b1')).toHaveLength(4);
    const t1 = taskField(s, byId('TASK-1').id);
    expect(t1).toMatchObject({ title: 'One', status: 'To Do', ordinal: 1000, labels: ['canvas'], description: 'about one', ac: [{ text: 'a', done: false }, { text: 'b', done: true }] });
    expect(dirtyFields(t1)).toEqual([]);
    expect(byId('TASK-1').file).toBe('TASK-1');
    expect(s.doc.parentOf(byId('TASK-1').id)).toBe('b1');
    expect(column(s.doc, 'b1', 'To Do').map((t) => task(t).taskId)).toEqual(['TASK-1', 'TASK-2']);
    expect(events()).toEqual([]);
  });

  it('a node reopened from a board file (no base) takes the source values without a notice', async () => {
    const s = kanbanStore();
    addBoard(s, { state: undefined });
    s.apply([{ op: 'add', node: { id: 'old', type: 'file', file: 'TASK-1', x: 0, y: 0, width: 232, height: 74, [FIELD]: { kind: 'task', board: 'b1', taskId: 'TASK-1', title: 'Stale title', status: 'Done', labels: [], assignee: [], description: '', plan: '', notes: '', ac: [], comments: [] } } }]);
    const sync = new KanbanSync(hostOf(s), 'b1', new MemSource(MemSource.info(), cards()), { pushDelayMs: 0 });
    await sync.cycle();
    expect(taskField(s, 'old')).toMatchObject({ title: 'One', status: 'To Do' });
    expect(tasksOf(s.doc, 'b1')).toHaveLength(4);
    expect(s.log.toArray()).toEqual([]);
  });
});

describe('board edits go to the source (C13, C19, C35)', () => {
  it('a move writes status and order only; the sync then idles: ten more cycles write nothing', async () => {
    const { s, source, sync, byId } = await setup();
    s.dispatch('kanban.move', { board: 'b1', ids: [byId('TASK-1').id], status: 'In Progress', index: 0 });
    expect(dirtyFields(taskField(s, byId('TASK-1').id))).toEqual(['status']);
    await sync.cycle();
    expect(source.writes).toBe(1);
    expect((await source.read('TASK-1'))!.column).toBe('In Progress');
    expect(dirtyFields(taskField(s, byId('TASK-1').id))).toEqual([]);
    for (let i = 0; i < 10; i++) await sync.cycle();
    expect(source.writes).toBe(1);
    expect(s.log.toArray().filter((e) => e.type === 'kanban.file')).toEqual([]); // our own write is no outside edit
  });

  it('writes each dirty field of a task as one patch, with its stored form coming back', async () => {
    const { s, source, sync, byId } = await setup();
    const calls: CardPatch[] = [];
    const w = source.write.bind(source);
    source.write = async (id, p, o) => (calls.push(p), w(id, p, o));
    s.dispatch('kanban.edit', { id: byId('TASK-2').id, patch: { title: 'Two!', labels: ['x'], plan: 'p', ac: [{ text: 'n', done: false }] } });
    await sync.cycle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ title: 'Two!', labels: ['x'], checklist: [{ text: 'n', done: false }], sections: { plan: 'p' } });
    expect(await source.read('TASK-2')).toMatchObject({ title: 'Two!', labels: ['x'], sections: { plan: 'p' } });
    expect(taskField(s, byId('TASK-2').id).updated).toBeTruthy();
  });

  it('a value the tracker stores differently replaces the board\'s, and nothing loops', async () => {
    const { s, source, sync, byId } = await setup();
    const w = source.write.bind(source);
    source.write = async (id, p, o) => w(id, p.title ? { ...p, title: p.title.replace(/\s+/g, ' ').trim() } : p, o);
    s.dispatch('kanban.edit', { id: byId('TASK-2').id, patch: { title: 'A title' } });
    s.apply([{ op: 'set', id: byId('TASK-2').id, key: 'x-kanban.title', value: 'A   title ' }]); // as a viewer could have typed
    await sync.cycle();
    expect(taskField(s, byId('TASK-2').id).title).toBe('A title');
    const writes = source.writes;
    for (let i = 0; i < 5; i++) await sync.cycle();
    expect(source.writes).toBe(writes);
  });

  it('undo of a move writes the old status back; it is per viewer, a file edit of another field survives', async () => {
    const { s, source, sync, byId } = await setup();
    const id = byId('TASK-1').id;
    s.dispatch('kanban.move', { board: 'b1', ids: [id], status: 'Done', index: 0 });
    await sync.cycle();
    expect((await source.read('TASK-1'))!.column).toBe('Done');
    source.outside('TASK-1', { labels: ['changed-outside'] });
    s.undo();
    await sync.cycle();
    expect(await source.read('TASK-1')).toMatchObject({ column: 'To Do', labels: ['changed-outside'] });
  });

  it('a task edit of a task the file lost in between does nothing harmful', async () => {
    const { s, source, sync, byId } = await setup();
    const id = byId('TASK-2').id;
    s.dispatch('kanban.edit', { id, patch: { title: 'edited' } });
    source.outsideRemove('TASK-2');
    await sync.cycle();
    expect(s.doc.get(id)).toBeUndefined();
    expect(source.writes).toBe(0);
  });
});

describe('outside edits (C32, C33, C35, C36)', () => {
  it('show on the board, log once as the tracker, and are not written back', async () => {
    const { s, source, sync, byId, events } = await setup();
    source.outside('TASK-2', { column: 'Done' });
    await sync.cycle();
    expect(taskField(s, byId('TASK-2').id).status).toBe('Done');
    const logged = events().filter((e) => e.type === 'kanban.file');
    expect(logged.map((e) => e.text)).toEqual(['moved TASK-2 to Done']);
    expect(logged[0].actor).toMatchObject({ name: TRACKER_ACTOR.name });
    expect(source.writes).toBe(0);
    await sync.cycle();
    expect(events().filter((e) => e.type === 'kanban.file')).toHaveLength(1);
  });

  it('new, removed and re-ordered cards; a status the config lacks lands in an extra column', async () => {
    const { s, source, sync, byId } = await setup();
    source.outsideAdd(MemSource.card('TASK-9', { title: 'Brand new', order: 500 }));
    source.outside('TASK-1', { order: 9000 });
    source.outsideRemove('TASK-3');
    await sync.cycle();
    expect(column(s.doc, 'b1', 'To Do').map((t) => task(t).taskId)).toEqual(['TASK-9', 'TASK-2', 'TASK-1']);
    expect(tasksOf(s.doc, 'b1').map((t) => task(t).taskId).sort()).toEqual(['TASK-1', 'TASK-2', 'TASK-4', 'TASK-9']);
    expect(s.log.toArray().map((e) => e.text)).toEqual(expect.arrayContaining(['added TASK-9 "Brand new" (To Do)', 'removed TASK-3 (archived or deleted in the files)']));
    source.outside('TASK-2', { labels: ['x'] });
    (source.info as { columns: string[] }).columns = ['To Do', 'Done']; // the config lost "In Progress"
    source.outsideAdd(MemSource.card('TASK-10', { title: 'Odd', column: 'Done' }));
    await sync.cycle();
    expect(board(s.doc.get('b1')!).columns).toEqual(['To Do', 'Done']);
    void byId;
  });

  it('a burst of changes in the log is one line plus a count', async () => {
    const { source, sync, events } = await setup();
    for (let i = 10; i < 30; i++) source.outsideAdd(MemSource.card(`TASK-${i}`, { title: `n${i}` }));
    await sync.cycle();
    const lines = events().filter((e) => e.type === 'kanban.file');
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.at(-1)!.text).toMatch(/and \d+ more/);
  });

  it('conflict: the board edit lost to a different file value: the file wins, one notice, a note on the card, nothing written', async () => {
    const { s, source, sync, byId, events } = await setup();
    const id = byId('TASK-2').id;
    s.dispatch('kanban.edit', { id, patch: { title: 'Mine' } }); // not written yet
    source.outside('TASK-2', { title: 'Theirs' });
    await sync.cycle();
    expect(taskField(s, id).title).toBe('Theirs');
    expect((await source.read('TASK-2'))!.title).toBe('Theirs');
    expect(source.writes).toBe(0);
    const c = events().filter((e) => e.type === 'kanban.conflict');
    expect(c).toHaveLength(1);
    expect(c[0].text).toBe("TASK-2 title: changed in the file meanwhile; kept the file's");
    expect(taskField(s, id).note).toMatch(/kept the file/);
    expect(dirtyFields(taskField(s, id))).toEqual([]);
  });

  it('same field, same value: no notice; different fields: both apply', async () => {
    const { s, source, sync, byId, events } = await setup();
    const id = byId('TASK-2').id;
    s.dispatch('kanban.edit', { id, patch: { title: 'Same' } });
    source.outside('TASK-2', { title: 'Same' });
    await sync.cycle();
    expect(events().filter((e) => e.type === 'kanban.conflict')).toEqual([]);
    expect(taskField(s, id).title).toBe('Same');
    s.dispatch('kanban.edit', { id, patch: { labels: ['mine'] } });
    source.outside('TASK-2', { column: 'Done' });
    await sync.cycle();
    expect(events().filter((e) => e.type === 'kanban.conflict')).toEqual([]);
    expect(await source.read('TASK-2')).toMatchObject({ labels: ['mine'], column: 'Done' });
    expect(taskField(s, id)).toMatchObject({ labels: ['mine'], status: 'Done' });
  });

  it('the AC list is one field: a viewer ticking #2 while the file ticks #1 loses to the file', async () => {
    const { s, source, sync, byId, events } = await setup();
    const id = byId('TASK-1').id;
    s.dispatch('kanban.edit', { id, patch: { ac: [{ text: 'a', done: false }, { text: 'b', done: true }, { text: 'viewer', done: false }] } });
    source.outside('TASK-1', { checklist: [{ text: 'a', done: true }, { text: 'b', done: true }] });
    await sync.cycle();
    expect(taskField(s, id).ac).toEqual([{ text: 'a', done: true }, { text: 'b', done: true }]);
    expect(events().some((e) => e.type === 'kanban.conflict' && /ac/.test(e.text))).toBe(true);
  });

  it('a source that cannot be read keeps every card and shows the problem; it clears when the source is back', async () => {
    const { s, source, sync } = await setup();
    const list = source.list.bind(source);
    source.list = async () => {
      throw new SourceError('io', 'the tasks folder is missing');
    };
    await sync.cycle();
    expect(board(s.doc.get('b1')!).state).toEqual({ error: 'the tasks folder is missing' });
    expect(tasksOf(s.doc, 'b1')).toHaveLength(4);
    await sync.cycle();
    source.list = list;
    await sync.cycle();
    expect(board(s.doc.get('b1')!).state).toEqual({ live: true });
  });
});

describe('write failures (C21)', () => {
  it('the card goes back to the file state, everyone is told, and nothing is retried', async () => {
    const { s, source, sync, byId, events } = await setup();
    const id = byId('TASK-2').id;
    s.dispatch('kanban.move', { board: 'b1', ids: [id], status: 'Done', index: 0 });
    source.failNext = 'could not write TASK-2: the file is read-only';
    await sync.cycle();
    expect(taskField(s, id).status).toBe('To Do');
    expect(dirtyFields(taskField(s, id))).toEqual([]);
    const e = events().filter((x) => x.type === 'kanban.error');
    expect(e.map((x) => x.text)).toEqual(['could not write TASK-2: the file is read-only']);
    const w = source.writes;
    await sync.cycle();
    expect(source.writes).toBe(w);
    // other cards still work
    s.dispatch('kanban.move', { board: 'b1', ids: [byId('TASK-1').id], status: 'Done', index: 0 });
    await sync.cycle();
    expect((await source.read('TASK-1'))!.column).toBe('Done');
  });
});

describe('new tasks (C16, C17)', () => {
  it('a task made on the board is created with its provisional id; nothing is written twice', async () => {
    const { s, source, sync } = await setup();
    const r = s.dispatch('kanban.create', { board: 'b1', titles: ['first new', 'second new'], status: 'In Progress' });
    await sync.cycle();
    expect(source.writes).toBe(2);
    expect((await source.list()).cards.filter((c) => c.title.endsWith('new')).map((c) => [c.id, c.column])).toEqual([['TASK-5', 'In Progress'], ['TASK-6', 'In Progress']]);
    expect(r.select!.map((id) => taskField(s, id).taskId)).toEqual(['TASK-5', 'TASK-6']);
    expect(taskField(s, r.select![0]).pending).toBeUndefined();
    expect(dirtyFields(taskField(s, r.select![0]))).toEqual([]);
    await sync.cycle();
    expect(source.writes).toBe(2);
  });

  it('two viewers creating at once: the loser gets a fresh id and a log line, never two files with one id', async () => {
    const { s, source, sync } = await setup();
    // two browsers each guessed TASK-5
    const a = s.dispatch('kanban.create', { board: 'b1', titles: ['from A'] }).select![0];
    const b = s.dispatch('kanban.create', { board: 'b1', titles: ['from B'] }).select![0];
    s.apply([{ op: 'set', id: b, key: 'x-kanban.taskId', value: 'TASK-5' }, { op: 'set', id: b, key: 'file', value: 'TASK-5' }]); // the other browser guessed the same
    expect([taskField(s, a).taskId, taskField(s, b).taskId]).toEqual(['TASK-5', 'TASK-5']);
    await sync.cycle();
    const ids = [taskField(s, a).taskId, taskField(s, b).taskId];
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(['TASK-5', 'TASK-6']);
    expect(s.doc.get(b)!.file).toBe('TASK-6');
    expect(s.log.toArray().some((e) => e.text.includes('was taken meanwhile'))).toBe(true);
    expect((await source.list()).cards.map((c) => c.id).sort()).toEqual(['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5', 'TASK-6']);
  });

  it('a create that fails removes the card and says why', async () => {
    const { s, source, sync, events } = await setup();
    const id = s.dispatch('kanban.create', { board: 'b1', titles: ['doomed'] }).select![0];
    source.failNext = 'could not create the task: the file is read-only';
    await sync.cycle();
    expect(s.doc.get(id)).toBeUndefined();
    expect(events().at(-1)!.text).toBe('could not add "doomed": could not create the task: the file is read-only');
  });

  it('text typed meanwhile survives the create as a local edit', async () => {
    const { s, source, sync } = await setup();
    const id = s.dispatch('kanban.create', { board: 'b1', titles: ['fresh'] }).select![0];
    const c = source.create.bind(source);
    source.create = async (n, o) => {
      const card = await c(n, o);
      s.apply([{ op: 'set', id, key: 'x-kanban.title', value: 'fresh, retitled while writing' }]); // the user kept typing
      return card;
    };
    await sync.cycle();
    expect(taskField(s, id).title).toBe('fresh, retitled while writing');
    await sync.cycle();
    expect((await source.read('TASK-5'))!.title).toBe('fresh, retitled while writing');
  });
});

describe('comments', () => {
  it('a queued comment is written, then leaves the outbox; a failed one leaves it too, with a notice', async () => {
    const { s, source, sync, byId, events } = await setup();
    const id = byId('TASK-1').id;
    s.dispatch('kanban.comment', { id, text: 'first' });
    s.dispatch('kanban.comment', { id, text: 'second' });
    await sync.cycle();
    expect((await source.read('TASK-1'))!.comments.map((c) => c.text)).toEqual(['first', 'second']);
    expect(outboxOf(taskField(s, id))).toEqual([]);
    expect(taskField(s, id).comments.map((c) => c.text)).toEqual(['first', 'second']);
    s.dispatch('kanban.comment', { id, text: 'third' });
    source.failNext = 'cannot write';
    await sync.cycle();
    expect(outboxOf(taskField(s, id))).toEqual([]);
    expect(events().some((e) => e.type === 'kanban.error' && /comment/.test(e.text))).toBe(true);
  });
});

describe('a deleted card (Delete key, core.delete)', () => {
  it('comes back from the file on the next cycle; the task itself is untouched', async () => {
    const s = kanbanStore();
    addBoard(s, { state: undefined });
    const source = new MemSource(MemSource.info(), cards());
    const sync = new KanbanSync(hostOf(s), 'b1', source, { pushDelayMs: 5 }).start();
    await sync.idle();
    const t = tasksOf(s.doc, 'b1').find((x) => task(x).taskId === 'TASK-2')!;
    s.dispatch('core.delete', { ids: [t.id] });
    expect(tasksOf(s.doc, 'b1').some((x) => task(x).taskId === 'TASK-2')).toBe(false);
    await until(() => tasksOf(s.doc, 'b1').some((x) => task(x).taskId === 'TASK-2'));
    expect(await source.read('TASK-2')).toBeTruthy();
    expect(source.writes).toBe(0);
    sync.stop();
  });
});

describe('lifecycle', () => {
  it('start follows the watcher and the doc; stop releases both and writes nothing more', async () => {
    const s = kanbanStore();
    addBoard(s, { state: undefined });
    const source = new MemSource(MemSource.info(), cards());
    const sync = new KanbanSync(hostOf(s), 'b1', source, { pushDelayMs: 5 }).start();
    await sync.idle();
    expect(source.watching).toBe(1);
    const t = tasksOf(s.doc, 'b1').find((x) => task(x).taskId === 'TASK-1')!;
    s.dispatch('kanban.move', { board: 'b1', ids: [t.id], status: 'Done', index: 0 });
    await new Promise((r) => setTimeout(r, 60));
    await sync.idle();
    expect((await source.read('TASK-1'))!.column).toBe('Done');
    source.outside('TASK-2', { column: 'Done' }); // the watcher fires a cycle
    await new Promise((r) => setTimeout(r, 20));
    await sync.idle();
    expect(task(tasksOf(s.doc, 'b1').find((x) => task(x).taskId === 'TASK-2')!).status).toBe('Done');
    sync.stop();
    expect(source.watching).toBe(0);
    s.dispatch('kanban.move', { board: 'b1', ids: [t.id], status: 'To Do', index: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(source.writes).toBe(1);
  });

  it('stops itself when its board node is deleted', async () => {
    const { s, sync } = await setup();
    s.apply([{ op: 'del', id: 'b1' }]);
    await sync.cycle();
    expect((sync as unknown as { stopped: boolean }).stopped).toBe(true);
  });
});

describe('patchFor', () => {
  it('names the fields of the patch from the dirty list', () => {
    const t = { title: 'T', status: 'Done', ordinal: undefined, labels: ['a'], assignee: [], priority: undefined, description: 'd', plan: '', notes: 'n', ac: [] } as never;
    expect(patchFor(t, [...FIELDS])).toEqual({ title: 'T', column: 'Done', order: null, labels: ['a'], assignee: [], priority: null, sections: { description: 'd', plan: '', notes: 'n' }, checklist: [] });
    expect(patchFor(t, ['status'])).toEqual({ column: 'Done' });
  });
});
