import type { CanvasNode, DocView } from '../../core';
import { COL_HEAD, HEADER, PAD, COL_GAP, FOOT, board, colWidth, columnsOf, shownIn, seatOf, type Seat, type TaskField } from './model';

// Markup for the kanban node (strings only: no DOM here, so tests run in plain Node).

export const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Same hue for the same label everywhere (board, panel, other viewers). */
export function labelColor(label: string): string {
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 42%)`;
}

/** What this page knows that the doc does not. */
export interface BoardView {
  /** The page is a board of a canvas serve (the only place the board is live). */
  served: boolean;
  /** A quick-add field is open in this column (index) with this text. */
  quick?: { col: number; text: string };
  /** Who is at the table (for the assignee dot). */
  seats: readonly Seat[];
}

const short = (id: string | undefined) => (id ?? 'new').replace(/^[A-Za-z]+-/, '');

export function ac(t: TaskField): { done: number; total: number } | undefined {
  const total = t.ac?.length ?? 0;
  return total ? { done: t.ac.filter((a) => a.done).length, total } : undefined;
}

const who = (assignee: string[], seats: readonly Seat[]) => {
  if (!assignee?.length) return '';
  const seat = seatOf(assignee, seats);
  return `<span class="kb-who${seat ? ' kb-seated' : ''}"${seat ? ` style="--c:${esc(seat.color ?? '#7c3aed')}" title="${esc(seat.name)} is at the table"` : ''}>${seat ? '<i class="kb-dot"></i>' : ''}${esc(assignee.join(', '))}</span>`;
};

/** A task card: id, title, priority, AC progress, assignee (with a dot while that assignee is seated). */
export function cardHtml(t: TaskField, seats: readonly Seat[] = []): string {
  const progress = ac(t);
  const bits =
    (t.priority ? `<span class="kb-prio kb-prio-${esc(t.priority)}">${esc(t.priority)}</span>` : '') +
    (progress ? `<span class="kb-ac${progress.done === progress.total ? ' kb-ac-done' : ''}">AC ${progress.done}/${progress.total}</span>` : '') +
    who(t.assignee, seats);
  return (
    `<div class="kb-card${t.pending ? ' kb-new' : ''}${t.note ? ' kb-conflict' : ''}"${t.note ? ` title="${esc(t.note)}"` : ''}>` +
    `<div class="kb-meta"><span class="kb-id">${esc(t.taskId ?? 'new')}</span>${t.pending ? '<span class="kb-pending" title="Being written to the task file">just now</span>' : ''}${t.note ? '<span class="kb-flag" title="The file changed this meanwhile; the file\'s value was kept">file wins</span>' : ''}</div>` +
    `<div class="kb-title">${esc(t.title || 'Untitled')}</div>` +
    (bits ? `<div class="kb-foot-row">${bits}</div>` : '') +
    `</div>`
  );
}

/** A Done task as one line. */
export function rowHtml(t: TaskField): string {
  return `<div class="kb-row" title="${esc(`${t.taskId ?? ''} ${t.title}`)}"><span class="kb-id">${esc(short(t.taskId))}</span> ${esc(t.title || 'Untitled')}</div>`;
}

/** The state chip: live, connecting, not live here, or the problem. */
export function stateChip(b: CanvasNode, v: Pick<BoardView, 'served'>): { cls: string; text: string; live: boolean } {
  const f = board(b);
  if (!v.served) return { cls: 'kb-off', text: 'not live here', live: false };
  if (f.state?.error) return { cls: 'kb-bad', text: f.state.error, live: false };
  if (f.state?.live) return { cls: 'kb-live', text: `live · ${f.source}`, live: true };
  return { cls: 'kb-off', text: 'connecting…', live: false };
}

export function filterChips(b: CanvasNode): string {
  const f = board(b).filter;
  const chip = (text: string) => `<span class="kb-chip" data-action="filter">${esc(text)}</span>`;
  return (f?.labels?.length ? chip(`label: ${f.labels.join(', ')}`) : '') + (f?.parent ? chip(`parent: ${f.parent.toLowerCase()}`) : '');
}

export function boardHtml(b: CanvasNode, doc: DocView, v: BoardView, now?: number): string {
  const f = board(b);
  const cols = columnsOf(doc, b);
  const chip = stateChip(b, v);
  const editable = chip.live;
  const colH = b.height - HEADER - PAD;
  let x = PAD;
  const colsHtml = cols
    .map((status, i) => {
      const w = colWidth(b, status);
      const left = x;
      x += w + COL_GAP;
      const { filtered, hidden } = shownIn(doc, b, status, now);
      const done = status === f.doneColumn;
      const expanded = !!f.expanded?.includes(status);
      const quick = v.quick?.col === i && editable;
      const toggle = hidden > 0 ? `<button type="button" class="kb-more" data-action="more:${i}">+${hidden} ${done ? 'older' : 'more'}</button>` : expanded && (done || filtered.length > 8) ? `<button type="button" class="kb-more" data-action="less:${i}">${done ? 'Recent only' : 'Show fewer'}</button>` : '';
      const head = quick
        ? `<textarea class="kb-quick cv-editing" rows="1" spellcheck="false" placeholder="New task in ${esc(status)}…  ↵ create  ⇧↵ create and open" aria-label="New task title" data-quick>${esc(v.quick!.text)}</textarea>`
        : `<span class="kb-col-name">${esc(status)}</span><span class="kb-count">${filtered.length}</span>${editable && !done ? `<button type="button" class="kb-add" data-action="add:${i}" title="New task in ${esc(status)}">＋</button>` : ''}`;
      return (
        `<div class="kb-col${done ? ' kb-col-done' : ''}" style="left:${left}px;top:${HEADER}px;width:${w}px;height:${colH}px">` +
        `<div class="kb-col-head" style="height:${COL_HEAD}px">${head}</div>` +
        `<div class="kb-col-foot" style="height:${FOOT}px">${toggle}</div>` +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="kb-board">` +
    `<div class="kb-head" style="height:${HEADER}px"><span class="kb-name">▦ ${esc(f.name)}</span>` +
    `<span class="kb-state ${chip.cls}" title="${esc(chip.text)}">${chip.live ? '<i class="kb-dot"></i>' : ''}${esc(chip.text)}</span>` +
    `${filterChips(b)}<span class="kb-spacer"></span>` +
    `<button type="button" class="kb-menu" data-action="menu" title="Filter and options">⋯</button></div>` +
    (v.served ? '' : `<div class="kb-note-line">Open this board through a canvas serve with a kanban folder to edit these tasks.</div>`) +
    colsHtml +
    `</div>`
  );
}

/** What the card's look depends on besides the node: the seat that matches its assignee. */
export const seatKey = (t: TaskField, seats: readonly Seat[]) => {
  const s = seatOf(t.assignee, seats);
  return s ? `${s.name}|${s.color ?? ''}` : '';
};

