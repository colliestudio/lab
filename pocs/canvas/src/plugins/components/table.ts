import type { App } from '../../core';
import { data, instancesOf, typeOf } from './model';
import { fieldControl, h } from './render';

// One type's instances as a spreadsheet (like a Notion database). Same data as the cards: an edit
// here is an edit there (same commands), and edits from peers show up live.

let open: (() => void) | null = null;

export function openTable(app: App, type: string) {
  open?.();
  const overlay = h('div', 'cmp-overlay');
  const box = h('div', 'cmp-sheet');
  overlay.append(box);
  document.body.append(overlay);
  let sort: { field: string; dir: 1 | -1 } | null = null;

  const draw = () => {
    const doc = app.doc;
    const t = typeOf(doc, type);
    if (!t) return close();
    let rows = instancesOf(doc, type);
    if (sort) {
      const s = sort;
      const val = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v ?? '');
      rows = rows.slice().sort((a, b) => {
        const x = val(data(a)[s.field]);
        const y = val(data(b)[s.field]);
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * s.dir;
      });
    }
    box.replaceChildren();
    const top = h('div', 'cmp-sheet-top');
    top.append(h('h2', undefined, `${t.icon ?? '▣'} ${t.name}`), h('span', 'cmp-muted', `${rows.length} cards · edits sync to the canvas`));
    const add = h('button', undefined, '+ Row');
    add.onclick = () => {
      const all = instancesOf(app.doc, type);
      const right = all.length ? Math.max(...all.map((n) => n.x + n.width)) + 40 : app.viewCenter().x;
      const y = all.length ? Math.min(...all.map((n) => n.y)) : app.viewCenter().y;
      app.dispatch('components.create', { type, x: right, y });
      requestAnimationFrame(() => box.querySelector<HTMLElement>('tbody tr:last-child .cmp-input')?.focus());
    };
    const x = h('button', 'cmp-close', '✕');
    x.title = 'Close (Esc)';
    x.onclick = close;
    top.append(add, x);
    const table = h('table', 'cmp-table');
    const head = h('tr');
    head.append(h('th'));
    for (const f of t.fields) {
      const th = h('th', undefined, f.label + (sort?.field === f.id ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''));
      th.title = `${f.kind}${f.kind === 'ref' && f.to ? ` → ${typeOf(doc, f.to)?.name ?? f.to}` : ''} · click to sort`;
      th.onclick = () => {
        sort = sort?.field === f.id ? (sort.dir === 1 ? { field: f.id, dir: -1 } : null) : { field: f.id, dir: 1 };
        draw();
      };
      head.append(th);
    }
    table.append(h('thead'));
    table.tHead!.append(head);
    const body = h('tbody');
    for (const n of rows) {
      const tr = h('tr');
      const go = h('button', 'cmp-go', '◎');
      go.title = 'Show on the canvas';
      go.onclick = () => {
        close();
        app.store.select([n.id]);
        app.view.fit(120, [n], 1.2);
      };
      const td0 = h('td');
      td0.append(go);
      tr.append(td0);
      for (const f of t.fields) {
        const td = h('td', `cmp-cell cmp-k-${f.kind}`);
        td.append(fieldControl(doc, f, data(n)[f.id], (v) => app.dispatch('components.set', { id: n.id, field: f.id, value: v }), n.id));
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);
    box.append(top, table);
  };

  // redraw on changes, but not under the user's cursor: wait until focus leaves the cell
  let pending = false;
  const off = app.store.subscribe(() => {
    if (box.contains(document.activeElement) && document.activeElement !== document.body) pending = true;
    else draw();
  });
  box.addEventListener('focusout', () =>
    setTimeout(() => {
      if (pending && !box.contains(document.activeElement)) {
        pending = false;
        draw();
      }
    }),
  );
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  function close() {
    off();
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
    open = null;
  }
  open = close;
  draw();
}

