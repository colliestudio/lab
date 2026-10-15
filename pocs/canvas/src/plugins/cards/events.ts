import { count } from '../../core/log';
import type { CanvasNode, DocView, EventSpec } from '../../core';
import { card, cardsIn, faceLabel, handOf, hiddenFrom, hidesCount, isDeck, isHand, isHomeDeck, isSpot, isStacked, packOf, shownIn } from './deck';
import { getPack } from './packs';

// What the cards plugin logs, and how it keeps faces out of texts a viewer couldn't see. Texts are
// built from the doc after the change (`after`), sometimes also before it (a card that was face up
// on the table is no secret once it's in a hand). Plain rearranging (moving, grouping, sorting) isn't logged.

type Private = NonNullable<EventSpec['private']>;

export const cardName = (c: CanvasNode) => faceLabel(packOf(c), card(c).face);

/** Does everyone see this card's face in `doc`? (Face up and not in a hand unless shown there; in a pile only the top one.) */
export function isPublic(doc: DocView, c: CanvasNode | undefined): boolean {
  if (!c) return false;
  const p = doc.parentOf(c.id);
  const box = p ? doc.get(p) : undefined;
  if (box && isHand(box)) return shownIn(box, c);
  if (!card(c).faceUp) return false;
  if (box && isStacked(box)) return cardsIn(doc, box.id).at(-1)?.id === c.id;
  return true;
}

/** Does `viewer` see this card's face in `doc` (public, or their own hand's card)? */
const seenBy = (doc: DocView, c: CanvasNode | undefined, viewer: string) => !!c && (isPublic(doc, c) || (!!handOf(doc, c) && !hiddenFrom(doc, c, viewer)));

/** "7♥", "7♥, K♠", "7♥ and 2 more", "3 cards" (no names past `max`). */
export function cardsText(cards: CanvasNode[], named: (c: CanvasNode) => boolean, max = 6): string {
  const shown = cards.filter(named);
  if (!shown.length || shown.length > max) return count(cards.length, 'card');
  const rest = cards.length - shown.length;
  const names = shown.map(cardName).join(', ');
  return rest ? `${names} and ${rest} more` : names;
}

/** "the deck", "the Troops", "Discard", "Alice's hand", "a pile", "a group". */
export function boxName(box: CanvasNode): string {
  if (isHand(box)) return box.label ?? 'a hand';
  if (isSpot(box) && box.label) return box.label;
  if (isHomeDeck(box)) return `the ${getPack(packOf(box))?.deckName ?? 'deck'}`;
  return isStacked(box) ? 'a pile' : 'a group';
}

/**
 * Variants for players who see more of `cards` than everyone (the hands' owners, before or after):
 * `text(named)` with their own view. Only where it differs from `pub`.
 */
function privateFor(owners: (string | undefined)[], before: DocView, after: DocView, ids: string[], text: (named: (c: CanvasNode) => boolean) => string, pub: string): Private {
  const out: Private = [];
  for (const o of new Set(owners.filter((x): x is string => !!x))) {
    const t = text((c) => seenBy(before, before.get(c.id), o) || seenBy(after, after.get(c.id), o));
    if (t !== pub && ids.length) out.push({ to: [o], text: t });
  }
  return out;
}

const ev = (type: string, text: string, targets: string[], extra: Partial<EventSpec> = {}): EventSpec => ({ type: `cards.${type}`, text, targets, ...extra });

/** Cards that `ids` (cards, or containers: their cards) stand for in `doc`. */
export const cardsOf = (doc: DocView, ids: string[]) => ids.flatMap((id) => {
  const n = doc.get(id);
  return !n ? [] : isDeck(n) ? cardsIn(doc, n.id) : [n];
});

/**
 * Cards moved by a drop or a pull-out (`ids` as of `before`). Logged: into a table spot (a zone, a
 * formation, the discard), into a hand, onto a pile, out of a hand, shown / hidden within a hand.
 * Not logged: rearranging on the table, in a group or in your own hand.
 */
export function moveEvents(before: DocView, after: DocView, ids: string[]): EventSpec[] {
  const groups = new Map<string, { kind: 'spot' | 'hand' | 'pile' | 'table' | 'show' | 'hide'; dest?: CanvasNode; from: CanvasNode[]; cards: CanvasNode[] }>();
  for (const c0 of cardsOf(before, ids)) {
    const c = after.get(c0.id);
    if (!c) continue;
    const fromId = before.parentOf(c0.id);
    const toId = after.parentOf(c.id);
    const fromBox = fromId ? before.get(fromId) : undefined;
    const dest = toId ? after.get(toId) : undefined;
    const fromHand = fromBox && isHand(fromBox) ? fromBox : undefined;
    let kind: 'spot' | 'hand' | 'pile' | 'table' | 'show' | 'hide' | undefined;
    if (fromId && fromId === toId) {
      if (fromHand && dest && isHand(dest) && shownIn(fromHand, c0) !== shownIn(dest, c)) kind = shownIn(dest, c) ? 'show' : 'hide';
    } else if (dest && isSpot(dest) && !isHand(dest)) kind = 'spot';
    else if (dest && isHand(dest)) kind = 'hand';
    else if (dest && isStacked(dest)) kind = 'pile';
    else if (fromHand) kind = 'table';
    if (!kind) continue;
    const key = `${kind}:${dest?.id ?? ''}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { kind, dest, from: [], cards: [] }));
    g.cards.push(c);
    if (fromBox && !g.from.some((f) => f.id === fromBox.id)) g.from.push(fromBox);
  }
  const out: EventSpec[] = [];
  for (const g of groups.values()) {
    const cs = g.cards;
    const ids = cs.map((c) => c.id);
    const owners = [...g.from.filter(isHand).map((h) => h.owner), g.dest && isHand(g.dest) ? g.dest.owner : undefined];
    const wasOrIs = (c: CanvasNode) => isPublic(before, before.get(c.id)) || isPublic(after, c);
    let text: (named: (c: CanvasNode) => boolean) => string;
    let pubNamed: (c: CanvasNode) => boolean;
    let targets = ids;
    let key: string | undefined;
    const dest = g.dest;
    switch (g.kind) {
      case 'spot':
        text = (named) => `played ${cardsText(cs, named)} to ${boxName(dest!)}`;
        pubNamed = (c) => isPublic(after, c);
        targets = [...ids, dest!.id];
        break;
      case 'hand':
        // named only if everyone saw it before (face up on the table)
        text = (named) => `put ${cardsText(cs, named)} into ${boxName(dest!)}`;
        pubNamed = (c) => isPublic(before, before.get(c.id));
        targets = [dest!.id];
        if (cs.length === 1) key = `card:${cs[0].id}`; // a draw dragged straight into the hand was told already
        break;
      case 'pile':
        text = (named) => `put ${cardsText(cs, named)} on ${boxName(dest!)}`;
        pubNamed = wasOrIs;
        targets = [dest!.id];
        break;
      case 'table':
        text = (named) => `played ${cardsText(cs, named)} to the table${cs.every((c) => !card(c).faceUp) ? ' face down' : ''}`;
        pubNamed = (c) => isPublic(after, c);
        break;
      case 'show':
        text = (named) => `showed ${cardsText(cs, named)} to the table`;
        pubNamed = (c) => isPublic(after, c);
        targets = [dest!.id];
        break;
      case 'hide':
        text = (named) => `took ${cardsText(cs, named)} back from the table`;
        pubNamed = (c) => isPublic(before, before.get(c.id));
        targets = [dest!.id];
        break;
    }
    const pub = text(pubNamed);
    const priv = privateFor(owners, before, after, ids, text, pub);
    out.push(ev(g.kind === 'show' || g.kind === 'hide' ? g.kind : g.kind === 'hand' ? 'toHand' : 'play', pub, targets, { private: priv.length ? priv : undefined, key, cue: 'pulse' }));
  }
  return out;
}

export function shuffleEvents(decks: CanvasNode[]): EventSpec[] {
  return decks.map((d) => ev('shuffle', `shuffled ${boxName(d)}`, [d.id], { cue: 'shuffle' }));
}

/** Drew the top card of `deck` onto the table. */
export function drawEvent(deck: CanvasNode, top: CanvasNode, after: DocView): EventSpec {
  const c = after.get(top.id) ?? top;
  return ev('draw', `drew ${isPublic(after, c) ? cardName(c) : 'a card'} from ${boxName(deck)}`, [deck.id, top.id], { cue: 'pulse', key: `card:${top.id}` });
}

export function dealEvent(deck: CanvasNode, dealt: CanvasNode[], after: DocView): EventSpec {
  const cs = dealt.map((c) => after.get(c.id) ?? c);
  const up = cs.filter((c) => isPublic(after, c));
  const names = up.length && up.length <= 7 ? `: ${cardsText(cs, (c) => isPublic(after, c), 7)}` : '';
  return ev('deal', `dealt ${count(cs.length, 'card')}${names} from ${boxName(deck)}`, [deck.id, ...cs.map((c) => c.id)], { cue: 'deal' });
}

/** Dealt to players' hands: "dealt 13 to each of 2 players" (uneven: "dealt 25 cards to 2 players"). */
export function dealHandsEvent(deck: CanvasNode, hands: CanvasNode[], counts: number[]): EventSpec {
  const total = counts.reduce((a, b) => a + b, 0);
  const n = hands.length;
  const text =
    n === 1 ? `dealt ${count(total, 'card')} to ${hands[0].label ?? 'a hand'}` : counts.every((k) => k === counts[0]) ? `dealt ${counts[0]} to each of ${n} players` : `dealt ${total} cards to ${n} players`;
  return ev('dealHands', text, [deck.id, ...hands.map((h) => h.id)], { cue: 'deal' });
}

/** Cards (not in hands) turned face up or down; piles turned over. Private flips in a blind hand aren't logged. */
export function facingEvents(before: DocView, after: DocView, ids: string[]): EventSpec[] {
  const out: EventSpec[] = [];
  const up: CanvasNode[] = [];
  const down: CanvasNode[] = [];
  for (const id of ids) {
    const n = before.get(id);
    if (!n) continue;
    if (isDeck(n)) {
      if (isHand(n)) continue;
      const cs = cardsIn(before, n.id).filter((c) => card(c).faceUp !== card(after.get(c.id) ?? c).faceUp);
      if (!cs.length) continue;
      if (isStacked(n)) {
        const top = cardsIn(after, n.id).at(-1);
        out.push(ev('flip', `turned over ${boxName(n)}${top && isPublic(after, top) ? `: ${cardName(top)} on top` : ''}`, [n.id], { cue: 'pulse' }));
      } else for (const c of cs) (card(after.get(c.id)!).faceUp ? up : down).push(after.get(c.id)!);
      continue;
    }
    const c = after.get(id);
    if (!c || handOf(before, n) || card(n).faceUp === card(c).faceUp) continue;
    (card(c).faceUp ? up : down).push(c);
  }
  if (up.length) out.push(ev('flip', `turned up ${cardsText(up, (c) => isPublic(after, c), 8)}`, up.map((c) => c.id), { cue: 'pulse' }));
  if (down.length) out.push(ev('flip', `turned ${cardsText(down, (c) => isPublic(before, before.get(c.id)), 8)} face down`, down.map((c) => c.id), { cue: 'pulse' }));
  return out;
}

/** Hand cards shown to the table / taken back (by its owner). */
export function showEvents(before: DocView, after: DocView): EventSpec[] {
  const shown = new Map<string, CanvasNode[]>();
  const hidden = new Map<string, CanvasNode[]>();
  for (const c of after.nodes) {
    const h = handOf(after, c);
    const was = before.get(c.id);
    const h0 = was && handOf(before, was);
    if (!h || !h0 || h.id !== h0.id) continue;
    const now = shownIn(h, c);
    if (now === shownIn(h0, was!)) continue;
    const m = now ? shown : hidden;
    m.set(h.id, [...(m.get(h.id) ?? []), now ? c : was!]);
  }
  const out: EventSpec[] = [];
  for (const [h, cs] of shown) out.push(ev('show', `showed ${cardsText(cs, () => true, 8)} to the table`, [h], { cue: 'pulse' }));
  for (const [h, cs] of hidden) out.push(ev('hide', `took ${cardsText(cs, () => true, 8)} back from the table`, [h]));
  return out;
}

/** Recall: never a count when cards came out of a hand that hides its count. */
export function recallEvent(before: DocView, deck: CanvasNode, moved: CanvasNode[]): EventSpec {
  const secret = moved.some((c) => {
    const h = handOf(before, c);
    return !!h && hidesCount(h);
  });
  return ev('recall', `gathered ${secret ? 'all cards' : count(moved.length, 'card')} back into ${boxName(deck)}`, [deck.id], { cue: 'pulse' });
}

/** Put a container's cards on the table (they keep their facing): names what everyone now sees. */
export function putOnTableEvent(before: DocView, after: DocView, box: CanvasNode, cards: CanvasNode[]): EventSpec {
  const cs = cards.map((c) => after.get(c.id) ?? c);
  const ids = cs.map((c) => c.id);
  const text = (named: (c: CanvasNode) => boolean) => `put ${boxName(box)} on the table: ${cardsText(cs, named, 10)}`;
  const pub = text((c) => isPublic(after, c));
  const priv = privateFor([isHand(box) ? box.owner : undefined], before, after, ids, text, pub);
  return ev('putOnTable', pub, ids, { private: priv.length ? priv : undefined, cue: 'pulse' });
}

export function showdownEvent(after: DocView, hands: CanvasNode[], cardsBy: Map<string, CanvasNode[]>): EventSpec {
  const parts = hands.map((h) => {
    const cs = (cardsBy.get(h.id) ?? []).map((c) => after.get(c.id) ?? c);
    return `${h.label ?? 'a hand'} ${cs.length ? cardsText(cs, (c) => isPublic(after, c), 12) : '(empty)'}`;
  });
  return ev('showdown', `put every hand on the table, face up: ${parts.join('; ')}`, [...cardsBy.values()].flat().map((c) => c.id), { cue: 'pulse' });
}

export function giveEvent(box: CanvasNode, to: string | null, label?: string): EventSpec {
  const who = label?.replace(/['’]s hand$/, '');
  return ev('give', to === null ? `made ${boxName(box)} a public group` : `gave ${boxName(box)} to ${who || 'another player'}`, [box.id], { cue: 'pulse' });
}
