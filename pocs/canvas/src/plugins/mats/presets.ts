import { isNum } from '../../core/commands';
import { set } from '../../core/doc';
import type { CanvasNode, Change, Command, CommandCtx, DocView } from '../../core';
import { shuffled } from '../cards/commands';
import { CARD_H, CARD_W, FIELD as CARDS, PACK, card, cardNode, cardsHomedAt, cardsIn, isDeck, isHand, isHomeDeck, isSpot, packOf, standardDeck } from '../cards/deck';
import { PAD } from '../cards/layout';
import { zoneNode, type ZoneSpec } from './commands';
import { MAT_COLORS, freeZoneNode, isZone, matNode } from './model';

// Ready-made mats (Add… menu). Each is one command: one undo step, synced like any change.

export interface Seat {
  id: string;
  label: string;
  color?: string;
}

/** A zone spec relative to the mat's top-left. */
type Spec = Omit<ZoneSpec, 'x' | 'y'> & { dx: number; dy: number };
type Free = { free: true; dx: number; dy: number; w: number; h: number; name: string; role?: string };
interface Layout {
  label: string;
  color: string;
  w: number;
  h: number;
  zones: (Spec | Free)[];
}

const PILE = { w: CARD_W + 2 * PAD + 20, h: CARD_H + 2 * PAD + 20 };
const span = (n: number) => 2 * PAD + n * CARD_W + (n - 1) * 10;

/** Poker table: community row (5), deck, muck, a pot area and six seats (players present get one each, private). */
function poker(players: Seat[]): Layout {
  const w = 1400;
  const h = 1020;
  const seat = { w: 320, h: 236 };
  const xs = [140, 540, 940];
  const seats: Spec[] = [];
  for (let i = 0; i < 6; i++) {
    const top = i >= 3;
    const p = players[i];
    seats.push({ kind: 'row', dx: xs[top ? 5 - i : i], dy: top ? 30 : h - 30 - seat.h, ...seat, name: `Seat ${i + 1}`, owner: p, role: 'seat' });
  }
  const rowY = 330;
  const community = span(5);
  return {
    label: 'Poker table',
    color: MAT_COLORS[0].hex,
    w,
    h,
    zones: [
      { kind: 'stack', dx: 120, dy: rowY - 15, ...PILE, name: 'Deck', home: true, pack: PACK, role: 'deck' },
      { kind: 'row', dx: (w - community) / 2, dy: rowY, w: community, h: CARD_H + 2 * PAD, name: 'Community cards', max: 5, enter: 'up', role: 'community' },
      { kind: 'stack', dx: w - 120 - PILE.w, dy: rowY - 15, ...PILE, name: 'Muck', enter: 'down', role: 'muck' },
      { free: true, dx: (w - 360) / 2, dy: rowY + CARD_H + 2 * PAD + 40, w: 360, h: 170, name: 'Pot', role: 'pot' },
      ...seats,
    ],
  };
}

/** A player's mat: deck, discard, a play row (face up) and a private hand row for the player. */
function playerMat(players: Seat[]): Layout {
  const play = span(5);
  const w = 30 + PILE.w + 30 + play + 30 + PILE.w + 30;
  const me = players[0];
  return {
    label: me ? `${me.label.replace(/['’]s hand$/, '')}'s mat` : 'Player mat',
    color: MAT_COLORS[1].hex,
    w,
    h: 560,
    zones: [
      { kind: 'stack', dx: 30, dy: 40, ...PILE, name: 'Deck', role: 'deck' },
      { kind: 'row', dx: 60 + PILE.w, dy: 40, w: play, h: CARD_H + 2 * PAD + 20, name: 'In play', enter: 'up', role: 'play' },
      { kind: 'stack', dx: w - 30 - PILE.w, dy: 40, ...PILE, name: 'Discard', enter: 'up', role: 'discard' },
      { kind: 'row', dx: 60 + PILE.w, dy: 300, w: play, h: 236, name: 'Hand', owner: me, role: 'hand' },
    ],
  };
}

/** Klondike: stock (the deck), waste, four foundations (13 each, face up) and seven tableau columns. */
function solitaire(): Layout {
  const colW = CARD_W + 2 * PAD;
  const gap = 14;
  const x0 = 36;
  const cx = (i: number) => x0 + i * (colW + gap);
  const top = { w: colW, h: CARD_H + 2 * PAD };
  const zones: Spec[] = [
    { kind: 'stack', dx: cx(0), dy: 30, ...top, name: 'Stock', home: true, pack: PACK, enter: 'down', role: 'stock' },
    { kind: 'stack', dx: cx(1), dy: 30, ...top, name: 'Waste', enter: 'up', role: 'waste' },
  ];
  for (let i = 0; i < 4; i++) zones.push({ kind: 'stack', dx: cx(3 + i), dy: 30, ...top, name: `Foundation ${i + 1}`, max: 13, enter: 'up', role: 'foundation' });
  for (let i = 0; i < 7; i++) zones.push({ kind: 'column', dx: cx(i), dy: 60 + top.h, w: colW, h: 560, name: `Tableau ${i + 1}`, role: 'tableau' });
  return { label: 'Solitaire', color: MAT_COLORS[0].hex, w: cx(7) - gap + x0, h: 60 + top.h + 560 + 30, zones };
}

export const PRESETS = {
  poker: { label: 'Poker table', build: poker },
  player: { label: 'Player mat', build: playerMat },
  solitaire: { label: 'Solitaire (Klondike)', build: solitaire },
} as const;
export type PresetId = keyof typeof PRESETS;

/**
 * Cards for a home-deck zone: the table's standard deck moves in (all its cards, shuffled face down;
 * its old home spot goes, groups left empty go) unless it already sits on another mat; with no deck
 * on the table, a new one. Returns whether the zone became the home deck.
 */
function fillDeck(doc: DocView, zoneId: string, at: { x: number; y: number }, ctx: CommandCtx, z: () => number): { changes: Change[]; home: boolean } {
  const homes = doc.nodes.filter((n) => isHomeDeck(n) && packOf(n) === PACK);
  if (homes.some(isZone)) return { changes: [], home: false };
  const changes: Change[] = [];
  const faces = homes.length ? [] : standardDeck();
  const moving = homes.flatMap((h) => cardsHomedAt(doc, h.id));
  const ids = new Set(moving.map((c) => c.id));
  shuffled(moving, ctx.random).forEach((c, i) => {
    changes.push(set(c.id, `${CARDS}.stack`, zoneId), set(c.id, `${CARDS}.order`, i + 1), set(c.id, `${CARDS}.home`, zoneId), set(c.id, 'x', at.x), set(c.id, 'y', at.y));
    if (card(c).faceUp) changes.push(set(c.id, `${CARDS}.faceUp`, false));
    if (card(c).mine !== undefined) changes.push(set(c.id, `${CARDS}.mine`, undefined));
  });
  for (const h of homes) changes.push({ op: 'del', id: h.id });
  // groups left with nothing (a hand or a table spot stays)
  for (const n of doc.nodes)
    if (isDeck(n) && !isHomeDeck(n) && !isHand(n) && !isSpot(n) && cardsIn(doc, n.id).length && cardsIn(doc, n.id).every((c) => ids.has(c.id))) changes.push({ op: 'del', id: n.id });
  shuffled(faces, ctx.random).forEach((face, i) => changes.push({ op: 'add', node: cardNode(ctx.newId(), at.x, at.y, { face, faceUp: false, stack: zoneId, order: i + 1, home: zoneId }, z(), PACK) }));
  return { changes, home: true };
}

/** Put a preset mat centered on (x, y). `players`: who sits at it (me first): seats / hands become theirs. */
export const preset: Command<{ preset: PresetId; x?: number; y?: number; players?: Seat[] }> = (doc, a, ctx) => {
  const p = PRESETS[a?.preset as PresetId];
  if (!p) return [];
  const players = (Array.isArray(a.players) ? a.players : []).filter((s): s is Seat => !!s && typeof s.id === 'string' && !!s.id && typeof s.label === 'string');
  const l = p.build(players);
  const x0 = Math.round((isNum(a.x) ? a.x : 0) - l.w / 2);
  const y0 = Math.round((isNum(a.y) ? a.y : 0) - l.h / 2);
  let z = Math.floor(doc.topZ);
  const nextZ = () => ++z;
  const m = matNode(ctx.newId(), x0, y0, l.w, l.h, nextZ(), { label: l.label, color: l.color, preset: a.preset });
  const changes: Change[] = [{ op: 'add', node: m }];
  const later: Change[] = [];
  for (const s of l.zones) {
    const x = x0 + s.dx;
    const y = y0 + s.dy;
    if ('free' in s) {
      changes.push({ op: 'add', node: freeZoneNode(ctx.newId(), m.id, x, y, s.w, s.h, nextZ(), s.name, s.role) });
      continue;
    }
    const id = ctx.newId();
    let spec: ZoneSpec = { ...s, x, y };
    if (s.home) {
      const pile = { x: Math.round(x + (s.w - CARD_W) / 2), y: Math.round(y + (s.h - CARD_H) / 2) };
      const filled = fillDeck(doc, id, pile, ctx, nextZ);
      later.push(...filled.changes);
      if (!filled.home) spec = { ...spec, home: false, pack: undefined };
    }
    changes.push({ op: 'add', node: zoneNode(id, m.id, nextZ(), spec) });
  }
  // cards above their zone (a new deck's cards were numbered before the zones: lift them)
  const took = later.some((c) => c.op === 'set') ? ' (the table’s deck moved in, shuffled)' : '';
  return {
    changes: [...changes, ...later.map((c) => (c.op === 'add' ? { ...c, node: { ...c.node, z: nextZ() } } : c))],
    select: [],
    events: [{ type: 'mats.preset', text: `added a mat: ${p.label}${took}`, targets: [m.id] }],
  };
};

export const presetOf = (n: CanvasNode) => (n['x-mats'] as { preset?: string } | undefined)?.preset;
