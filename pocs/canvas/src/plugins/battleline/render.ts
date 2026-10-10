import { registerPack } from '../cards/packs';
import { SIDE_COLOR, TACTICS, TACTICS_CARDS, TROOPS, UNITS, parseTroop, tactic, tacticLabel, troopFaces, troopLabel, type FlagField } from './model';

// Card faces and backs for the two Battle Line packs (pure HTML strings, no assets), and the flag.

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function troopHtml(face: string): string {
  const t = parseTroop(face);
  if (!t) return `<div class="pc-card bl-troop">${esc(face)}</div>`;
  const v = t.value;
  return (
    `<div class="pc-card bl-troop" style="--bl:${t.color.hex}" data-color="${t.color.code}">` +
    `<div class="bl-corner tl">${v}</div><div class="bl-big">${v}</div>` +
    `<div class="bl-unit">${UNITS[v - 1]}</div><div class="bl-corner br">${v}</div></div>`
  );
}

const KIND_ICON: Record<string, string> = { Leader: '♛', Morale: '⚑', Environment: '☁', Guile: '✦' };

export function tacticHtml(face: string): string {
  const t = tactic(face);
  if (!t) return `<div class="pc-card bl-tactic">${esc(face)}</div>`;
  const icon = `${KIND_ICON[t.kind]}︎`;
  return (
    `<div class="pc-card bl-tactic bl-k-${t.kind.toLowerCase()}">` +
    `<div class="bl-t-head"><span>${icon}</span>${esc(t.name)}</div>` +
    `<div class="bl-t-kind">${t.kind}</div>` +
    `<div class="bl-t-text">${esc(t.text)}</div>` +
    `<div class="bl-t-foot">${esc(t.name)}</div></div>`
  );
}

registerPack({
  id: TROOPS,
  name: 'Battle Line troops',
  deckName: 'Troops',
  cards: troopFaces().map((face) => ({ face, label: troopLabel(face) })),
  face: troopHtml,
  back: `<div class="pc-card bl-back bl-back-troops"><div class="bl-back-inner"><b>⚔︎</b><span>Battle Line</span></div></div>`,
});

registerPack({
  id: TACTICS,
  name: 'Battle Line tactics',
  deckName: 'Tactics',
  cards: TACTICS_CARDS.map((t) => ({ face: t.face, label: tacticLabel(t.face) })),
  face: tacticHtml,
  back: `<div class="pc-card bl-back bl-back-tactics"><div class="bl-back-inner"><b>✦︎</b><span>Tactics</span></div></div>`,
});

/** A pennant on a pole with its number; claimed = in the claiming side's color. */
export function flagHtml(f: FlagField, color?: string, sideName?: string): string {
  const fill = f.claim ? (color ?? SIDE_COLOR[f.claim]) : '#e9d9a6';
  const ink = f.claim ? '#fff' : '#5a4510';
  return (
    `<div class="bl-flag${f.claim ? ' bl-claimed' : ''}" title="Flag ${f.n}${f.claim ? ` (claimed by ${esc(sideName ?? f.claim)})` : ''}: drag toward a side to claim it • right-click: Claim for ▸">` +
    `<svg viewBox="0 0 64 84" width="64" height="84" aria-hidden="true">` +
    `<ellipse cx="18" cy="79" rx="13" ry="4" fill="rgba(0,0,0,.35)"/>` +
    `<rect x="15" y="6" width="4" height="73" rx="2" fill="#6b4f2a"/>` +
    `<circle cx="17" cy="6" r="4.5" fill="#d9b64a"/>` +
    `<path d="M19 10 L60 22 L19 36 Z" fill="${fill}" stroke="rgba(0,0,0,.35)" stroke-width="1"/>` +
    `<text x="32" y="27.5" text-anchor="middle" font-size="13" font-weight="700" font-family="Georgia, serif" fill="${ink}">${f.n}</text>` +
    `</svg>` +
    (f.claim ? `<div class="bl-flag-claim" style="background:${fill}">${esc(sideName ?? f.claim.toUpperCase())}</div>` : '') +
    `</div>`
  );
}

