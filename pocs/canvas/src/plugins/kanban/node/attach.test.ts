import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServeBoard } from '../../../core/serveExtra';
import { CLI_CONFIG } from '../fixtures';
import { newTaskFile } from '../markdown';
import { board, isBoard, tasksOf } from '../model';
import { kanbanStore } from '../testkit';
import { attachKanban } from './attach';
import { parseKanbanConfig, SourceRegistry } from './registry';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project() {
  const root = mkdtempSync(join(tmpdir(), 'kb-att-'));
  dirs.push(root);
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  writeFileSync(join(root, 'backlog.config.yml'), CLI_CONFIG);
  writeFileSync(join(root, 'backlog', 'tasks', 'task-1 - A.md'), newTaskFile('TASK-1', { title: 'A', status: 'To Do' }, new Date()));
  return root;
}

const SYSTEM = Symbol('system');
function serveBoard() {
  const s = kanbanStore();
  const closers: (() => void)[] = [];
  const b: ServeBoard = {
    name: 'kb',
    doc: () => s.doc,
    apply: (changes, events) => (s.apply(changes, SYSTEM), s.appendLog(events)),
    newId: () => Math.random().toString(36).slice(2, 10),
    onDocChange: (fn) => {
      const h = (tr: Y.Transaction) => tr.origin !== SYSTEM && fn();
      s.ydoc.on('afterTransaction', h);
      return () => s.ydoc.off('afterTransaction', h);
    },
    onClose: (fn) => void closers.push(fn),
    log: () => {},
  };
  return { s, b, close: () => closers.splice(0).forEach((f) => f()) };
}
const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
};

describe('attachKanban', () => {
  it('starts a sync for a kanban node of a configured name and stops it with the node', async () => {
    const reg = new SourceRegistry([{ name: 'demo', path: project() }], { pollMs: 50, debounceMs: 20 });
    const { s, b } = serveBoard();
    const stop = attachKanban(b, reg, { pushDelayMs: 10 });
    s.dispatch('kanban.addBoard', { x: 0, y: 0, source: 'demo' });
    const bn = () => s.doc.nodes.find(isBoard)!;
    await until(() => tasksOf(s.doc, bn().id).length === 1 && board(bn()).state?.live === true);
    expect(reg.get('demo')!.watching).toBe(1);
    s.apply([{ op: 'del', id: bn().id }]);
    await until(() => reg.get('demo')!.watching === 0);
    stop();
  });

  it('two nodes of one name share the adapter; closing the board releases every watcher', async () => {
    const reg = new SourceRegistry([{ name: 'demo', path: project() }], { pollMs: 50, debounceMs: 20 });
    const { s, b, close } = serveBoard();
    b.onClose(attachKanban(b, reg, { pushDelayMs: 10 }));
    s.dispatch('kanban.addBoard', { x: 0, y: 0, source: 'demo' });
    s.dispatch('kanban.addBoard', { x: 3000, y: 0, source: 'demo' });
    await until(() => reg.get('demo')!.watching === 2);
    close();
    expect(reg.get('demo')!.watching).toBe(0);
    expect(reg.get('demo')!.watchingFs).toBe(false);
  });

  it('a node whose name the serve does not have says so on the node and reads nothing', async () => {
    const reg = new SourceRegistry([{ name: 'demo', path: project() }]);
    const { s, b, close } = serveBoard();
    b.onClose(attachKanban(b, reg));
    s.dispatch('kanban.addBoard', { x: 0, y: 0, source: 'other' });
    await until(() => !!board(s.doc.nodes.find(isBoard)!).state?.error);
    expect(board(s.doc.nodes.find(isBoard)!).state!.error).toBe('this serve has no kanban folder named "other" (it has: demo)');
    expect(reg.get('demo')!.watching).toBe(0);
    close();
  });

  it('a node whose source was changed by hand is followed to its new name', async () => {
    const reg = new SourceRegistry([{ name: 'demo', path: project() }], { pollMs: 50, debounceMs: 20 });
    const { s, b, close } = serveBoard();
    b.onClose(attachKanban(b, reg, { pushDelayMs: 10 }));
    s.dispatch('kanban.addBoard', { x: 0, y: 0, source: 'demo' });
    await until(() => reg.get('demo')!.watching === 1);
    s.apply([{ op: 'set', id: s.doc.nodes.find(isBoard)!.id, key: 'x-kanban.source', value: 'gone' }]);
    await until(() => reg.get('demo')!.watching === 0);
    close();
  });
});

describe('registry config', () => {
  it('reads name=path from flags and the environment; the same folder twice is one', () => {
    const p = project();
    expect(parseKanbanConfig([`a=${p}`], `b=${p}, c=${p}`).map((c) => c.name)).toEqual(['a', 'b', 'c']);
    expect(parseKanbanConfig([`a=${p}`], `a=${p}`)).toHaveLength(1);
    expect(parseKanbanConfig([], undefined)).toEqual([]);
  });
  it('names the entry that is wrong', () => {
    const p = project();
    expect(() => parseKanbanConfig(['nofolder'])).toThrow(/--kanban "nofolder": expected name=path/);
    expect(() => parseKanbanConfig(['Bad Name=/tmp'])).toThrow(/lowercase letters/);
    expect(() => parseKanbanConfig(['../x=/tmp'])).toThrow(/lowercase letters/);
    expect(() => parseKanbanConfig(['a='])).toThrow(/path is empty/);
    expect(() => parseKanbanConfig([`a=${p}`, 'a=/tmp'])).toThrow(/used twice for different folders/);
    expect(() => parseKanbanConfig([], 'x')).toThrow(/\$CANVAS_KANBAN "x"/);
  });
  it('a path that is not a Backlog.md folder stops the start with a message, no path leaks from a missing one', () => {
    const empty = mkdtempSync(join(tmpdir(), 'kb-att-'));
    dirs.push(empty);
    expect(() => new SourceRegistry([{ name: 'x', path: empty }])).toThrow(/kanban x: .*not a Backlog\.md folder/);
    expect(() => new SourceRegistry([{ name: 'x', path: join(empty, 'nope') }])).toThrow(/kanban x/);
  });
});
