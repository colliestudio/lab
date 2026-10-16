import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_CHILD, CLI_CONFIG, CLI_PLAIN, CLI_TASK } from '../fixtures';
import { newTaskFile, patchTask, taskFileName, type TaskPatch } from '../markdown';

// The oracle: what `backlog task edit` / `task create` write, compared with the patcher on a copy of
// the same files. Skipped (with the reason printed) when `backlog` is not installed. Only temp dirs.

const have = spawnSync('backlog', ['--version'], { encoding: 'utf8' }).status === 0;
if (!have) console.warn('markdown.cli.test: `backlog` is not on PATH; the CLI equivalence tests are skipped');
const suite = have ? describe : describe.skip;

const NOW = new Date();
const norm = (t: string) => t.replace(/updated_date: '[^']*'/g, "updated_date: 'T'").replace(/^created: .*$/gm, 'created: T');

function project() {
  const root = mkdtempSync(join(tmpdir(), 'kb-cli-'));
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'archive', 'tasks'), { recursive: true });
  writeFileSync(join(root, 'backlog.config.yml'), CLI_CONFIG);
  const files: Record<string, string> = {
    'task-1 - First-task.md': CLI_TASK,
    'task-1.1 - Child.md': CLI_CHILD,
    "task-2 - Plain-with-quote-1-é.md": CLI_PLAIN,
  };
  for (const [n, t] of Object.entries(files)) writeFileSync(join(root, 'backlog', 'tasks', n), t);
  return { root, file: (id: string) => join(root, 'backlog', 'tasks', readdirSync(join(root, 'backlog', 'tasks')).find((f) => f.startsWith(`${id} - `))!) };
}
const cli = (root: string, args: string[]) => execFileSync('backlog', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

interface Op {
  name: string;
  id: string;
  cli: string[][];
  patch: TaskPatch[];
}
const ac = (...a: [string, boolean][]) => a.map(([text, done]) => ({ text, done }));
const OPS: Op[] = [
  { name: 'status', id: 'task-1', cli: [['-s', 'In Progress']], patch: [{ status: 'In Progress' }] },
  { name: 'status of a file with no updated_date and sections', id: 'task-2', cli: [['-s', 'Done']], patch: [{ status: 'Done' }] },
  { name: 'title with a colon and a quote', id: 'task-1', cli: [['-t', "New: it's #2"]], patch: [{ title: "New: it's #2" }] },
  { name: 'assignee', id: 'task-1', cli: [['-a', '@claude']], patch: [{ assignee: ['@claude'] }] },
  { name: 'assignee on a file with none', id: 'task-2', cli: [['-a', '@x']], patch: [{ assignee: ['@x'] }] },
  { name: 'labels replaced', id: 'task-1', cli: [['-l', 'a,b']], patch: [{ labels: ['a', 'b'] }] },
  { name: 'labels set on a file with none', id: 'task-2', cli: [['-l', 'canvas']], patch: [{ labels: ['canvas'] }] },
  { name: 'priority replaced', id: 'task-1', cli: [['--priority', 'low']], patch: [{ priority: 'low' }] },
  { name: 'priority added before ordinal', id: 'task-2', cli: [['--priority', 'medium']], patch: [{ priority: 'medium' }] },
  { name: 'description', id: 'task-1', cli: [['-d', 'A new description\nwith two lines']], patch: [{ sections: { description: 'A new description\nwith two lines' } }] },
  { name: 'plan', id: 'task-1', cli: [['--plan', 'p2']], patch: [{ sections: { plan: 'p2' } }] },
  { name: 'notes', id: 'task-1', cli: [['--notes', 'n2\n\n- a\n- b']], patch: [{ sections: { notes: 'n2\n\n- a\n- b' } }] },
  { name: 'plan removed', id: 'task-1', cli: [['--plan', '']], patch: [{ sections: { plan: '' } }] },
  { name: 'notes removed', id: 'task-1', cli: [['--notes', '']], patch: [{ sections: { notes: '' } }] },
  { name: 'all sections added to a bare file', id: 'task-2', cli: [['-d', 'desc', '--ac', 'first', '--plan', 'p', '--notes', 'n']], patch: [{ sections: { description: 'desc', plan: 'p', notes: 'n' }, ac: ac(['first', false]) }] },
  { name: 'plan added to a bare file', id: 'task-2', cli: [['--plan', 'p']], patch: [{ sections: { plan: 'p' } }] },
  { name: 'description added to a bare file', id: 'task-2', cli: [['-d', 'dd']], patch: [{ sections: { description: 'dd' } }] },
  { name: 'check ac 1', id: 'task-1', cli: [['--check-ac', '1']], patch: [{ ac: ac(['one', true], ['two', false]) }] },
  { name: 'check both', id: 'task-1', cli: [['--check-ac', '1', '--check-ac', '2']], patch: [{ ac: ac(['one', true], ['two', true]) }] },
  { name: 'check then uncheck', id: 'task-1', cli: [['--check-ac', '2'], ['--uncheck-ac', '2']], patch: [{ ac: ac(['one', false], ['two', true]) }, { ac: ac(['one', false], ['two', false]) }] },
  { name: 'add ac', id: 'task-1', cli: [['--ac', 'three']], patch: [{ ac: ac(['one', false], ['two', false], ['three', false]) }] },
  { name: 'remove ac 1 renumbers', id: 'task-1', cli: [['--remove-ac', '1']], patch: [{ ac: ac(['two', false]) }] },
  { name: 'remove all ac', id: 'task-1', cli: [['--remove-ac', '1', '--remove-ac', '2']], patch: [{ ac: [] }] },
  { name: 'comment', id: 'task-1', cli: [['--comment', 'hello', '--comment-author', '@bob']], patch: [{ comment: { author: '@bob', text: 'hello' } }] },
  { name: 'two comments, one multi-line', id: 'task-1', cli: [['--comment', 'line1\nline2\n\nline4', '--comment-author', '@bob'], ['--comment', 'second', '--comment-author', '@amy']], patch: [{ comment: { author: '@bob', text: 'line1\nline2\n\nline4' } }, { comment: { author: '@amy', text: 'second' } }] },
  { name: 'comment on a bare file', id: 'task-2', cli: [['--comment', 'hi', '--comment-author', '@x']], patch: [{ comment: { author: '@x', text: 'hi' } }] },
  { name: 'several fields at once', id: 'task-1', cli: [['-s', 'Done', '-a', '@x', '--plan', 'p3', '--check-ac', '1']], patch: [{ status: 'Done', assignee: ['@x'], sections: { plan: 'p3' }, ac: ac(['one', true], ['two', false]) }] },
];

suite('patchTask equals `backlog task edit`', () => {
  for (const op of OPS) {
    it(op.name, () => {
      const a = project();
      const b = project();
      let text = readFileSync(a.file(op.id), 'utf8');
      for (const p of op.patch) text = patchTask(text, p, NOW);
      for (const args of op.cli) cli(b.root, ['task', 'edit', op.id.replace('task-', ''), ...args]);
      expect(norm(text)).toBe(norm(readFileSync(b.file(op.id), 'utf8')));
    });
  }

  it('an ordinal-only change is not a CLI edit: it leaves updated_date alone (the CLI has --ordinal too)', () => {
    const a = project();
    const b = project();
    const text = patchTask(readFileSync(a.file('task-1'), 'utf8'), { ordinal: 2500 }, NOW);
    cli(b.root, ['task', 'edit', '1', '--ordinal', '2500']);
    expect(norm(text)).toBe(norm(readFileSync(b.file('task-1'), 'utf8')));
  });
});

suite('newTaskFile equals `backlog task create`', () => {
  const cases: { name: string; title: string; args: string[]; make: (id: string) => string; id: string }[] = [
    { name: 'plain', title: 'Brand new', args: [], id: 'TASK-3', make: (id) => newTaskFile(id, { title: 'Brand new', status: 'To Do', ordinal: 4000 }, NOW) },
    { name: 'tricky title and fields', title: "Fix: it's [x] #3 é", args: ['-s', 'In Progress', '-l', 'canvas,ui', '-a', '@dev', '--priority', 'high', '-d', 'The desc'], id: 'TASK-3', make: (id) => newTaskFile(id, { title: "Fix: it's [x] #3 é", status: 'In Progress', labels: ['canvas', 'ui'], assignee: ['@dev'], priority: 'high', description: 'The desc', ordinal: 4000 }, NOW) },
    { name: 'subtask', title: 'Sub one', args: ['-p', '1'], id: 'TASK-1.2', make: (id) => newTaskFile(id, { title: 'Sub one', status: 'To Do', parent: 'TASK-1', ordinal: 4000 }, NOW) },
    { name: 'with ac, plan and notes', title: 'Full', args: ['--ac', 'a', '--ac', 'b', '--plan', 'pl', '--notes', 'no', '-d', 'dd'], id: 'TASK-3', make: (id) => newTaskFile(id, { title: 'Full', status: 'To Do', description: 'dd', ac: ac(['a', false], ['b', false]), plan: 'pl', notes: 'no', ordinal: 4000 }, NOW) },
    { name: 'emoji title', title: 'Party 🎉', args: [], id: 'TASK-3', make: (id) => newTaskFile(id, { title: 'Party 🎉', status: 'To Do', ordinal: 4000 }, NOW) },
    { name: 'long title', title: Array(30).fill('word').join(' '), args: [], id: 'TASK-3', make: (id) => newTaskFile(id, { title: Array(30).fill('word').join(' '), status: 'To Do', ordinal: 4000 }, NOW) },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const b = project();
      cli(b.root, ['task', 'create', c.title, ...c.args]);
      const made = readdirSync(join(b.root, 'backlog', 'tasks')).filter((f) => !['task-1 - First-task.md', 'task-1.1 - Child.md', 'task-2 - Plain-with-quote-1-é.md'].includes(f));
      expect(made).toEqual([taskFileName(c.id, c.title)]);
      const norm2 = (t: string) => t.replace(/created_date: '[^']*'/, "created_date: 'T'");
      expect(norm2(readFileSync(join(b.root, 'backlog', 'tasks', made[0]), 'utf8'))).toBe(norm2(c.make(c.id)));
    });
  }
});
