import './home.css';
import { createBoard, deleteBoard, listBoards, renameBoard, type BoardEntry } from './api';
import { emptyText, toRows } from './rows';

// The board list a canvas service shows on `/`: its own page, no board app loaded. Every action asks the
// service and then reloads the list; the list also reloads when the tab comes back and every few seconds
// while it is visible (a board opened elsewhere shows as open).

const POLL_MS = 5000;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export function mountHome(root: HTMLElement, f: typeof fetch = fetch) {
  let entries: BoardEntry[] = [];
  let loaded = false;
  let editing: string | null = null; // the row being renamed: the list leaves it alone
  let highlight: string | null = null;
  let stale = false; // a refresh arrived while editing

  root.innerHTML = '';
  root.className = 'home';
  const title = h('h1', '', 'Boards');
  const form = h('form', 'home-new');
  const input = h('input');
  input.placeholder = 'New board name';
  input.setAttribute('aria-label', 'New board name');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const add = h('button', 'home-btn primary', 'New board');
  add.type = 'submit';
  form.append(input, add);
  const formError = h('p', 'home-error');
  const banner = h('p', 'home-banner');
  banner.hidden = true;
  const table = h('table', 'home-list');
  const tbody = h('tbody');
  table.append(tbody);
  const empty = h('p', 'home-empty', emptyText);
  empty.hidden = true;
  root.append(title, form, formError, banner, table, empty);

  const say = (el: HTMLElement, msg: string) => {
    el.textContent = msg;
  };

  async function refresh() {
    try {
      entries = await listBoards(f);
      loaded = true;
      banner.hidden = true;
    } catch (e) {
      banner.hidden = false;
      say(banner, `Can’t reach the canvas service: ${(e as Error).message}`);
      return;
    }
    if (editing !== null) {
      stale = true;
      return;
    }
    render();
  }

  function render() {
    stale = false;
    tbody.textContent = '';
    const rows = toRows(entries);
    empty.hidden = !loaded || rows.length > 0;
    for (const r of rows) {
      const tr = h('tr', r.name === highlight ? 'fresh' : '');
      tr.dataset.name = r.name;
      const nameCell = h('td', 'name');
      const link = h('a', '', r.name);
      link.href = r.href;
      link.target = '_blank';
      link.rel = 'noopener';
      nameCell.append(link);
      if (r.error) nameCell.append(h('div', 'home-error', r.error));
      const mod = h('td', 'mod', r.modified);
      mod.title = r.modifiedTitle;
      const actions = h('td', 'actions');
      const ren = h('button', 'home-btn quiet', 'Rename');
      ren.type = 'button';
      const del = h('button', 'home-btn quiet', 'Delete');
      del.type = 'button';
      actions.append(ren, del);
      const rowError = h('div', 'home-error');
      nameCell.append(rowError);
      ren.addEventListener('click', () => startRename(nameCell, r.name, rowError));
      del.addEventListener('click', () => void remove(r.name, rowError));
      tr.append(nameCell, mod, h('td', 'state', r.state), actions);
      tbody.append(tr);
    }
    if (highlight) {
      const fresh = tbody.querySelector('.fresh');
      fresh?.scrollIntoView?.({ block: 'nearest' });
      const mark = highlight;
      setTimeout(() => {
        if (highlight === mark) highlight = null;
        tbody.querySelector('.fresh')?.classList.remove('fresh');
      }, 2500);
    }
  }

  function startRename(cell: HTMLElement, name: string, err: HTMLElement) {
    editing = name;
    const field = h('input', 'home-rename');
    field.value = name;
    field.setAttribute('aria-label', `New name for ${name}`);
    field.spellcheck = false;
    const link = cell.querySelector('a')!;
    link.replaceWith(field);
    field.focus();
    field.select();
    const stop = () => {
      editing = null;
      if (stale) render();
      else field.replaceWith(link);
    };
    let busy = false;
    field.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stop();
      } else if (e.key === 'Enter' && !busy) {
        e.preventDefault();
        const to = field.value.trim();
        if (to === name) return stop();
        busy = true;
        try {
          await renameBoard(name, to, f);
          editing = null;
          highlight = to;
          await refresh();
        } catch (x) {
          say(err, (x as Error).message); // the row stays as it was, the field stays for another try
        } finally {
          busy = false;
        }
      }
    });
  }

  async function remove(name: string, err: HTMLElement) {
    if (!confirm(`Move “${name}” to the trash? It goes to .canvas-bridge/trash in the boards folder.`)) return;
    try {
      await deleteBoard(name, f);
      say(err, '');
      await refresh();
    } catch (x) {
      say(err, (x as Error).message);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    say(formError, '');
    add.disabled = true;
    try {
      const made = await createBoard(name, f);
      input.value = '';
      highlight = made.name;
      await refresh();
    } catch (x) {
      say(formError, (x as Error).message);
    } finally {
      add.disabled = false;
    }
  });

  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void refresh());
  const timer = setInterval(() => document.visibilityState === 'visible' && void refresh(), POLL_MS);
  void refresh();
  input.focus();
  return { refresh, stop: () => clearInterval(timer) };
}

const root = document.getElementById('home');
if (root) mountHome(root);
