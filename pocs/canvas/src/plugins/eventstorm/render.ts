import { fmt } from '../clock/model';
import { KINDS, LANE_H, HEAD, PHASES, PHASE_INFO, ROW, offered, phaseOf, lanesOf, board, sticky, kindOf, votesOf, timerLeft, type Phase } from './model';
import type { CanvasNode } from '../../core';

// Boards and stickies drawn from data. No assets.

export const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function boardHtml(b: CanvasNode, o: { dotsLeft: number; now: number }): string {
  const f = board(b);
  const ph = phaseOf(b);
  const lanes = lanesOf(b);
  const t = f.timer;
  const running = typeof t.since === 'number';
  const pills = PHASES.map(
    (p: Phase) => `<button class="es-phase${p === ph ? ' es-on' : ''}" data-action="phase:${p}" title="${esc(PHASE_INFO[p].hint)}">${esc(PHASE_INFO[p].name)}</button>`,
  ).join('');
  const palette = offered(ph)
    .map((k) => `<button class="es-chip" data-action="add:${k}" style="--es:${KINDS[k].color}" title="New ${esc(KINDS[k].name.toLowerCase())} (${KINDS[k].key.toUpperCase()})"><b>${KINDS[k].key.toUpperCase()}</b> ${esc(KINDS[k].name)}</button>`)
    .join('');
  const laneHtml = lanes
    .map(
      (name, i) =>
        `<div class="es-lane" style="top:${HEAD + i * LANE_H}px;height:${LANE_H}px">` +
        `<span class="es-lane-name">${esc(name)}</span>` +
        `<div class="es-row" style="top:${2 * ROW}px;height:${ROW}px"></div>` +
        `</div>`,
    )
    .join('');
  return (
    `<div class="es-board es-${ph}">` +
    `<div class="es-grip" data-grip title="${esc(b.label ?? 'Event storm')}: click for board actions, drag to move the board with everything on it">⠿ ${esc(b.label ?? 'Event storm')}</div>` +
    `<div class="es-head">` +
    `<div class="es-phases">${pills}</div>` +
    `<div class="es-palette">${palette}</div>` +
    `<span class="es-spacer"></span>` +
    `<span class="es-dots" title="Your votes left on this board (. votes for the sticky under the mouse, , takes one back)">● ${o.dotsLeft} left</span>` +
    `<button class="es-timer${running ? ' es-running' : ''}" data-action="timer" title="Timebox: click to ${running ? 'pause' : 'start'} (right-click the board tab to set its length)">⏱ <span class="es-time">${fmt(timerLeft(t, o.now))}</span></button>` +
    `<button class="es-export" data-action="export" title="The flow as Markdown (for docs and agents)">⇩ Markdown</button>` +
    `</div>` +
    `<div class="es-hint">${esc(PHASE_INFO[ph].hint)}</div>` +
    laneHtml +
    `</div>`
  );
}

export function stickyHtml(n: CanvasNode, o: { editing: boolean; voters: Map<string, string> }): string {
  const k = kindOf(n);
  const info = KINDS[k];
  const by = sticky(n).by;
  const dots = Object.entries(votesOf(n))
    .flatMap(([who, c]) => Array.from({ length: c }, () => `<i style="background:${esc(o.voters.get(who) ?? '#333')}"></i>`))
    .join('');
  const body = o.editing
    ? `<textarea class="es-edit" rows="3" placeholder="${esc(k === 'event' ? 'Something that happened (past tense)' : info.name)}…">${esc(n.text ?? '')}</textarea>`
    : `<div class="es-text">${esc(n.text ?? '') || `<span class="es-empty">${esc(info.name)}</span>`}</div>`;
  return (
    `<div class="es-sticky es-k-${k}${sticky(n).on ? ' es-attached' : ''}" style="--es:${esc(n.color ?? info.color)}">` +
    `<div class="es-kind">${esc(info.name)}</div>` +
    body +
    `<div class="es-foot">` +
    `<span class="es-votes">${dots}</span>` +
    `<button class="es-vote" data-action="vote" title="Vote for it (.)">+●</button>` +
    (by ? `<span class="es-by" style="background:${esc(by.color)}" title="Added by ${esc(by.name)}">${esc(by.name.slice(0, 1).toUpperCase())}</span>` : '') +
    `</div>` +
    `</div>`
  );
}

export function markdownDialog(md: string, onClose: () => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'es-modal';
  wrap.innerHTML =
    `<div class="es-dialog"><div class="es-dialog-head">Flow as Markdown <span class="es-spacer"></span>` +
    `<button data-do="copy">Copy</button><button data-do="download">Download .md</button><button data-do="close">Close</button></div>` +
    `<textarea readonly spellcheck="false"></textarea></div>`;
  wrap.querySelector('textarea')!.value = md;
  wrap.addEventListener('click', async (e) => {
    const d = (e.target as HTMLElement).dataset.do;
    if (e.target === wrap || d === 'close') {
      wrap.remove();
      onClose();
    } else if (d === 'copy') {
      await navigator.clipboard?.writeText(md).catch(() => undefined);
      (e.target as HTMLElement).textContent = 'Copied';
    } else if (d === 'download') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      a.download = 'event-storm.md';
      a.click();
    }
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      wrap.remove();
      onClose();
    }
  });
  return wrap;
}
