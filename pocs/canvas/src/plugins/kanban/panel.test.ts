// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../core';
import { kanbanPlugin } from './index';
import { PANEL_Z, closeTask, openTask, panelModel, panelOpen } from './panel';
import { clock, task } from './model';
import { NOW, addBoard, addTask, resetCounter, taskField } from './testkit';

const env = (live = true) => ({ live: () => live, seats: () => [{ id: 'a', name: 'Claude', color: '#d97757' }], me: () => 'Alex' });

function setup(live = true) {
  const root = document.createElement('div');
  document.body.append(root);
  const app = new App(root);
  app.player = { id: 'me', name: 'Alex', color: '#00f' };
  app.viewer = 'me';
  app.hosted = 'served';
  app.use(kanbanPlugin);
  addBoard(app.store, { labels: ['canvas', 'ui'] });
  addTask(app.store, 'b1', { title: 'Task', taskId: 'TASK-3.48', parent: 'TASK-3', assignee: ['@claude'], description: 'About', plan: 'The plan', notes: 'Notes', ac: [{ text: 'one', done: false }, { text: 'two', done: true }], comments: [{ author: '@lead', created: '2026-10-16 11:05', text: 'hi' }], labels: ['canvas'] }, 't');
  app.store.undoManager.clear();
  openTask(app, 't', env(live));
  return app;
}
const q = <T extends Element>(s: string) => document.querySelector<T>(s)!;
const type = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
  resetCounter();
  clock.now = () => NOW;
});
afterEach(() => {
  closeTask();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('panel model (C45)', () => {
  it('exposes every part separately: title, status choices, labels, assignee, priority, sections, AC with progress, comments, links', () => {
    const app = setup();
    const m = panelModel(taskField(app.store, 't'), ['To Do', 'Done'], ['canvas', 'ui']);
    expect(m).toMatchObject({ id: 'TASK-3.48', parent: 'TASK-3', title: 'Task', status: 'To Do', statuses: ['To Do', 'Done'], labels: ['canvas'], knownLabels: ['canvas', 'ui'], assignee: ['@claude'], priority: '', description: 'About', plan: 'The plan', notes: 'Notes', progress: '1/2' });
    expect(m.priorities).toEqual(['', 'high', 'medium', 'low']);
    expect(m.ac).toEqual([{ text: 'one', done: false }, { text: 'two', done: true }]);
    expect(m.comments).toEqual([{ author: '@lead', created: '2026-10-16 11:05', text: 'hi' }]);
    expect(m.links.map((l) => l.label)).toEqual(['Worktree', 'Branch', 'Notes']);
    // a status the config lacks still shows; pending comments show as sending
    const odd = panelModel({ ...taskField(app.store, 't'), status: 'Blocked', outbox: [{ key: 'k', author: '@alex', text: 'x' }] }, ['To Do'], []);
    expect(odd.statuses).toEqual(['To Do', 'Blocked']);
    expect(odd.comments.at(-1)).toMatchObject({ sending: true, text: 'x' });
  });
});

describe('editing in the panel', () => {
  it('shows every part of the task', () => {
    setup();
    expect(q<HTMLInputElement>('[name=title]').value).toBe('Task');
    expect(q<HTMLTextAreaElement>('[name=description]').value).toBe('About');
    expect(q<HTMLTextAreaElement>('[name=plan]').value).toBe('The plan');
    expect(document.querySelectorAll('.kb-p-ac-row')).toHaveLength(2);
    expect(q('.kb-p-progress').textContent).toContain('1/2');
    expect(q('.kb-p-comments').textContent).toContain('@lead');
    expect(q('.kb-p-links').textContent).toContain('work/task-3.48');
    expect(q('.kb-p-id').textContent).toBe('TASK-3.48');
    expect(q('[data-chips=assignee]').textContent).toContain('@claude');
    expect(q('[data-chips=assignee] .kb-dot')).toBeTruthy(); // Claude is seated
  });

  it('a field is sent on its own: description after a pause, one kanban.edit that touches only it (C46)', () => {
    vi.useFakeTimers();
    const app = setup();
    const edits: unknown[] = [];
    const orig = app.dispatch.bind(app);
    app.dispatch = ((name: string, args: unknown, o?: never) => (name === 'kanban.edit' && edits.push(args), orig(name, args, o))) as never;
    type(q('[name=description]'), 'Rewritten');
    expect(edits).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(edits).toEqual([{ id: 't', patch: { description: 'Rewritten' } }]);
    expect(taskField(app.store, 't').description).toBe('Rewritten');
    expect(taskField(app.store, 't').plan).toBe('The plan');
  });

  it('leaving the field sends at once; Enter in the title leaves it', () => {
    const app = setup();
    const title = q<HTMLInputElement>('[name=title]');
    type(title, 'New title');
    title.dispatchEvent(new Event('blur'));
    expect(taskField(app.store, 't').title).toBe('New title');
  });

  it('ticking a criterion sends the whole list with that one flipped; add and remove too (C47)', () => {
    const app = setup();
    const boxes = document.querySelectorAll<HTMLInputElement>('.kb-p-ac-row input[type=checkbox]');
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
    expect(taskField(app.store, 't').ac).toEqual([{ text: 'one', done: true }, { text: 'two', done: true }]);
    const add = q<HTMLInputElement>('[name=ac-add]');
    add.value = 'three';
    add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(taskField(app.store, 't').ac.map((a) => a.text)).toEqual(['one', 'two', 'three']);
    q<HTMLButtonElement>('.kb-p-ac-row button').click();
    expect(taskField(app.store, 't').ac.map((a) => a.text)).toEqual(['two', 'three']);
    expect(q('.kb-p-progress').textContent).toContain('1/2');
  });

  it('labels and assignee: add with Enter (an assignee gets its @), remove with ×; priority and status selects', () => {
    const app = setup();
    const add = q<HTMLInputElement>('[data-chips=labels] input');
    add.value = 'ui';
    add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(taskField(app.store, 't').labels).toEqual(['canvas', 'ui']);
    const who = q<HTMLInputElement>('[data-chips=assignee] input');
    who.value = 'alex';
    who.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(taskField(app.store, 't').assignee).toEqual(['@claude', '@alex']);
    q<HTMLButtonElement>('[data-chips=labels] .kb-p-chip button').click();
    expect(taskField(app.store, 't').labels).toEqual(['ui']);
    const prio = q<HTMLSelectElement>('[name=priority]');
    prio.value = 'high';
    prio.dispatchEvent(new Event('change'));
    expect(taskField(app.store, 't').priority).toBe('high');
    const st = q<HTMLSelectElement>('[name=status]');
    st.value = 'Done';
    st.dispatchEvent(new Event('change'));
    expect(taskField(app.store, 't').status).toBe('Done');
  });

  it('a comment is queued for the serve with the typed text; Shift+Enter is a new line', () => {
    const app = setup();
    const box = q<HTMLTextAreaElement>('[name=comment]');
    expect(box.placeholder).toContain('Comment as Alex');
    box.value = 'ship it';
    const ev = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    box.dispatchEvent(ev);
    expect(taskField(app.store, 't').outbox).toBeUndefined();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(taskField(app.store, 't').outbox?.[0]).toMatchObject({ text: 'ship it' });
    expect(q('.kb-p-comments').textContent).toContain('sending');
  });

  it('an outside change refreshes the fields, but not the one being typed in (C42)', () => {
    const app = setup();
    const desc = q<HTMLTextAreaElement>('[name=description]');
    desc.focus();
    type(desc, 'my unsent text');
    app.store.apply([
      { op: 'set', id: 't', key: 'x-kanban.description', value: 'from the file' },
      { op: 'set', id: 't', key: 'x-kanban.title', value: 'Title from the file' },
      { op: 'set', id: 't', key: 'x-kanban.ac', value: [{ text: 'one', done: true }, { text: 'two', done: true }] },
    ]);
    expect(q<HTMLInputElement>('[name=title]').value).toBe('Title from the file');
    expect(desc.value).toBe('my unsent text');
    expect(q('.kb-p-progress').textContent).toContain('2/2');
  });

  it('a task that vanishes closes the panel with a notice (C59)', () => {
    const app = setup();
    const told: string[] = [];
    app.onNotify((m) => told.push(m));
    app.store.apply([{ op: 'del', id: 't' }]);
    expect(panelOpen()).toBe(false);
    expect(told.join()).toMatch(/gone/);
  });

  it('not live: every field is disabled and says why', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const app = new App(root);
    app.use(kanbanPlugin);
    addBoard(app.store);
    addTask(app.store, 'b1', { title: 'T' }, 't');
    openTask(app, 't', env(false));
    for (const s of ['[name=title]', '[name=description]', '[name=status]', '[name=ac-add]', '[name=comment]']) expect(q<HTMLInputElement>(s).disabled, s).toBe(true);
    expect(q<HTMLTextAreaElement>('[name=comment]').placeholder).toMatch(/Not live/);
    expect(task(app.node('t')!).title).toBe('T');
  });
});

describe('overlay rules (C58)', () => {
  it('typing does not reach the table; Esc closes only the panel; a drop on it is swallowed; it stacks under the controls', () => {
    setup();
    const seen: string[] = [];
    window.addEventListener('keydown', (e) => seen.push(e.key));
    window.addEventListener('drop', () => seen.push('drop'));
    q('[name=description]').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(seen).toEqual([]);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    q('.kb-panel').dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
    q('[name=description]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panelOpen()).toBe(false);
    expect(seen).toEqual([]);
  });

  it('stacks under the dock, zoom and log (z 10) and the chat and toasts (11)', () => {
    setup();
    expect(PANEL_Z).toBeLessThan(10);
    expect(q<HTMLElement>('.kb-panel').style.zIndex).toBe(String(PANEL_Z));
  });
});
