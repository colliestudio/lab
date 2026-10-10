import { controlText, fmt, nameOf, remaining, ticking, type ClockField, type Side } from './model';

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Chess-clock face: two big tap targets, a pause/start button between, a tab with the time control. */
export function clockHtml(c: ClockField, now: number): string {
  const rot = c.rot ?? 0;
  // turned tall, the half at the top faces the player across the table: its digits turn 180°
  const away: Side | undefined = rot === 90 ? 0 : rot === 270 ? 1 : undefined;
  const side = (s: Side) => {
    const cls = ['ck-side', `ck-s${s}`];
    if (c.run === s && c.flag === undefined) cls.push('ck-run');
    if (c.flag === s) cls.push('ck-flag');
    const title = c.run === undefined ? `Tap to start ${nameOf(c, s === 0 ? 1 : 0)}'s time` : `Tap when ${nameOf(c, s)} has moved`;
    return (
      `<button type="button" class="${cls.join(' ')}" data-action="tap${s}" title="${esc(title)}">` +
      `<span class="ck-face${away === s ? ' ck-away' : ''}">` +
      `<span class="ck-name">${esc(nameOf(c, s))}${c.flag === s ? ' · flag' : ''}</span>` +
      `<span class="ck-time" data-side="${s}">${fmt(remaining(c, s, now))}</span></span></button>`
    );
  };
  const running = c.run !== undefined && ticking(c, c.run);
  const mid = c.flag !== undefined ? '' : running ? '❚❚' : '▶';
  const midTitle = running ? 'Pause' : c.paused ? 'Resume' : `Start ${nameOf(c, 0)}'s time`;
  const control = controlText(c);
  return (
    `<div class="ck-clock ck-rot-${rot}${c.paused ? ' ck-paused' : ''}">` +
    side(0) +
    `<div class="ck-mid">${mid ? `<button type="button" class="ck-toggle" data-action="toggle" title="${midTitle}">${mid}</button>` : ''}</div>` +
    side(1) +
    `<div class="ck-grip" data-grip title="Click for clock settings • drag to move"><span class="ck-grip-dots">⠿</span>Clock ${control}${c.paused ? ' · paused' : ''}</div>` +
    `</div>`
  );
}
