import type { App } from '../../core';
import { board, isRef, isTask, ref, task, columnsOf } from './model';

// A task opened as a document: a side panel next to the canvas. Edits go to the doc (one undo step
// per field change); the host writes them to the source. Outside edits (an agent changing the file)
// show up here live, except in the field being typed in.

let panel: HTMLElement | null = null;
let offStore: (() => void) | null = null;

const csv = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function closeTask() {
  offStore?.();
  offStore = null;
  panel?.remove();
  panel = null;
}

export function openTask(app: App, nodeId: string) {
  closeTask();
  let n = app.node(nodeId);
  if (isRef(n)) n = app.node(ref(n).task);
  if (!isTask(n)) return;
  const id = n.id;
  const el = document.createElement('aside');
  el.className = 'kb-panel';
  el.innerHTML = `
    <div class="kb-panel-head"><span class="kb-panel-id"></span><span class="kb-panel-file"></span><button type="button" class="kb-close" title="Close (Esc)">×</button></div>
    <input class="kb-panel-title" name="title" spellcheck="false" />
    <div class="kb-panel-row"><label>Status <select name="status"></select></label></div>
    <div class="kb-panel-row"><label>Labels <input name="labels" placeholder="comma separated" /></label></div>
    <div class="kb-panel-row"><label>Assignee <input name="assignee" placeholder="comma separated" /></label></div>
    <textarea name="body" spellcheck="false"></textarea>
    <div class="kb-panel-foot"></div>`;
  document.body.append(el);
  panel = el;
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const title = q<HTMLInputElement>('[name=title]');
  const status = q<HTMLSelectElement>('[name=status]');
  const labels = q<HTMLInputElement>('[name=labels]');
  const assignee = q<HTMLInputElement>('[name=assignee]');
  const body = q<HTMLTextAreaElement>('[name=body]');
  const edit = (patch: Record<string, unknown>) => app.dispatch('kanban.edit', { id, patch });

  const fill = () => {
    const node = app.node(id);
    if (!isTask(node)) {
      q('.kb-panel-foot').textContent = 'This task left the board (archived or deleted).';
      return;
    }
    const t = task(node);
    const b = app.node(t.board);
    q('.kb-panel-id').textContent = t.taskId ?? 'new task';
    q('.kb-panel-file').textContent = t.path ?? '(no file yet)';
    const focused = document.activeElement;
    if (focused !== title) title.value = t.title;
    if (focused !== status) {
      const cols = b ? columnsOf(app.doc, b) : [t.status];
      status.innerHTML = '';
      for (const c of cols) status.add(new Option(c, c, false, c === t.status));
    }
    if (focused !== labels) labels.value = (t.labels ?? []).join(', ');
    if (focused !== assignee) assignee.value = (t.assignee ?? []).join(', ');
    if (focused !== body && body.value !== (t.body ?? '')) body.value = t.body ?? '';
    const src = b ? board(b).source : undefined;
    q('.kb-panel-foot').textContent =
      src === 'service' ? 'Body = the Description section (the Backlog.md server API edits sections, not the raw file).' : 'Body = the markdown after the frontmatter, as in the file.';
  };
  fill();
  offStore = app.store.subscribe(fill);

  title.addEventListener('change', () => edit({ title: title.value }));
  status.addEventListener('change', () => {
    // a status change from the panel = a move to the end of that column
    const t = task(app.node(id)!);
    app.dispatch('kanban.move', { board: t.board, ids: [id], status: status.value, index: 1e9 });
  });
  labels.addEventListener('change', () => edit({ labels: csv(labels.value) }));
  assignee.addEventListener('change', () => edit({ assignee: csv(assignee.value) }));
  let t: ReturnType<typeof setTimeout> | undefined;
  body.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => edit({ body: body.value }), 500);
  });
  body.addEventListener('blur', () => {
    clearTimeout(t);
    edit({ body: body.value });
  });
  q('.kb-close').addEventListener('click', closeTask);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      (document.activeElement as HTMLElement | null)?.blur();
      closeTask();
    }
  });
  title.focus();
}
