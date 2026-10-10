import { PACK, SUITS, isFace, parseFace, rankLabel, type Rank } from './deck';
import { getPack } from './packs';

export interface CardData {
  face: string;
  faceUp: boolean;
  /** Pack id (default standard-52): its registered renderer draws the face and back. */
  pack?: string;
}

// Card faces are built from data: corners + pip layout / court glyph. No image assets.

type Pip = [col: 0 | 1 | 2, y: number]; // col: left/center/right; y: 0 (top) .. 1 (bottom)
const L = 0,
  C = 1,
  R = 2;
const side = (col: 0 | 2, ys: number[]): Pip[] => ys.map((y) => [col, y]);
const PIPS: Partial<Record<Rank, Pip[]>> = {
  '2': [[C, 0], [C, 1]],
  '3': [[C, 0], [C, 0.5], [C, 1]],
  '4': [...side(L, [0, 1]), ...side(R, [0, 1])],
  '5': [...side(L, [0, 1]), ...side(R, [0, 1]), [C, 0.5]],
  '6': [...side(L, [0, 0.5, 1]), ...side(R, [0, 0.5, 1])],
  '7': [...side(L, [0, 0.5, 1]), ...side(R, [0, 0.5, 1]), [C, 0.25]],
  '8': [...side(L, [0, 0.5, 1]), ...side(R, [0, 0.5, 1]), [C, 0.25], [C, 0.75]],
  '9': [...side(L, [0, 1 / 3, 2 / 3, 1]), ...side(R, [0, 1 / 3, 2 / 3, 1]), [C, 0.5]],
  T: [...side(L, [0, 1 / 3, 2 / 3, 1]), ...side(R, [0, 1 / 3, 2 / 3, 1]), [C, 1 / 6], [C, 5 / 6]],
};
const COL_X = [30, 50, 70];
// ︎ asks for the text (not emoji) presentation
const COURT: Partial<Record<Rank, string>> = { K: '♚︎', Q: '♛︎', J: '♞︎' };

export const STANDARD_BACK = `<div class="pc-card pc-back"><div class="pc-back-inner"></div></div>`;

/** A card of any pack, through the pack registry. Unknown pack: a plain card showing the face code. */
export function cardHtml(c: CardData): string {
  const p = getPack(c.pack ?? PACK);
  if (!c.faceUp) return p?.back ?? STANDARD_BACK;
  if (p) return p.face(c.face);
  return isFace(c.face) ? standardFaceHtml(c.face) : `<div class="pc-card pc-face pc-black pc-unknown">${esc(c.face)}</div>`;
}

/** The standard-52 face: corners + pip layout / court glyph. */
export function standardFaceHtml(face: string): string {
  const { rank, suit } = parseFace(face);
  const s = SUITS[suit];
  const sym = `${s.sym}︎`;
  const corner = (cls: string) => `<div class="pc-corner ${cls}"><b>${rankLabel(rank)}</b><i>${sym}</i></div>`;
  let center: string;
  if (rank === 'A') {
    center = `<div class="pc-ace${suit === 'S' ? ' pc-ace-spades' : ''}">${sym}</div>`;
  } else if (COURT[rank]) {
    center =
      `<div class="pc-court"><span class="pc-court-suit tl">${sym}</span>` +
      `<span class="pc-court-glyph">${COURT[rank]}</span>` +
      `<span class="pc-court-letter">${rank}</span>` +
      `<span class="pc-court-suit br">${sym}</span></div>`;
  } else {
    center =
      `<div class="pc-pips">` +
      PIPS[rank]!.map(
        ([col, y]) =>
          `<span class="${y > 0.5 ? 'pc-down' : ''}" style="left:${COL_X[col]}%;top:${18 + y * 64}%">${sym}</span>`,
      ).join('') +
      `</div>`;
  }
  return `<div class="pc-card pc-face ${s.red ? 'pc-red' : 'pc-black'}">${corner('tl')}${center}${corner('br')}</div>`;
}

/** A deck: its top card plus a visible edge whose thickness follows the card count. */
export function deckHtml(top: CardData | undefined, count: number, home = false, name = 'Deck'): string {
  const layers = Math.min(10, Math.ceil(count / 4));
  const shadow = Array.from({ length: layers }, (_, i) => {
    const o = (i + 1) * 1.1;
    return `${o}px ${o}px 0 0 ${i % 2 ? '#bdb7aa' : '#ece7dc'}`;
  });
  shadow.push(`${layers * 1.1 + 2}px ${layers * 1.1 + 4}px 10px rgba(0,0,0,.35)`);
  return (
    `<div class="pc-stack" style="--pc-stack-shadow:${shadow.join(',')}">` +
    (top ? cardHtml(top) : '<div class="pc-card pc-empty"></div>') +
    `<div class="pc-grip${home ? ' pc-home' : ''}" data-grip title="${home ? 'Home deck' : 'Deck'}: click for actions • drag here (or Alt+drag) to move it • drag the cards to draw">` +
    `<span class="pc-grip-dots">⠿</span>${esc(name)} · ${count}` +
    `</div></div>`
  );
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A tab's text: "Group · 4", "Alex's hand · 5 · 2 shown". */
export function tabText(label: string, count: number, shown = 0): string {
  return `${label} · ${count}${shown ? ` · ${shown} shown` : ''}`;
}

/**
 * A spread-out group: a frame under its cards, with a tab "Group · 4" (drag = move all, click = menu).
 * A table spot (`slots` = outlines, relative to the frame; `faint` = extra capacity) is drawn quieter.
 */
export function groupHtml(count: number, o: { hand?: false; home?: boolean; label: string; color?: string; slots?: { dx: number; dy: number; faint?: boolean }[]; over?: boolean }): string {
  if (o.slots) {
    const outlines = o.slots.map((p) => `<div class="pc-slot${p.faint ? ' pc-slot-faint' : ''}" style="left:${p.dx}px;top:${p.dy}px"></div>`).join('');
    return (
      `<div class="pc-group pc-spot${o.over ? ' pc-over' : ''}"${o.over ? ' title="More cards than it holds now"' : ''}${o.color ? ` style="--pc-group:${o.color}"` : ''}>${outlines}` +
      `<div class="pc-grip pc-group-tab" data-grip title="${esc(o.label)}: click for actions • drag here to move">` +
      `<span class="pc-grip-dots">⠿</span>${esc(tabText(o.label, count))}</div></div>`
    );
  }
  const color = o.color ?? (o.home ? '#233257' : '#555');
  const tip = o.home
    ? 'The home deck, spread out as a group • click for actions (L stacks it again) • drag here to move'
    : 'Group: every card shown • click for actions (turn into a deck or hand, layout, put on table) • drag here to move';
  return (
    `<div class="pc-group" style="--pc-group:${color}">` +
    `<div class="pc-grip pc-group-tab" data-grip title="${tip}" style="background:${color}">` +
    `<span class="pc-grip-dots">⠿</span>${esc(tabText(o.label, count))}</div></div>`
  );
}

/**
 * A hand: a fixed frame (same for everyone), the "Shown to table" strip if it allows showing (with
 * the drag-up threshold line, visible while dragging one of its cards), and for others when the count
 * is hidden a generic pile instead of its cards. `count` undefined = not shown on the tab.
 */
export function handHtml(o: {
  label: string;
  color?: string;
  mine: boolean;
  /** The owner left the table: greyed, with their last known name. */
  away?: boolean;
  /** Show the resize handle (the owner's fixed frame). */
  resizable?: boolean;
  count?: number;
  shown: number;
  pile: boolean;
  blind: boolean;
  lane: number;
  threshold: number;
  rowTop: number;
}): string {
  const color = o.color ?? '#2f4b7c';
  const tip = o.mine
    ? `Your hand: only you see the cards in the row${o.lane ? '; cards in the strip above are shown to everyone (drag a card up above the line to show it, back down to hide it)' : ''}${o.blind ? ' • See my cards is off: you see only the cards you flipped up for yourself' : ''} • click for actions • drag to move${o.resizable ? ' • drag the right edge to resize' : ''}`
    : `${esc(o.label)}${o.away ? ' (left the table: anyone can give it to someone)' : ''}${o.lane ? ': cards in the strip are shown to the table' : ''} • click for actions • drag to move`;
  const text = (o.count === undefined ? o.label : tabText(o.label, o.count, o.lane ? o.shown : 0)) + (o.away ? ' (left)' : '');
  const strip = o.lane
    ? `<div class="pc-lane" style="height:${o.lane}px"><span>Shown to table</span></div><div class="pc-threshold" style="top:${o.threshold}px"><span>above the line: shown</span></div>`
    : '';
  const pile = o.pile ? `<div class="pc-pile" style="top:${o.rowTop}px"><i></i><i></i><i></i></div>` : '';
  return (
    `<div class="pc-group pc-hand${o.away ? ' pc-away' : ''}" style="--pc-group:${color}">` +
    strip +
    pile +
    `<div class="pc-grip pc-group-tab" data-grip title="${tip}" style="background:${color}">` +
    `<span class="pc-grip-dots">⠿</span>${esc(text)}${o.mine && o.blind ? ' <span class="pc-blind" title="See my cards is off">◐</span>' : ''}</div>` +
    (o.resizable ? '<div class="pc-resize" title="Drag to resize the hand"></div>' : '') +
    `</div>`
  );
}
