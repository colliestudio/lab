import type { App } from '../../core';
import { derivedLinks, outboxOf, board, columnsOf, isTask, seatOf, task, type Seat, type TaskField } from './model';
import { PRIORITIES } from './commands';
import { commentProblem, markerProblem } from './markdown';
import { esc, labelColor } from './render';

// A task as a document: a side panel next to the canvas. Each part (title, status, labels, assignee,
// priority, description, acceptance criteria, plan, notes, comments) is edited and sent on its own:
// one `kanban.edit` per field, one undo step per change, and the serve writes just that part of the
// file. Outside edits show here live, except in a field being typed in.
//
// Overlay rules (project-canvas checklist): the panel lives on <body>, outside the table, so table
// keys and shortcuts never see its typing; a drop on it is swallowed (a dropped file must not open
// as a board); it stacks under the table controls (z 9 < 10); Esc closes only the panel.

/** Under the table's dock, zoom and log (10) and the chat and toasts (11). */
export const PANEL_Z = 9;

let panel: HTMLElement | null = null;
let offStore: (() => void) | null = null;
let offKeys: (() => void) | null = null;
let timers: ReturnType<typeof setTimeout>[] = [];

export interface PanelEnv {
  /** Is that board live (a serve is syncing it)? Off = read-only. */
  live(boardId: string): boolean;
  seats(): Seat[];
  /** The local player's name (for "Comment as …"). */
  me(): string;
}

/** What the panel shows for a task, as data (tested without a DOM). */
export interface PanelModel {
  id: string;
  parent?: string;
  title: string;
  status: string;
  statuses: string[];
  labels: string[];
  knownLabels: string[];
  assignee: string[];
  priority: string;
  priorities: string[];
  description: string;
  ac: { text: string; done: boolean }[];
  progress: string;
  plan: string;
  notes: string;
  comments: { author: string; created: string; text: string; sending?: boolean }[];
  links: { label: string; text: string }[];
  note?: string;
}

export function panelModel(t: TaskField, statuses: string[], knownLabels: string[]): PanelModel {
  const done = (t.ac ?? []).filter((a) => a.done).length;
  return {
    id: t.taskId ?? 'new task',
    parent: t.parent,
    title: t.title,
    status: t.status,
    statuses: statuses.includes(t.status) ? statuses : [...statuses, t.status],
    labels: t.labels ?? [],
    knownLabels: [...new Set([...knownLabels, ...(t.labels ?? [])])],
    assignee: t.assignee ?? [],
    priority: t.priority ?? '',
    priorities: ['', ...PRIORITIES],
    description: t.description ?? '',
    ac: (t.ac ?? []).map((a) => ({ ...a })),
    progress: (t.ac ?? []).length ? `${done}/${t.ac.length}` : '',
    plan: t.plan ?? '',
    notes: t.notes ?? '',
    comments: [
      ...(t.comments ?? []).map((c) => ({ author: c.author ?? 'someone', created: c.created ?? '', text: c.text })),
      ...outboxOf(t).map((c) => ({ author: c.author, created: '', text: c.text, sending: true })),
    ],
    links: derivedLinks(t.taskId),
    note: t.note,
  };
}

export function closeTask() {
  offStore?.();
  offStore = null;
  offKeys?.();
  offKeys = null;
  for (const t of timers) clearTimeout(t);
  timers = [];
  panel?.remove();
  panel = null;
}

export const panelOpen = () => !!panel;
export const panelTask = () => panel?.dataset.node;

const opt = (label: string, value: string) => Object.assign(document.createElement('option'), { textContent: label, value });

const html = (s: string) => {
  const t = document.createElement('template');
  t.innerHTML = s.trim();
  return t.content.firstElementChild as HTMLElement;
};

export function openTask(app: App, nodeId: string, env: PanelEnv) {
  closeTask();
  const n0 = app.node(nodeId);
  if (!isTask(n0)) return;
  const id = n0.id;
  const el = html(`
    <aside class="kb-panel" role="dialog" aria-label="Task" data-node="${esc(id)}">
      <div class="kb-p-head"><span class="kb-p-id"></span><span class="kb-p-parent"></span><span class="kb-spacer"></span><button type="button" class="kb-close" title="Close (Esc)" aria-label="Close">×</button></div>
      <input class="kb-p-title" name="title" spellcheck="false" aria-label="Title" />
      <div class="kb-p-row">
        <select name="status" aria-label="Status"></select>
        <span class="kb-p-chips" data-chips="labels"></span>
        <span class="kb-p-chips" data-chips="assignee"></span>
        <select name="priority" aria-label="Priority"></select>
      </div>
      <div class="kb-p-note" hidden></div>
      <div class="kb-p-body">
        <h4>Description</h4>
        <textarea name="description" rows="4" spellcheck="false" aria-label="Description"></textarea>
        <h4>Acceptance criteria <span class="kb-p-progress"></span></h4>
        <div class="kb-p-ac"></div>
        <input class="kb-p-add" name="ac-add" placeholder="Add a criterion…" aria-label="Add a criterion" />
        <h4>Comments</h4>
        <div class="kb-p-comments"></div>
        <textarea name="comment" rows="2" spellcheck="false" aria-label="Comment"></textarea>
        <h4>Links</h4>
        <div class="kb-p-links"></div>
        <details><summary>Implementation plan</summary><textarea name="plan" rows="5" spellcheck="false" aria-label="Plan"></textarea></details>
        <details><summary>Implementation notes</summary><textarea name="notes" rows="5" spellcheck="false" aria-label="Notes"></textarea></details>
      </div>
    </aside>`);
  el.style.zIndex = String(PANEL_Z);
  document.body.append(el);
  panel = el;
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const field = (name: string) => q<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(`[name=${name}]`);
  const cur = () => {
    const n = app.node(id);
    return isTask(n) ? task(n) : undefined;
  };
  const statuses = () => {
    const t = cur();
    const b = t && app.node(t.board);
    return b ? columnsOf(app.doc, b) : [];
  };
  const known = () => {
    const t = cur();
    const b = t && app.node(t.board);
    return b ? board(b).labels : [];
  };

  /** Fields with typing the user has not sent yet: a refresh leaves them alone. */
  const pending = new Set<string>();
  /** What the file held (the sync's base hash) when a field got the focus: if it differs at commit, the file changed it meanwhile. */
  const seen = new Map<string, string | undefined>();
  const send = (name: string, patch: Record<string, unknown>) => {
    pending.delete(name);
    const now = cur();
    if (!now) return;
    if (seen.has(name) && seen.get(name) !== now.base?.[name as 'title']) {
      seen.delete(name);
      const f = field(name);
      if (typeof now[name as 'title'] === 'string') f.value = now[name as 'title'] as string;
      app.notify(`${now.taskId ?? 'task'} ${name}: changed in the file meanwhile; kept the file's`);
      fill();
      return;
    }
    seen.delete(name);
    const text = patch[name];
    const bad = typeof text === 'string' ? markerProblem(text) : undefined;
    if (bad) return app.notify(bad);
    app.dispatch('kanban.edit', { id, patch });
  };
  const later = (name: string, patch: () => Record<string, unknown>) => {
    pending.add(name);
    const t = setTimeout(() => pending.has(name) && send(name, patch()), 500);
    timers.push(t);
  };
  const flush = (name: string, patch: () => Record<string, unknown>) => pending.has(name) && send(name, patch());

  const readOnly = () => {
    const t = cur();
    return !t || !env.live(t.board);
  };
  let shown = '';
  const fill = () => {
    const t = cur();
    if (!t) {
      closeTask();
      app.notify('That task is gone (archived or deleted in the files)');
      return;
    }
    const m = panelModel(t, statuses(), known());
    const ro = readOnly();
    const active = document.activeElement;
    const keep = (name: string) => active === field(name) || pending.has(name);
    q('.kb-p-id').textContent = m.id;
    q('.kb-p-parent').textContent = m.parent ? ` · parent ${m.parent}` : '';
    for (const name of ['title', 'description', 'plan', 'notes'] as const) {
      const input = field(name);
      const v = m[name];
      if (!keep(name) && input.value !== v) input.value = v;
      input.disabled = ro;
    }
    // selects: rebuilt when their choices change
    const status = field('status');
    if (active !== status) {
      status.replaceChildren(...m.statuses.map((s) => opt(s, s)));
      status.value = m.status;
    }
    status.disabled = ro;
    const prio = field('priority');
    if (active !== prio) {
      prio.replaceChildren(...m.priorities.map((p) => opt(p || 'no priority', p)));
      prio.value = m.priority;
    }
    prio.disabled = ro;
    // lists: rebuilt when their data changes, never while one of their inputs has the focus
    const key = JSON.stringify([m.labels, m.assignee, m.ac, m.comments, m.note, ro, env.seats().map((s) => s.name)]);
    const listFocus = active && el.contains(active) && ['ac-text', 'ac-add'].some((c) => active.classList.contains(c));
    if (key !== shown && !listFocus) {
      shown = key;
      drawChips('labels', m.labels, m.knownLabels, ro);
      drawChips('assignee', m.assignee, [], ro, env.seats());
      drawAc(m, ro);
      drawComments(m);
      q('.kb-p-progress').textContent = m.progress ? `· ${m.progress}` : '';
      q('.kb-p-links').innerHTML = m.links.map((l) => `<div><b>${esc(l.label)}</b> <code>${esc(l.text)}</code></div>`).join('');
      const note = q('.kb-p-note');
      note.hidden = !m.note;
      note.textContent = m.note ?? '';
    }
    field('ac-add').disabled = ro;
    field('comment').disabled = ro;
    field('comment').placeholder = ro ? 'Not live: comments need the serve' : `Comment as ${env.me()}…  (↵ send, ⇧↵ new line)`;
  };

  const chipInput = (kind: 'labels' | 'assignee', placeholder: string, options: string[]) => {
    const input = html(`<input class="kb-p-chip-add" placeholder="${esc(placeholder)}" ${options.length ? `list="kb-dl-${kind}-${esc(id)}"` : ''} spellcheck="false" />`) as HTMLInputElement;
    const add = () => {
      const v = input.value.trim().replace(/^(?=[a-zA-Z0-9_-]+$)(?!@)/, kind === 'assignee' ? '@' : '');
      input.value = '';
      const t = cur();
      if (!v || !t) return;
      const list = kind === 'labels' ? t.labels : t.assignee;
      if (!list.includes(v)) send(kind, { [kind]: [...list, v] });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        add();
      }
    });
    input.addEventListener('change', add);
    return input;
  };

  const drawChips = (kind: 'labels' | 'assignee', list: string[], options: string[], ro: boolean, seats: Seat[] = []) => {
    const box = q(`[data-chips=${kind}]`);
    box.replaceChildren();
    for (const item of list) {
      const seat = kind === 'assignee' ? seatOf([item], seats) : undefined;
      const chip = html(
        `<span class="kb-p-chip" ${kind === 'labels' ? `style="--c:${labelColor(item)}"` : seat ? `style="--c:${esc(seat.color ?? '#7c3aed')}"` : ''}>${seat ? '<i class="kb-dot"></i>' : ''}${esc(item)}${ro ? '' : '<button type="button" aria-label="Remove">×</button>'}</span>`,
      );
      chip.querySelector('button')?.addEventListener('click', () => {
        const t = cur();
        if (t) send(kind, { [kind]: (kind === 'labels' ? t.labels : t.assignee).filter((x) => x !== item) });
      });
      box.append(chip);
    }
    if (!ro) {
      box.append(chipInput(kind, kind === 'labels' ? '+ label' : '+ assignee', options));
      if (options.length) {
        const dl = html(`<datalist id="kb-dl-${kind}-${esc(id)}">${options.filter((o) => !list.includes(o)).map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>`);
        box.append(dl);
      }
    }
  };

  const acPatch = (mutate: (list: { text: string; done: boolean }[]) => void) => {
    const t = cur();
    if (!t) return;
    const list = (t.ac ?? []).map((a) => ({ ...a }));
    mutate(list);
    send('ac', { ac: list });
  };
  const drawAc = (m: PanelModel, ro: boolean) => {
    const box = q('.kb-p-ac');
    // keep the focus on the same control of the same row across the redraw
    const at = document.activeElement;
    const rows = [...box.children];
    const row0 = at && box.contains(at) ? rows.findIndex((r) => r.contains(at)) : -1;
    const col0 = row0 >= 0 ? [...rows[row0].querySelectorAll('input')].indexOf(at as HTMLInputElement) : -1;
    box.replaceChildren();
    m.ac.forEach((a, i) => {
      const row = html(`<div class="kb-p-ac-row"><input type="checkbox" ${a.done ? 'checked' : ''} ${ro ? 'disabled' : ''} aria-label="Done" /><input class="ac-text" value="${esc(a.text)}" ${ro ? 'disabled' : ''} spellcheck="false" aria-label="Criterion ${i + 1}" />${ro ? '' : '<button type="button" aria-label="Remove criterion">×</button>'}</div>`);
      const [check, text] = row.querySelectorAll('input');
      check.addEventListener('change', () => acPatch((l) => l[i] && (l[i].done = check.checked)));
      text.addEventListener('change', () => acPatch((l) => l[i] && text.value.trim() && (l[i].text = text.value.trim())));
      row.querySelector('button')?.addEventListener('click', () => acPatch((l) => void l.splice(i, 1)));
      box.append(row);
    });
    if (row0 >= 0 && col0 >= 0) (box.children[row0]?.querySelectorAll('input')[col0] as HTMLElement | undefined)?.focus({ preventScroll: true });
  };

  const drawComments = (m: PanelModel) => {
    const box = q('.kb-p-comments');
    box.replaceChildren(
      ...m.comments.map((c) =>
        html(`<div class="kb-p-comment${c.sending ? ' kb-sending' : ''}"><b>${esc(c.author)}</b> <span>${esc(c.created)}${c.sending ? 'sending…' : ''}</span><div>${esc(c.text).replace(/\n/g, '<br>')}</div></div>`),
      ),
    );
  };

  // --- wiring
  for (const name of ['title', 'description', 'plan', 'notes'] as const) {
    const input = field(name);
    const patch = () => ({ [name]: input.value });
    input.addEventListener('focus', () => !seen.has(name) && seen.set(name, cur()?.base?.[name]));
    input.addEventListener('input', () => later(name, patch));
    input.addEventListener('blur', () => {
      flush(name, patch);
      seen.delete(name);
    });
  }
  field('title').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') (e.target as HTMLElement).blur();
  });
  field('status').addEventListener('change', () => {
    // a status change from the panel = a move to the end of that column, like a drag
    const t = cur();
    if (t) app.dispatch('kanban.move', { board: t.board, ids: [id], status: field('status').value, index: 1e9 });
  });
  field('priority').addEventListener('change', () => send('priority', { priority: field('priority').value || null }));
  field('ac-add').addEventListener('keydown', (e) => {
    const input = field('ac-add');
    if ((e as KeyboardEvent).key !== 'Enter' || !input.value.trim()) return;
    e.preventDefault();
    const text = input.value.trim();
    input.value = '';
    acPatch((l) => void l.push({ text, done: false }));
  });
  const comment = field('comment');
  comment.addEventListener('keydown', (e) => {
    const k = e as KeyboardEvent;
    if (k.key !== 'Enter' || k.shiftKey || k.isComposing) return;
    e.preventDefault();
    const text = comment.value.trim();
    if (!text) return;
    const bad = commentProblem(text) ?? markerProblem(text);
    if (bad) return app.notify(bad);
    comment.value = '';
    app.dispatch('kanban.comment', { id, text });
  });
  q('.kb-close').addEventListener('click', closeTask);
  el.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing here is not the table's
    if (e.key === 'Escape') {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      closeTask();
    }
  });
  // a dropped file must not open as a board, and a drag over the panel must not act on the table
  for (const type of ['dragover', 'drop']) {
    el.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  // Esc closes the panel wherever the focus is (a redraw of a list can drop it onto the page)
  const onEsc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.name-overlay')) return;
    closeTask();
  };
  window.addEventListener('keydown', onEsc);
  offKeys = () => window.removeEventListener('keydown', onEsc);
  fill();
  offStore = app.store.subscribe(fill);
  field('title').focus({ preventScroll: true });
}
