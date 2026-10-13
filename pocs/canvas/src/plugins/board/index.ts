import './board.css';
import type { App, CanvasNode, Plugin } from '../../core';
import { COL_W, NOTE_W, isColumn, isNote, registerBoardLogic, syncOf } from './logic';

export { registerBoardLogic } from './logic';

// Board: notes, columns, links and edges as plain JSON Canvas objects (what Obsidian opens).
// The same commands back the Add menu here and the agent bridge (bridge/), so a person and an
// agent edit the board the same way and show up in the log the same way.

/** JSON Canvas preset colors 1..6, or a hex color. */
const PRESET: Record<string, string> = { '1': '#fb464c', '2': '#e9973f', '3': '#e0de71', '4': '#44cf6e', '5': '#53dfdd', '6': '#a882ff' };
export const colorOf = (c?: string) => (c ? (PRESET[c] ?? c) : undefined);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Tiny markdown: "# heading" first line, **bold**, `code`, line breaks. */
export function noteHtml(text: string): string {
  const lines = esc(text).split('\n');
  return lines
    .map((l, i) => {
      const h = /^#{1,6}\s+(.*)$/.exec(l);
      const body = (h ? h[1] : l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
      return h || (i === 0 && lines.length > 1) ? `<div class="bd-title">${body}</div>` : `<div>${body || '&nbsp;'}</div>`;
    })
    .join('');
}

/** A live page in a link node (`x-embed`): sandboxed iframe, view only (pointer events go to the canvas). */
function renderEmbed(n: CanvasNode, el: HTMLElement, c: string | undefined) {
  const url = n.url!;
  let frame = el.querySelector('iframe');
  if (!frame || frame.getAttribute('src') !== url) {
    el.innerHTML = `<div class="bd-note bd-embed"><div class="bd-title">🔗 ${esc(url)}</div><iframe sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer" loading="eager"></iframe></div>`;
    frame = el.querySelector('iframe')!;
    frame.src = url;
  }
  const box = el.firstChild as HTMLElement;
  if (c) box.style.setProperty('--bd-color', c);
  else box.style.removeProperty('--bd-color');
}

function edit(app: App, n: CanvasNode) {
  if (isColumn(n)) {
    const v = prompt('Column name', n.label ?? '');
    if (v !== null) app.dispatch('board.update', { id: n.id, label: v });
    return;
  }
  if (n.type === 'link') {
    const v = prompt('Link URL', n.url ?? '');
    if (v !== null) app.dispatch('board.update', { id: n.id, url: v });
    return;
  }
  const v = prompt('Note text (first line = title; \\n for a new line)', (n.text ?? '').replace(/\n/g, '\\n'));
  if (v !== null) app.dispatch('board.update', { id: n.id, text: v.replace(/\\n/g, '\n') });
}

export const boardPlugin: Plugin = {
  id: 'board',
  setup(app) {
    registerBoardLogic(app.store);
    app.registerType({
      id: 'board.embed',
      match: (n) => n.type === 'link' && n['x-embed'] === true && /^https?:\/\//.test(n.url ?? ''),
      render: (n, el) => renderEmbed(n, el, colorOf(n.color)),
      onDoubleClick: (n, a) => edit(a, n),
    });
    app.registerType({
      id: 'board.note',
      match: isNote,
      render(n, el) {
        const c = colorOf(n.color);
        const src = syncOf(n);
        el.innerHTML =
          `<div class="bd-note${c ? ' bd-colored' : ''}">` +
          (n.type === 'link' ? `<div class="bd-title">🔗 ${esc(n.url ?? '')}</div>` : noteHtml(n.text ?? '')) +
          (src ? `<span class="bd-src" title="Synced from ${esc(src.source)}: re-sync overwrites its text">${esc(src.source)}</span>` : '') +
          `</div>`;
        if (c) (el.firstChild as HTMLElement).style.setProperty('--bd-color', c);
      },
      onDoubleClick: (n, a) => edit(a, n),
    });
    app.registerType({
      id: 'board.column',
      match: isColumn,
      render(n, el) {
        const c = colorOf(n.color);
        el.innerHTML = `<div class="bd-column"><div class="bd-col-head">${esc(n.label ?? '')}</div></div>`;
        if (c) (el.firstChild as HTMLElement).style.setProperty('--bd-color', c);
      },
      onDoubleClick: (n, a) => edit(a, n),
    });
    app.registerKit({
      id: 'board.note',
      label: 'Note',
      create: (a, at) => a.dispatch('board.add', { text: 'New note', x: at.x - NOTE_W / 2, y: at.y - 45 }),
    });
    app.registerKit({
      id: 'board.column',
      label: 'Column',
      create: (a, at) => a.dispatch('board.add', { type: 'group', label: 'Column', x: at.x - COL_W / 2, y: at.y - 200 }),
    });
    app.registerMenu((a, sel) => {
      const notes = sel.filter((n) => isNote(n) || isColumn(n));
      if (!notes.length || notes.length !== sel.length) return undefined;
      const entries = [];
      if (notes.length === 1) entries.push({ label: 'Edit…', run: () => edit(a, notes[0]) });
      if (notes.length === 2) {
        const [x, y] = notes;
        entries.push({ label: 'Link these two', run: () => a.dispatch('board.connect', { from: x.id, to: y.id }) });
        entries.push({ label: 'Unlink', run: () => {
            if (!a.dispatch('board.disconnect', { from: x.id, to: y.id }).changes.length) a.dispatch('board.disconnect', { from: y.id, to: x.id });
          },
        });
      }
      entries.push({
        label: 'Color',
        items: [['None', null], ['Red', '1'], ['Orange', '2'], ['Yellow', '3'], ['Green', '4'], ['Cyan', '5'], ['Purple', '6']].map(([label, c]) => ({
          label: label as string,
          color: colorOf((c as string) ?? undefined),
          run: () => a.store.merged(() => notes.forEach((n) => a.dispatch('board.update', { id: n.id, color: c }))),
        })),
      });
      entries.push({ label: 'Delete', run: () => a.dispatch('board.remove', { ids: notes.map((n) => n.id) }) });
      return { title: notes.length === 1 ? (isColumn(notes[0]) ? 'Column' : 'Note') : `${notes.length} objects`, entries };
    });
  },
};
