import { isIds, isNum, pick, set, toFront, type CanvasNode, type Change, type Command, type CommandCtx, type DocView } from '../../core';
import { give, shuffled } from '../cards/commands';
import { FIELD as CARDS, CARD_H, card, cardNode, cardsHomedAt, cardsIn, deckNode, groupNode, isDeck, isHand, isHomeDeck, isSpot, packOf } from '../cards/deck';
import { HAND_W, emptyHandSize } from '../cards/layout';
import { FIELD as MATS, isMat, isZone, matNode } from '../mats/model';
import { ENV_H, ENV_W, PLAYED_H, PLAYED_W, TACTICS_CARDS, TALLY, isTactic, playedBy } from './model';
import {
  CLAIM_DY,
  COL,
  FIELD,
  FLAG_H,
  FLAG_W,
  FORM_H,
  FORM_W,
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

export const troopsDeck = (doc: DocView) => doc.nodes.find((n) => isHomeDeck(n) && packOf(n) === TROOPS);
export const flags = (doc: DocView) => doc.nodes.filter(isFlag).sort((a, b) => flag(a).n - flag(b).n);
export const handOf = (doc: DocView, side: Side) => doc.nodes.find((n) => isPart(n, 'hand') && part(n)!.side === side);
export const formation = (doc: DocView, n: number, side: Side) => doc.nodes.find((x) => isPart(x, 'formation') && part(x)!.flag === n && part(x)!.side === side);

/** Middle of the line (from the flags' home spots), if there is one. */
export function lineCenter(doc: DocView): { x: number; y: number } | undefined {
  const fs = flags(doc);
  if (!fs.length) return;
  const first = homeOf(doc, fs[0]);
  const last = homeOf(doc, fs[fs.length - 1]);
  return { x: Math.round((first.x + last.x) / 2 + FLAG_W / 2), y: Math.round(first.y + FLAG_H / 2) };
}

/**
 * A flag's unclaimed spot (top-left): between its two formations (so it follows them when the mat
 * moves), else where it was set up.
 */
export function homeOf(doc: DocView, n: CanvasNode): { x: number; y: number } {
  const f = flag(n);
  const a = formation(doc, f.n, 'a');
  const b = formation(doc, f.n, 'b');
  if (!a || !b) return { x: f.hx, y: f.hy };
  return { x: Math.round(a.x + a.width / 2 - FLAG_W / 2), y: Math.round((b.y + b.height + a.y) / 2 - FLAG_H / 2) };
}

export const playedRow = (doc: DocView, side: Side) => doc.nodes.find((n) => isPart(n, 'played') && part(n)!.side === side);
export const environment = (doc: DocView, n: number) => doc.nodes.find((x) => isPart(x, 'environment') && part(x)!.flag === n);
export const tally = (doc: DocView) => doc.nodes.find((n) => isPart(n, 'tally'));
export const discardPile = (doc: DocView) => doc.nodes.find((n) => isPart(n, 'discard'));
/** Fog / Mud lying on flag `n`. */
export const envOn = (doc: DocView, n: number) => {
  const e = environment(doc, n);
  const faces = e ? cardsIn(doc, e.id).map((c) => card(c).face) : [];
  return { fog: faces.includes('fog'), mud: faces.includes('mud') };
};

/** Tactics each side has played: in its formations, on flags (who laid them), in its played row. */
export function tacticCounts(doc: DocView): Record<Side, number> {
  const out: Record<Side, number> = { a: 0, b: 0 };
  for (const n of doc.nodes) {
    if (!isPart(n, 'formation') && !isPart(n, 'played') && !isPart(n, 'environment')) continue;
    for (const c of cardsIn(doc, n.id)) {
      if (!isTactic(c)) continue;
      const side = isPart(n, 'environment') ? playedBy(c) : part(n)!.side;
      if (side) out[side]++;
    }
  }
  return out;
}

/** A formation's slots now: 3, or 4 while Mud lies on its flag. */
export const formationCapacity = (doc: DocView, n: CanvasNode) => {
  if (!isPart(n, 'formation')) return;
  const k = envOn(doc, part(n)!.flag ?? 0).mud ? 4 : 3;
  return { slots: k, max: k };
};

type Mark = (n: CanvasNode, role: PartField['role'], name: string, extra?: Omit<PartField, 'role'>) => CanvasNode;

/** The line's spots that older tables lack: played tactics rows, environment spots, the tally. */
function missingParts(doc: DocView, g: ReturnType<typeof geometry>, ctx: CommandCtx, z: () => number, mark: Mark): CanvasNode[] {
  const out: CanvasNode[] = [];
  for (const side of SIDES)
    if (!playedRow(doc, side)) {
      const p = g.played(side);
      out.push(mark(groupNode(ctx.newId(), p.x, p.y, z(), { layout: 'row', pack: LINE, spot: true, area: { w: PLAYED_W, h: PLAYED_H }, enter: 'up', label: `Played tactics · ${SIDE_NAME[side]}` }), 'played', `Played tactics · ${SIDE_NAME[side]}`, { side }));
    }
  for (let i = 0; i < 9; i++)
    if (!environment(doc, i + 1)) {
      const p = g.environment(i);
      out.push(mark(groupNode(ctx.newId(), p.x, p.y, z(), { layout: 'row', pack: LINE, spot: true, max: 2, area: { w: ENV_W, h: ENV_H }, enter: 'up', label: `Flag ${i + 1} environment` }), 'environment', `Flag ${i + 1} environment`, { flag: i + 1 }));
    }
  if (!tally(doc)) out.push(mark({ id: ctx.newId(), type: 'text', x: g.tally.x, y: g.tally.y, width: TALLY.w, height: TALLY.h, z: z(), text: 'Tactics played' }, 'tally', 'Tactics played'));
  return out;
}

/**
 * The table: 9 flags in a row, a formation per flag and side (3 slots, a 4th with Mud), an
 * environment spot on each flag, both decks shuffled, a discard pile, a played tactics row per side
 * and the tactics tally. `mat: true`: all of it on a mat (the formations, discard and played rows
 * are its zones; Edit zones moves them).
 */
export const setup: Command<{ x?: number; y?: number; mat?: boolean }> = (doc, a, ctx) => {
  if (troopsDeck(doc)) return [];
  const cx = Math.round(isNum(a?.x) ? a.x : 0);
  const cy = Math.round(isNum(a?.y) ? a.y : 0);
  const g = geometry(cx, cy);
  let z = Math.floor(doc.topZ);
  const nextZ = () => ++z;
  const changes: Change[] = [];
  const add = (node: CanvasNode) => changes.push({ op: 'add', node });
  const matId = a?.mat ? ctx.newId() : undefined;
  if (matId) add(matNode(matId, g.mat.x, g.mat.y, g.mat.w, g.mat.h, nextZ(), { label: 'Battle Line', color: '#5b4a33', preset: 'battleline' }));
  // a zone of the mat (if there is one): Edit zones can move it
  const mark: Mark = (n, role, name, extra = {}) => {
    const out: CanvasNode = { ...n, [FIELD]: { role, ...extra } };
    if (matId && role !== 'environment' && role !== 'tally') out[MATS] = { zone: matId, name, role };
    return out;
  };

  for (let i = 0; i < 9; i++)
    for (const side of SIDES) {
      const p = g.formation(i, side);
      const name = `Flag ${i + 1} · ${SIDE_NAME[side]}`;
      const box = groupNode(ctx.newId(), p.x, p.y, nextZ(), { layout: side === 'a' ? 'column' : 'column-up', pack: LINE, spot: true, slots: 3, max: 3, area: { w: FORM_W, h: FORM_H }, enter: 'up', label: name });
      add(mark(box, 'formation', name, { flag: i + 1, side }));
    }
  const discard = groupNode(ctx.newId(), g.discard.x, g.discard.y, nextZ(), { layout: 'stack', pack: LINE, spot: true, area: { w: FORM_W, h: CARD_H + 28 }, enter: 'up', label: 'Discard' });
  add(mark({ ...discard, text: 'Discard' }, 'discard', 'Discard'));

  const deck = (pack: string, faces: string[], at: { x: number; y: number }, role: 'troops' | 'tactics') => {
    const d = deckNode(ctx.newId(), at.x, at.y, nextZ(), pack, true);
    add({ ...d, [FIELD]: { role } });
    shuffled(faces, ctx.random).forEach((face, i) => add(cardNode(ctx.newId(), at.x, at.y, { face, faceUp: false, stack: d.id, order: i + 1, home: d.id }, nextZ(), pack)));
  };
  deck(TROOPS, troopFaces(), g.troops, 'troops');
  deck(TACTICS, TACTICS_CARDS.map((t) => t.face), g.tactics, 'tactics');

  for (let i = 0; i < 9; i++) {
    const p = g.flag(i);
    const f: FlagField = { kind: 'flag', n: i + 1, hx: p.x, hy: p.y };
    add({ id: ctx.newId(), type: 'text', x: p.x, y: p.y, width: FLAG_W, height: FLAG_H, z: nextZ(), text: flagText(f), [FIELD]: f });
  }
  for (const n of missingParts(doc, g, ctx, nextZ, mark)) add(n);
  return { changes, select: [] };
};

export interface Seat {
  id: string;
  label: string;
  color?: string;
}

/** Changes that put every card of a pack's home deck back in it: shuffled, face down, private marks gone. */
function gatherPack(doc: DocView, deck: CanvasNode, ctx: CommandCtx, deal: (c: CanvasNode) => { into: CanvasNode; order: number } | undefined = () => undefined): Change[] {
  const out: Change[] = [];
  const cards = shuffled(cardsHomedAt(doc, deck.id), ctx.random);
  // the top of the shuffled deck (the end) is dealt first
  const dealt = new Map<string, { into: CanvasNode; order: number }>();
  for (let i = cards.length - 1; i >= 0; i--) {
    const d = deal(cards[i]);
    if (!d) break;
    dealt.set(cards[i].id, d);
  }
  let order = 0;
  for (const c of cards) {
    const d = dealt.get(c.id);
    const into = d?.into ?? deck;
    out.push(set(c.id, C('stack'), into.id), set(c.id, C('order'), d ? d.order : ++order), set(c.id, 'x', into.x), set(c.id, 'y', into.y));
    if (card(c).faceUp !== (d ? DEAL_FACE_UP : false)) out.push(set(c.id, C('faceUp'), d ? DEAL_FACE_UP : false));
    if (card(c).mine !== undefined) out.push(set(c.id, C('mine'), undefined));
    if (c[FIELD] !== undefined) out.push(set(c.id, FIELD, undefined));
  }
  return out;
}

/** Groups (not hands, spots or decks) that would hold nothing once `leaving` cards left. */
function emptiedGroups(doc: DocView, leaving: Set<string>): Change[] {
  return doc.nodes
    .filter((n) => isDeck(n) && !isHomeDeck(n) && !isHand(n) && !isSpot(n) && cardsIn(doc, n.id).length > 0 && cardsIn(doc, n.id).every((c) => leaving.has(c.id)))
    .map((n): Change => ({ op: 'del', id: n.id }));
}

/**
 * Deal Battle Line: a fresh game. Every troop and tactic comes back (formations, flags, played
 * rows, discard, hands), both decks are shuffled, flags go back on the line, then `count` (default
 * 7) troops go face down to each side's hand. One hand per player: a side without a hand takes a
 * hand its player already has (New hand), else gets a new private hand for the next seated player
 * (`players`, me first), else (solo) an ownerless seat. An ownerless one is given to the next player.
 * Older tables get their missing spots (played tactics rows, environment spots, tally).
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
  const nextZ = () => ++z;
  const matId = doc.nodes.find((n) => isMat(n) && doc.riders(n.id).some((r) => isPart(r, 'formation')))?.id;
  const mark: Mark = (n, role, name, extra = {}) => {
    const out: CanvasNode = { ...n, [FIELD]: { role, ...extra } };
    if (matId && role !== 'environment' && role !== 'tally') out[MATS] = { zone: matId, name, role };
    return out;
  };
  const hands = SIDES.map((side) => {
    const h = handOf(doc, side);
    if (h) {
      if (!h.owner && queue.length) {
        const p = queue.shift()!;
        const r = give(doc, { id: h.id, to: p.id, label: p.label, color: p.color }, ctx);
        changes.push(...(Array.isArray(r) ? r : r.changes));
      }
      return h;
    }
    const p = queue.shift();
    // the player's own hand (made with New hand), if they have one that isn't a side's yet
    const own = p && doc.nodes.find((n) => isHand(n) && n.owner === p.id && !part(n) && !isZone(n));
    if (own) {
      changes.push(set(own.id, FIELD, { role: 'hand', side }));
      return own;
    }
    const at = g.hand(side, HAND_W, emptyHandSize().h);
    const label = p ? p.label.slice(0, 40) : `Hand ${SIDE_NAME[side]}`;
    // nobody to own it (solo): a public group that stays put like a seat (Give to ▸ hands it over)
    const node = groupNode(ctx.newId(), at.x, at.y, nextZ(), { layout: 'fan', pack: LINE, owner: p?.id, label, color: p?.color, spot: !p });
    changes.push({ op: 'add', node: { ...node, [FIELD]: { role: 'hand', side } } });
    return node;
  });
  // gather and shuffle both packs; the troops' top cards go to the hands, alternating
  let k = 0;
  const per = new Map<string, number>();
  const leaving = new Set([...cardsHomedAt(doc, deck.id), ...(tacticsDeckOf(doc) ? cardsHomedAt(doc, tacticsDeckOf(doc)!.id) : [])].map((x) => x.id));
  changes.push(
    ...gatherPack(doc, deck, ctx, () => {
      if (k >= count * hands.length) return;
      const into = hands[k++ % hands.length];
      const order = (per.get(into.id) ?? 0) + 1;
      per.set(into.id, order);
      return { into, order };
    }),
  );
  const tac = tacticsDeckOf(doc);
  if (tac) changes.push(...gatherPack(doc, tac, ctx));
  changes.push(...emptiedGroups(doc, leaving));
  changes.push(...flags(doc).flatMap((n) => claimChanges(doc, n, undefined)));
  for (const n of missingParts(doc, g, ctx, nextZ, mark)) changes.push({ op: 'add', node: n });
  return { changes, select: [] };
};

const tacticsDeckOf = (doc: DocView) => doc.nodes.find((n) => isHomeDeck(n) && packOf(n) === TACTICS);

/** Where a flag stands for a claim (top-left). */
const spotFor = (home: { x: number; y: number }, side?: Side) => ({ x: home.x, y: home.y + (side === 'a' ? CLAIM_DY : side === 'b' ? -CLAIM_DY : 0) });

function claimChanges(doc: DocView, n: CanvasNode, side: Side | undefined): Change[] {
  const f = flag(n);
  const p = spotFor(homeOf(doc, n), side);
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
  return [...fs.flatMap((n) => claimChanges(doc, n, a.side ?? undefined)), ...toFront(doc, fs)];
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
      const home = homeOf(doc, n);
      const dx = n.x - home.x;
      const dy = n.y - home.y;
      if (Math.abs(dx) > COL * 0.75 || Math.abs(dy) > NEAR + FORM_H / 2) return [];
      return claimChanges(doc, n, dy > CLAIM_DY / 2 ? 'a' : dy < -CLAIM_DY / 2 ? 'b' : undefined);
    });
};

/** Who laid tactic cards on a flag (for the tally). */
export const markPlayed: Command<{ ids: string[]; side: Side }> = (doc, a) => {
  if (!isSide(a?.side)) return [];
  return pick(doc, a.ids)
    .filter((c) => isTactic(c) && playedBy(c) !== a.side)
    .map((c) => set(c.id, `${FIELD}.by`, a.side));
};

/** Reset table: flags back on the line, unclaimed. (The cards plugin's reset gathers and shuffles the decks.) */
export const resetAll: Command<Record<string, never>> = (doc) => flags(doc).flatMap((n) => claimChanges(doc, n, undefined));

/** Older tables: formations and the discard pile turn cards face up as they come in; formations get their area. Idempotent. */
export const migrate: Command<Record<string, never>> = (doc) =>
  doc.nodes.flatMap((n) => {
    const out: Change[] = [];
    if (!isPart(n, 'formation') && !isPart(n, 'discard')) return out;
    const f = n[CARDS] as { enter?: string; area?: unknown } | undefined;
    if (f && f.enter === undefined) out.push(set(n.id, C('enter'), 'up'));
    if (f && isPart(n, 'formation') && f.area === undefined) out.push(set(n.id, C('area'), { w: FORM_W, h: FORM_H }));
    return out;
  });

export const commands = { setup, deal, claim, placeFlags, markPlayed, resetAll, migrate };
