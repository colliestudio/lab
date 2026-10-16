import './home.css';
import { createBoard, deleteBoard, listBoards, renameBoard, type BoardEntry } from './api';
import { boardHref } from './route';
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
  const rowErrors = new Map<string, string>(); // kept across re-renders until the next action on that row

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

  let latest = 0; // replies come back in any order: only the newest request counts
  async function refresh() {
    const seq = ++latest;
    try {
      const got = await listBoards(f);
      if (seq !== latest) return;
      entries = got;
      loaded = true;
      banner.hidden = true;
    } catch (e) {
      if (seq !== latest) return;
      banner.hidden = false;
      say(banner, `Can’t reach the canvas service: ${(e as Error).message}`);
      return;
    }
    if (editing === null) render();
  }

  function render() {
    tbody.textContent = '';
    const rows = toRows(entries);
    for (const n of [...rowErrors.keys()]) if (!rows.some((r) => r.name === n)) rowErrors.delete(n);
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
      const rowError = h('div', 'home-error', rowErrors.get(r.name) ?? '');
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

  function rowMsg(name: string, el: HTMLElement, msg: string) {
    if (msg) rowErrors.set(name, msg);
    else rowErrors.delete(name);
    say(el, msg);
  }

  function startRename(cell: HTMLElement, name: string, err: HTMLElement) {
    rowMsg(name, err, '');
    const field = h('input', 'home-rename');
    field.value = name;
    field.setAttribute('aria-label', `New name for ${name}`);
    field.spellcheck = false;
    const link = cell.querySelector('a')!;
    link.replaceWith(field);
    editing = name;
    field.focus();
    field.select();
    let done = false;
    // leaving the field any way (Esc, a click elsewhere, another action) cancels; a blur must not
    // rebuild the rows, or the click that caused it lands on a button that is gone
    const stop = () => {
      if (done) return;
      done = true;
      if (editing === name) editing = null; // not another row's open rename
      if (field.isConnected) field.replaceWith(link);
    };
    let busy = false;
    field.addEventListener('blur', () => !busy && stop());
    field.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stop();
        void refresh();
      } else if (e.key === 'Enter' && !busy) {
        e.preventDefault();
        const to = field.value.trim();
        if (to === name) return stop();
        busy = true;
        try {
          const renamed = await renameBoard(name, to, f);
          rowErrors.delete(name);
          done = true;
          if (editing === name) editing = null;
          link.textContent = renamed.name;
          link.href = boardHref(renamed.name);
          if (field.isConnected) field.replaceWith(link); // the list may hold off re-rendering for another row's field
          highlight = renamed.name;
          await refresh();
        } catch (x) {
          rowMsg(name, err, (x as Error).message); // the row stays as it was, the field stays for another try
        } finally {
          busy = false;
        }
      }
    });
  }

  async function remove(name: string, err: HTMLElement) {
    rowMsg(name, err, '');
    if (!confirm(`Move “${name}” to the trash? It goes to .canvas-bridge/trash in the boards folder.`)) return;
    try {
      await deleteBoard(name, f);
      await refresh();
    } catch (x) {
      rowMsg(name, err, (x as Error).message);
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
