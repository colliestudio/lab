import type { CanvasNode, DocView } from '../../core';
import { COLUMN_LIMIT, COL_HEAD, COL_W, FOOT, HEADER, PAD, COL_GAP, board, column, columnsOf, dirtyFields, type TaskField } from './model';
import { shownCount } from './layout';

export const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** What this tab knows about a board's connection (local, not in the doc). */
export interface LocalState {
  /** This tab hosts it and the loop runs. */
  hosting: boolean;
  /** This tab is the host on record but needs a click (folder permission) to resume. */
  needsResume: boolean;
  error?: string;
  /** Can this browser pick folders (File System Access API)? */
  canPick: boolean;
  /** The dev server's folder, if it has one. */
  devFolder?: string;
  /** The dev server proxies a Backlog.md server (BACKLOG_URL set). */
  service?: boolean;
}

/** Same hue for the same label everywhere (board, refs, other peers). */
export function labelColor(label: string): string {
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 42%)`;
}

const chips = (labels: string[]) => labels.map((l) => `<span class="kb-chip" style="--c:${labelColor(l)}">${esc(l)}</span>`).join('');

export function cardHtml(t: TaskField): string {
  const dirty = dirtyFields(t).length > 0;
  const who = t.assignee?.length ? ` · ${esc(t.assignee.join(', '))}` : '';
  return (
    `<div class="kb-card${dirty ? ' kb-dirty' : ''}">` +
    `<div class="kb-meta"><span class="kb-id">${esc(t.taskId ?? 'new')}</span>${who}${dirty ? '<span class="kb-pending" title="Not written to the source yet (the host writes it)">●</span>' : ''}</div>` +
    `<div class="kb-title">${esc(t.title || 'Untitled')}</div>` +
    `<div class="kb-labels">${chips(t.labels ?? [])}</div>` +
    `</div>`
  );
}

export function refHtml(t: TaskField | undefined, boardName: string | undefined): string {
  if (!t) return `<div class="kb-card kb-ref kb-gone"><div class="kb-meta">↗ linked task</div><div class="kb-title">Task no longer on its board (archived or deleted)</div></div>`;
  return (
    `<div class="kb-card kb-ref${dirtyFields(t).length ? ' kb-dirty' : ''}">` +
    `<div class="kb-meta"><span class="kb-id">↗ ${esc(t.taskId ?? 'new')}</span> · ${esc(boardName ?? '')}<span class="kb-status">${esc(t.status)}</span></div>` +
    `<div class="kb-title">${esc(t.title || 'Untitled')}</div>` +
    `<div class="kb-labels">${chips(t.labels ?? [])}</div>` +
    `</div>`
  );
}

function sourceLine(b: CanvasNode, me: string, tab: string, s: LocalState): { text: string; buttons: string } {
  const f = board(b);
  const btn = (action: string, label: string, title = '') => `<button type="button" data-action="${action}" title="${esc(title)}">${esc(label)}</button>`;
  const connectButtons = () =>
    (s.canPick ? btn('pick', 'Open folder…', 'Pick a Backlog.md project folder (File System Access API)') : '') +
    (s.devFolder ? btn('dev', `Dev folder: ${s.devFolder}`, "The dev server's KANBAN_ROOT folder") : '') +
    (s.service
      ? btn('service', 'Backlog server', 'A running `backlog browser`, through the /backlog-api proxy')
      : btn('service', 'Backlog server (off)', 'Off: start vite with BACKLOG_URL=http://127.0.0.1:<port> of a `backlog browser` you chose'));
  if (!f.source) return { text: 'Not connected. Pick where the tasks live:', buttons: connectButtons() };
  const kind = f.source === 'files' ? 'files' : 'Backlog server';
  const where = `${kind} · ${esc(f.sourceLabel ?? '')}`;
  if (f.ownerTab === tab) {
    if (s.hosting) {
      const err = s.error ?? f.error;
      return { text: `${where} · <b>this tab is the host</b> (reads and writes) · ${err ? `<span class="kb-err">${esc(err)}</span>` : '<span class="kb-ok">live</span>'}`, buttons: btn('new', '+ Task') };
    }
    if (s.needsResume) return { text: `${where} · this tab was the host`, buttons: btn('resume', 'Reconnect folder', 'The browser needs a click to grant folder access again') + connectButtons() };
    return { text: `${where} · connecting…`, buttons: '' };
  }
  const host = f.owner === me ? 'you, in another tab' : esc(f.ownerName || 'another player');
  return { text: `${where} · host: <b>${host}</b> (your edits sync to them; they write)${f.error ? ` · <span class="kb-err">${esc(f.error)}</span>` : ''}`, buttons: btn('new', '+ Task') };
}

export function boardHtml(b: CanvasNode, doc: DocView, me: string, tab: string, s: LocalState): string {
  const f = board(b);
  const cols = columnsOf(doc, b);
  const line = sourceLine(b, me, tab, s);
  const h = b.height;
  const colH = h - HEADER - PAD;
  const colsHtml = cols
    .map((status, i) => {
      const all = column(doc, b.id, status);
      const expanded = !!f.expanded?.includes(status);
      const shown = shownCount(all.length, expanded);
      const more = all.length - shown;
      const toggle =
        more > 0
          ? `<button type="button" class="kb-more" data-action="more:${i}">+${more} more</button>`
          : expanded && all.length > COLUMN_LIMIT
          ? `<button type="button" class="kb-more" data-action="less:${i}">Show fewer</button>`
          : '';
      return (
        `<div class="kb-col" style="left:${PAD + i * (COL_W + COL_GAP)}px;top:${HEADER}px;width:${COL_W}px;height:${colH}px">` +
        `<div class="kb-col-head" style="height:${COL_HEAD}px"><span>${esc(status)}</span><span class="kb-count">${all.length}</span>` +
        `<button type="button" class="kb-add" data-action="add:${i}" title="New task in ${esc(status)}">+</button></div>` +
        `<div class="kb-col-foot" style="height:${FOOT}px">${toggle}</div>` +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="kb-board">` +
    `<div class="kb-head" style="height:${HEADER}px"><span class="kb-name">${esc(f.name)}</span>` +
    `<span class="kb-src">${line.text}</span><span class="kb-buttons">${line.buttons}</span></div>` +
    colsHtml +
    `</div>`
  );
}

export function webHtml(url: string): string {
  return (
    `<div class="kb-web">` +
    `<div class="kb-web-bar"><span>Backlog.md web UI (iframe) · ${esc(url)}</span>` +
    `<span class="kb-web-hint">Double-click to use it · <button type="button" data-action="done">Done</button></span></div>` +
    // allow-same-origin + allow-scripts on a different origin (the Backlog.md server's port) keeps it isolated from the canvas
    `<iframe src="${esc(url)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerpolicy="no-referrer"></iframe>` +
    `<div class="kb-web-shield"></div>` +
    `</div>`
  );
}
