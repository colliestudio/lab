import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, makeView, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerKanbanLogic } from './logic';
import { BoardHost } from './host';
import { hashOf, nextTaskId, parseConfig, parseTask, patchTask, taskFileName, yamlScalar } from './markdown';
import { board, column, dirtyFields, isTask, task, tasksOf, FIELD } from './model';
import { FilesSource, MemFolder, type Source } from './sources';
import { layoutRule } from './layout';

const TASK1 = `---
id: TASK-1
title: Buy always-on dev box
status: Done
assignee: []
created_date: '2026-09-29 19:45'
updated_date: '2026-10-02 21:53'
labels:
  - machine
  - infra
dependencies: []
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Dedicated box.
<!-- SECTION:DESCRIPTION:END -->
`;

const TASK2 = `---
id: TASK-2
title: >-
  Set up pve1: the HP box and
  a VM
status: To Do
assignee: [alex]
created_date: '2026-09-29 19:45'
labels: []
dependencies: []
---

Body two.
`;

const TASK3 = `---
id: TASK-3
title: 'Third: quoted'
status: To Do
assignee: []
created_date: '2026-09-29 19:45'
labels:
  - re
dependencies: []
ordinal: 3000
---
`;

const CONFIG = `project_name: "demo"
default_status: "To Do"
statuses: ["To Do", "In Progress", "Done"]
labels: ["re", "infra", "machine"]
task_prefix: "task"
`;

function ctx(prefix = 'id'): CommandCtx {
  let n = 0;
  return { newId: () => `${prefix}${++n}`, random: () => 0.5 };
}
function store(ydoc?: Y.Doc, p = 'id') {
  const s = new Store({ ctx: ctx(p), ydoc });
  registerCoreCommands(s);
  registerKanbanLogic(s);
  return s;
}
function folder() {
  return new MemFolder('demo', {
    'backlog.config.yml': CONFIG,
    'backlog/tasks/task-1 - Buy-always-on-dev-box.md': TASK1,
    'backlog/tasks/task-2 - Set-up-pve1.md': TASK2,
    'backlog/tasks/task-3 - Third.md': TASK3,
    'backlog/archive/tasks/task-7 - Old.md': TASK1.replace('TASK-1', 'TASK-7'),
  });
}
const NOW = new Date(2026, 9, 11, 9, 30);
async function hosted() {
  const s = store();
  s.dispatch('kanban.create', { x: 0, y: 0 });
  const f = folder();
  const host = new BoardHost(s, 'id1', new FilesSource(f), { pollMs: 0, now: () => NOW });
  await host.cycle();
  return { s, f, host, byTask: (id: string) => tasksOf(s.doc, 'id1').find((t) => task(t).taskId === id)! };
}

describe('markdown', () => {
  it('parses Backlog.md frontmatter: lists, folded titles, quotes, ordinal', () => {
    const t1 = parseTask(TASK1)!;
    expect(t1).toMatchObject({ taskId: 'TASK-1', title: 'Buy always-on dev box', status: 'Done', labels: ['machine', 'infra'], assignee: [], ordinal: 1000 });
    expect(t1.body.startsWith('\n## Description')).toBe(true);
    const t2 = parseTask(TASK2)!;
    expect(t2).toMatchObject({ title: 'Set up pve1: the HP box and a VM', assignee: ['alex'], labels: [], ordinal: undefined });
    expect(parseTask(TASK3)!.title).toBe('Third: quoted');
    expect(parseTask('no frontmatter')).toBeNull();
  });

  it('patches only the changed lines (plus updated_date)', () => {
    const out = patchTask(TASK1, { status: 'In Progress' }, NOW);
    const diff = out.split('\n').filter((l, i) => l !== TASK1.split('\n')[i]);
    expect(diff).toEqual(['status: In Progress', "updated_date: '2026-10-11 09:30'"]);
    // labels block replaced in place; folded title becomes one line
    const t2 = patchTask(TASK2, { title: 'New: title', labels: ['re', 'biz'] });
    expect(t2).toContain("title: 'New: title'\nstatus: To Do");
    expect(t2).toContain('labels:\n  - re\n  - biz\ndependencies');
    expect(parseTask(t2)).toMatchObject({ title: 'New: title', labels: ['re', 'biz'], assignee: ['alex'] });
    // ordinal added when missing, removed when undefined
    expect(parseTask(patchTask(TASK2, { ordinal: 500 }))!.ordinal).toBe(500);
    expect(patchTask(TASK1, { ordinal: undefined })).not.toContain('ordinal');
    // body replaced, frontmatter untouched
    expect(patchTask(TASK1, { body: '\nNew body\n' }).endsWith('---\n\nNew body\n')).toBe(true);
  });

  it('quotes like js-yaml, names files and ids like Backlog.md', () => {
    expect(yamlScalar('plain words')).toBe('plain words');
    expect(yamlScalar('a: b')).toBe("'a: b'");
    expect(yamlScalar("it's #1")).toBe("'it''s #1'");
    expect(yamlScalar('2026')).toBe("'2026'");
    expect(taskFileName('TASK-12', 'Fix: the thing!')).toBe('task-12 - Fix-the-thing.md');
    expect(nextTaskId(['TASK-3', 'TASK-17.2', 'task-20 - x.md'])).toBe('TASK-21');
    expect(parseConfig(CONFIG)).toMatchObject({ name: 'demo', statuses: ['To Do', 'In Progress', 'Done'], labels: ['re', 'infra', 'machine'] });
  });
});

describe('board from a folder', () => {
  it('pulls tasks into the board as contained, laid-out file nodes', async () => {
    const { s, byTask } = await hosted();
    const b = s.doc.get('id1')!;
    expect(board(b)).toMatchObject({ name: 'demo', labels: ['re', 'infra', 'machine'] });
    expect(tasksOf(s.doc, 'id1').length).toBe(3);
    const t1 = byTask('TASK-1');
    expect(t1.type).toBe('file');
    expect(t1.file).toBe('backlog/tasks/task-1 - Buy-always-on-dev-box.md');
    expect(dirtyFields(task(t1))).toEqual([]);
    expect(s.doc.parentOf(t1.id)).toBe('id1');
    expect(s.doc.isVisible(t1.id)).toBe(true);
    expect(column(s.doc, 'id1', 'To Do').map((t) => task(t).taskId)).toEqual(['TASK-3', 'TASK-2']); // ordinal first, then id
  });

  it('a drag to another column writes status (and nothing else) back to the file', async () => {
    const { s, f, host, byTask } = await hosted();
    s.dispatch('kanban.move', { board: 'id1', ids: [byTask('TASK-1').id], status: 'In Progress', index: 0 });
    expect(task(byTask('TASK-1')).status).toBe('In Progress');
    expect(dirtyFields(task(byTask('TASK-1')))).toEqual(['status']);
    await host.cycle();
    const text = f.files.get('backlog/tasks/task-1 - Buy-always-on-dev-box.md')!;
    expect(parseTask(text)!.status).toBe('In Progress');
    expect(text.split('\n').filter((l, i) => l !== TASK1.split('\n')[i])).toEqual(['status: In Progress', "updated_date: '2026-10-11 09:30'"]);
    expect(dirtyFields(task(byTask('TASK-1')))).toEqual([]);
    expect(host.writes).toBe(1);
    // undo = another write, back to Done
    s.undo();
    await host.cycle();
    expect(parseTask(f.files.get('backlog/tasks/task-1 - Buy-always-on-dev-box.md')!)!.status).toBe('Done');
  });

  it('reorders with as few ordinal writes as possible', async () => {
    const { s, byTask } = await hosted();
    // To Do: TASK-3 (3000), TASK-2 (none). TASK-2 to the top: needs an ordinal below 3000
    s.dispatch('kanban.move', { board: 'id1', ids: [byTask('TASK-2').id], status: 'To Do', index: 0 });
    expect(column(s.doc, 'id1', 'To Do').map((t) => task(t).taskId)).toEqual(['TASK-2', 'TASK-3']);
    expect(task(byTask('TASK-2')).ordinal).toBe(1500);
    expect(task(byTask('TASK-3')).ordinal).toBe(3000);
    // TASK-1 (ordinal 1000) to the end of To Do: needs one above 3000 → only TASK-1 changes
    s.dispatch('kanban.move', { board: 'id1', ids: [byTask('TASK-1').id], status: 'To Do', index: 2 });
    expect(column(s.doc, 'id1', 'To Do').map((t) => task(t).taskId)).toEqual(['TASK-2', 'TASK-3', 'TASK-1']);
    expect(dirtyFields(task(byTask('TASK-3')))).toEqual([]);
  });

  it('outside edits (an agent, the CLI) show up on the next poll; local edits of other fields survive', async () => {
    const { s, f, host, byTask } = await hosted();
    const p = 'backlog/tasks/task-2 - Set-up-pve1.md';
    s.dispatch('kanban.edit', { id: byTask('TASK-2').id, patch: { labels: ['infra'] } });
    f.put(p, patchTask(f.files.get(p)!, { status: 'Done' }));
    await host.cycle();
    const t2 = task(byTask('TASK-2'));
    expect(t2.status).toBe('Done'); // from the file
    expect(t2.labels).toEqual(['infra']); // from the board
    expect(parseTask(f.files.get(p)!)).toMatchObject({ status: 'Done', labels: ['infra'] });
    // a file removed (archived) leaves the board; refs to it stay as "missing"
    s.dispatch('kanban.ref', { task: byTask('TASK-3').id, x: 900, y: 0 });
    f.files.delete('backlog/tasks/task-3 - Third.md');
    await host.cycle();
    expect(tasksOf(s.doc, 'id1').map((t) => task(t).taskId).sort()).toEqual(['TASK-1', 'TASK-2']);
  });

  it('a new task gets the next id past the archive and a Backlog.md file', async () => {
    const { s, f, host } = await hosted();
    s.dispatch('kanban.newTask', { board: 'id1', status: 'In Progress', title: 'Write the doc' });
    await host.cycle();
    const p = 'backlog/tasks/task-8 - Write-the-doc.md';
    expect(parseTask(f.files.get(p)!)).toMatchObject({ taskId: 'TASK-8', title: 'Write the doc', status: 'In Progress' });
    const t = tasksOf(s.doc, 'id1').find((n) => task(n).title === 'Write the doc')!;
    expect(task(t)).toMatchObject({ taskId: 'TASK-8', path: p });
    await host.cycle();
    expect(dirtyFields(task(t))).toEqual([]);
    expect(tasksOf(s.doc, 'id1').length).toBe(4);
  });

  it('refs: a linked second view of a task; dropping one on its board moves the task and removes the ref', async () => {
    const { s, byTask } = await hosted();
    const r = s.dispatch('kanban.ref', { task: byTask('TASK-3').id, x: 900, y: 0 }).select![0];
    expect(s.doc.get(r)![FIELD]).toEqual({ kind: 'ref', task: byTask('TASK-3').id });
    s.dispatch('kanban.edit', { id: r, patch: { title: 'Renamed via ref' } });
    expect(task(byTask('TASK-3')).title).toBe('Renamed via ref');
    s.dispatch('kanban.move', { board: 'id1', ids: [r], status: 'Done', index: 0 });
    expect(task(byTask('TASK-3')).status).toBe('Done');
    expect(s.doc.get(r)).toBeUndefined();
    // duplicating a task is refused (two nodes, one file)
    s.dispatch('core.duplicate', { ids: [byTask('TASK-3').id, 'id1'] });
    expect(tasksOf(s.doc, 'id1').length).toBe(3);
  });

  it('layout: columns side by side, long columns cut to the limit until expanded', async () => {
    const { s } = await hosted();
    for (let i = 0; i < 12; i++) s.dispatch('kanban.newTask', { board: 'id1', status: 'Done', title: `t${i}` });
    const shown = () => column(s.doc, 'id1', 'Done').filter((t) => s.doc.isVisible(t.id)).length;
    expect(shown()).toBe(8);
    const h = s.doc.get('id1')!.height;
    s.dispatch('kanban.expand', { id: 'id1', status: 'Done', on: true });
    expect(shown()).toBe(13);
    expect(s.doc.get('id1')!.height).toBeGreaterThan(h);
    const placed = layoutRule(makeView({ nodes: s.doc.nodes, edges: [] }, []));
    expect(placed.size).toBeGreaterThan(0);
  });

  it('multiplayer: a peer moves a card, only the host writes the file', async () => {
    const { s, f, host, byTask } = await hosted();
    const peer = store(undefined, 'p');
    Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(s.ydoc));
    peer.ydoc.on('update', (u: Uint8Array) => Y.applyUpdate(s.ydoc, u));
    const id = byTask('TASK-2').id;
    peer.dispatch('kanban.move', { board: 'id1', ids: [id], status: 'In Progress', index: 0 });
    expect(task(s.doc.get(id)!).status).toBe('In Progress');
    await host.cycle();
    expect(parseTask(f.files.get('backlog/tasks/task-2 - Set-up-pve1.md')!)!.status).toBe('In Progress');
  });
});

describe('service source contract', () => {
  it('the host loop works with any Source (fake service: reorders renumber on the server)', async () => {
    const server = new Map([
      ['TASK-1', { title: 'a', status: 'To Do', labels: [], assignee: [], ordinal: 1000, body: '' }],
      ['TASK-2', { title: 'b', status: 'To Do', labels: [], assignee: [], ordinal: 2000, body: '' }],
    ]);
    const calls: string[] = [];
    const src: Source = {
      kind: 'service',
      label: 'fake',
      async read() {
        return {
          meta: { name: 'svc', statuses: ['To Do', 'Done'] },
          tasks: [...server].map(([taskId, fields]) => ({ taskId, fields, hashes: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, hashOf(v)])) })),
        };
      },
      async write(t, dirty, c) {
        calls.push(`${t.taskId}:${dirty.join(',')}`);
        const cur = server.get(t.taskId!)!;
        for (const k of dirty) if (k !== 'ordinal') (cur as Record<string, unknown>)[k] = t.fields[k];
        if (dirty.includes('ordinal')) c.columnOrder(t.fields.status).forEach((id, i) => (server.get(id)!.ordinal = (i + 1) * 10)); // server's own numbering
        return { taskId: t.taskId! };
      },
    };
    const s = store();
    s.dispatch('kanban.create', { x: 0, y: 0 });
    const host = new BoardHost(s, 'id1', src, { pollMs: 0 });
    await host.cycle();
    const t2 = tasksOf(s.doc, 'id1').find((t) => task(t).taskId === 'TASK-2')!;
    s.dispatch('kanban.move', { board: 'id1', ids: [t2.id], status: 'To Do', index: 0 });
    await host.cycle();
    await host.cycle();
    expect(calls).toEqual(['TASK-2:ordinal']);
    // the server's numbering came back and nothing is left to write (no loop)
    expect(column(s.doc, 'id1', 'To Do').filter(isTask).map((t) => [task(t).taskId, task(t).ordinal, dirtyFields(task(t)).length])).toEqual([
      ['TASK-2', 10, 0],
      ['TASK-1', 20, 0],
    ]);
  });
});
