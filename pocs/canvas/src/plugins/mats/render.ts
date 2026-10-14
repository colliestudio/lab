// Mats and zones are drawn from data: a felt surface with a tab, dashed areas. No assets.

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function matHtml(o: { label: string; color: string; locked: boolean; editing: boolean }): string {
  const lock = o.locked ? '<span class="mt-lock" title="Locked: drag the tab to move the mat">🔒︎</span>' : '';
  const tip = `${o.label}: click for mat actions (zones, edit mode, color, lock) • drag here to move the mat with everything on it`;
  return (
    `<div class="mt-mat${o.editing ? ' mt-editing' : ''}${o.locked ? '' : ' mt-unlocked'}" style="--mt:${esc(o.color)}">` +
    `<div class="mt-grip" data-grip title="${esc(tip)}"><span class="mt-grip-dots">⠿</span>${esc(o.label)}${o.editing ? ' · editing zones' : ''}${lock}</div>` +
    (o.editing
      ? `<div class="mt-banner">Editing zones: drag a zone to move it, its corner to resize, ⚙ or right-click for its settings <button data-action="done" title="Done editing (Z)">Done</button></div>`
      : '') +
    `<div class="mt-resize" title="Drag to resize the mat"></div>` +
    `</div>`
  );
}

/** A free area: a dashed, labelled spot. */
export function areaHtml(name: string): string {
  return `<div class="mt-area"><span class="mt-area-label">${esc(name)}</span></div>`;
}

/** Edit-mode overlay on a zone: outline, settings chip, resize corner. */
export function zoneEditHtml(name: string): string {
  return (
    `<div class="mt-zone-edit">` +
    `<button class="mt-zone-chip" data-action="zone-menu" title="Zone settings">⚙︎ ${esc(name)}</button>` +
    `<div class="mt-resize mt-zone-resize" title="Drag to resize the zone"></div>` +
    `</div>`
  );
}
