import { isIds, isNum, pick, set, toFront, type CanvasNode, type Change, type Command, type DocView } from '../../core';
import { give, shuffled } from '../cards/commands';
import { FIELD as CARDS, card, cardNode, cardsIn, deckNode, groupNode, isHomeDeck, packOf } from '../cards/deck';
import { HAND_W, emptyHandSize } from '../cards/layout';
import { TACTICS_CARDS } from './model';
import {
  CLAIM_DY,
  COL,
  FIELD,
  FLAG_H,
  FLAG_W,
  FORM_H,
  LINE,
  NEAR,
  SIDES,
  SIDE_NAME,
  TACTICS,
  TROOPS,
  flag,
  flagText,
  geometry,
  isFlag,
  isPart,
  part,
  troopFaces,
  type FlagField,
  type PartField,
  type Side,
} from './model';

// Pure commands (doc, args, ctx) -> changes, like every plugin. Cards stay cards-plugin data
// (`x-cards`); `x-battleline` only marks flags and which container is which part of the line.

/** Dealt cards lie face down: in a hand that means private (its owner sees the faces, others the backs). */
export const DEAL_FACE_UP = false;

const C = (k: string) => `${CARDS}.${k}`;
const isSide = (v: unknown): v is Side => v === 'a' || v === 'b';
const mark = (n: CanvasNode, p: PartField): CanvasNode => ({ ...n, [FIELD]: p });

export const troopsDeck = (doc: DocView) => doc.nodes.find((n) => isHomeDeck(n) && packOf(n) === TROOPS);
export const flags = (doc: DocView) => doc.nodes.filter(isFlag).sort((a, b) => flag(a).n - flag(b).n);
export const handOf = (doc: DocView, side: Side) => doc.nodes.find((n) => isPart(n, 'hand') && part(n)!.side === side);
export const formation = (doc: DocView, n: number, side: Side) => doc.nodes.find((x) => isPart(x, 'formation') && part(x)!.flag === n && part(x)!.side === side);

/** Middle of the line (from the flags' home spots), if there is one. */
export function lineCenter(doc: DocView): { x: number; y: number } | undefined {
  const fs = flags(doc);
  if (!fs.length) return;
  const first = flag(fs[0]);
  const last = flag(fs[fs.length - 1]);
  return { x: Math.round((first.hx + last.hx) / 2 + FLAG_W / 2), y: Math.round(first.hy + FLAG_H / 2) };
}

/** The table: 9 flags in a row, a 3-slot formation (room for 4: Mud) per flag and side, both decks shuffled, a discard pile. */
export const setup: Command<{ x?: number; y?: number }> = (doc, a, ctx) => {
  if (troopsDeck(doc)) return [];
  const cx = Math.round(isNum(a?.x) ? a.x : 0);
  const cy = Math.round(isNum(a?.y) ? a.y : 0);
  const g = geometry(cx, cy);
  let z = Math.floor(doc.topZ);
  const changes: Change[] = [];
  const add = (node: CanvasNode) => changes.push({ op: 'add', node });

  for (let i = 0; i < 9; i++)
    for (const side of SIDES) {
      const p = g.formation(i, side);
      const box = groupNode(ctx.newId(), p.x, p.y, ++z, { layout: side === 'a' ? 'column' : 'column-up', pack: LINE, spot: true, slots: 3, max: 4, label: `Flag ${i + 1} · ${SIDE_NAME[side]}` });
      add(mark(box, { role: 'formation', flag: i + 1, side }));
    }
  const discard = groupNode(ctx.newId(), g.discard.x, g.discard.y, ++z, { layout: 'stack', pack: LINE, spot: true, label: 'Discard' });
  add(mark({ ...discard, text: 'Discard' }, { role: 'discard' }));

  const deck = (pack: string, faces: string[], at: { x: number; y: number }, role: 'troops' | 'tactics') => {
    const d = deckNode(ctx.newId(), at.x, at.y, ++z, pack, true);
    add(mark(d, { role }));
    shuffled(faces, ctx.random).forEach((face, i) => add(cardNode(ctx.newId(), at.x, at.y, { face, faceUp: false, stack: d.id, order: i + 1, home: d.id }, ++z, pack)));
  };
  deck(TROOPS, troopFaces(), g.troops, 'troops');
  deck(TACTICS, TACTICS_CARDS.map((t) => t.face), g.tactics, 'tactics');

  for (let i = 0; i < 9; i++) {
    const p = g.flag(i);
    const f: FlagField = { kind: 'flag', n: i + 1, hx: p.x, hy: p.y };
    add({ id: ctx.newId(), type: 'text', x: p.x, y: p.y, width: FLAG_W, height: FLAG_H, z: ++z, text: flagText(f), [FIELD]: f });
  }
  return { changes, select: [] };
};

export interface Seat {
  id: string;
  label: string;
  color?: string;
}

/**
 * Deal Battle Line: `count` (default 7) troop cards, face down, to each side's hand, alternating,
 * from the top of the troop deck. A missing hand is made as a private hand of the next seated player
 * (`players`, the local player first) or, with nobody left (solo), as an ownerless group (a table
 * spot, so it stays). An ownerless one is given to the next player, as Give to ▸ would.
 */
export const deal: Command<{ players: Seat[]; count?: number }> = (doc, a, ctx) => {
  const deck = troopsDeck(doc);
  if (!deck) return [];
  const count = isNum(a?.count) ? Math.max(0, Math.min(30, Math.floor(a.count))) : 7;
  const players = (Array.isArray(a?.players) ? a.players : []).filter((p): p is Seat => !!p && typeof p.id === 'string' && !!p.id && typeof p.label === 'string');
  const c = lineCenter(doc) ?? { x: deck.x + 900, y: deck.y + 210 };
  const g = geometry(c.x, c.y);
  const changes: Change[] = [];
  const taken = new Set(SIDES.map((s) => handOf(doc, s)?.owner).filter(Boolean));
  const queue = players.filter((p, i) => !taken.has(p.id) && players.findIndex((q) => q.id === p.id) === i);
  let z = Math.floor(doc.topZ);
  const hands = SIDES.map((side) => {
    const h = handOf(doc, side);
    if (h) {
      if (!h.owner && queue.length) {
        const p = queue.shift()!;
        const r = give(doc, { id: h.id, to: p.id, label: p.label, color: p.color }, ctx);
        changes.push(...(Array.isArray(r) ? r : r.changes));
      }
      return { id: h.id, x: h.x, y: h.y, order: cardsIn(doc, h.id).reduce((m, x) => Math.max(m, card(x).order ?? 0), 0) };
    }
    const p = queue.shift();
    const at = g.hand(side, HAND_W, emptyHandSize().h);
    const label = p ? p.label.slice(0, 40) : `Hand ${SIDE_NAME[side]}`;
    // nobody to own it (solo): a public group that stays put like a seat (Give to ▸ hands it over)
    const node = groupNode(ctx.newId(), at.x, at.y, ++z, { layout: 'fan', pack: LINE, owner: p?.id, label, color: p?.color, spot: !p });
    changes.push({ op: 'add', node: mark(node, { role: 'hand', side }) });
    return { id: node.id, x: node.x, y: node.y, order: 0 };
  });
  const pile = cardsIn(doc, deck.id).slice();
  for (let k = 0; k < count; k++)
    for (const h of hands) {
      const top = pile.pop();
      if (!top) break;
      changes.push(set(top.id, C('stack'), h.id), set(top.id, C('order'), ++h.order), set(top.id, 'x', h.x), set(top.id, 'y', h.y));
      if (card(top).faceUp !== DEAL_FACE_UP) changes.push(set(top.id, C('faceUp'), DEAL_FACE_UP));
    }
  return { changes, select: [] };
};

/** Where a flag stands for a claim (top-left). */
const spot = (f: FlagField, side?: Side) => ({ x: f.hx, y: f.hy + (side === 'a' ? CLAIM_DY : side === 'b' ? -CLAIM_DY : 0) });

function claimChanges(n: CanvasNode, side: Side | undefined): Change[] {
  const f = flag(n);
  const p = spot(f, side);
  const out: Change[] = [];
  if (n.x !== p.x) out.push(set(n.id, 'x', p.x));
  if (n.y !== p.y) out.push(set(n.id, 'y', p.y));
  if (f.claim !== side) out.push(set(n.id, `${FIELD}.claim`, side), set(n.id, 'text', flagText({ ...f, claim: side })));
  return out;
}

/** Claim flags for a side (moves them to its claimed spot), or `side: null` = unclaimed (back to the line). */
export const claim: Command<{ ids: string[]; side: Side | null }> = (doc, a) => {
  if (!(a?.side === null || isSide(a?.side))) return [];
  const fs = pick(doc, a.ids).filter(isFlag);
  return [...fs.flatMap((n) => claimChanges(n, a.side ?? undefined)), ...toFront(doc, fs)];
};

/**
 * A flag was dragged: near its home column it snaps to the spot of the side it was dragged toward
 * (or back to the line); dragged far away it lies where it was dropped.
 */
export const placeFlags: Command<{ ids: string[] }> = (doc, a) => {
  if (!isIds(a?.ids)) return [];
  return pick(doc, a.ids)
    .filter(isFlag)
    .flatMap((n) => {
      const f = flag(n);
      const dx = n.x - f.hx;
      const dy = n.y - f.hy;
      if (Math.abs(dx) > COL * 0.75 || Math.abs(dy) > NEAR + FORM_H / 2) return [];
      return claimChanges(n, dy > CLAIM_DY / 2 ? 'a' : dy < -CLAIM_DY / 2 ? 'b' : undefined);
    });
};

/** Reset table: flags back on the line, unclaimed. (The cards plugin's reset gathers and shuffles the decks.) */
export const resetAll: Command<Record<string, never>> = (doc) => flags(doc).flatMap((n) => claimChanges(n, undefined));

export const commands = { setup, deal, claim, placeFlags, resetAll };

