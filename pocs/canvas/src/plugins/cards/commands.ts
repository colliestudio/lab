import type { CanvasDoc, CanvasNode, Change, Command } from '../../core';
import { CARD_H, CARD_W, cardField, cardNode, cardsOf, isCard, isStack, pileNode, stackNode, standardDeck, type CardData } from './deck';

// Pure commands: (doc, args, ctx) -> changes. No DOM.

const byId = (doc: CanvasDoc, ids: string[]) => {
  const want = new Set(ids);
  return doc.nodes.filter((n) => want.has(n.id));
};
const isCardish = (n: CanvasNode) => isCard(n) || isStack(n);
const packOf = (n: CanvasNode) => cardField(n)?.pack;

export function shuffled<T>(xs: readonly T[], random: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Flip cards; flipping a stack turns the whole pile over (order reverses). */
export const flip: Command<{ ids: string[] }> = (doc, { ids }) =>
  byId(doc, ids)
    .filter(isCardish)
    .map((n): Change => {
      const cards = cardsOf(n)
        .map((c) => ({ ...c, faceUp: !c.faceUp }))
        .reverse();
      return { op: 'put', node: pileNode(n.id, n.x, n.y, cards, packOf(n)) };
    });

/** Move to an absolute position (x, y) or by (dx, dy). */
export const move: Command<{ ids: string[]; x?: number; y?: number; dx?: number; dy?: number }> = (doc, a) =>
  byId(doc, a.ids).map((n): Change => ({
    op: 'put',
    node: { ...n, x: a.x ?? n.x + (a.dx ?? 0), y: a.y ?? n.y + (a.dy ?? 0) },
  }));

export const shuffle: Command<{ ids: string[] }> = (doc, { ids }, ctx) =>
  byId(doc, ids)
    .filter(isStack)
    .map((n): Change => ({ op: 'put', node: stackNode(n.id, n.x, n.y, shuffled(cardsOf(n), ctx.random), packOf(n)) }));

/**
 * Take the top card off a stack. Lands at (x, y) or in the first free slot to the right of the stack.
 * `faceUp` overrides the card's orientation.
 */
export const draw: Command<{ id: string; faceUp?: boolean; x?: number; y?: number }> = (doc, a, ctx) => {
  const stack = doc.nodes.find((n) => n.id === a.id);
  if (!stack || !isStack(stack)) return [];
  const rest = cardsOf(stack).slice();
  const top = rest.pop()!;
  const changes: Change[] = [];
  if (rest.length === 0) changes.push({ op: 'del', id: stack.id });
  else changes.push({ op: 'put', node: pileNode(stack.id, stack.x, stack.y, rest, packOf(stack)) });

  let x = a.x;
  const y = a.y ?? stack.y;
  if (x === undefined) {
    const step = 32;
    x = stack.x + CARD_W + 24;
    while (doc.nodes.some((n) => n.x === x && n.y === y)) x += step;
  }
  const id = ctx.newId();
  changes.push({ op: 'put', node: cardNode(id, x, y, { ...top, faceUp: a.faceUp ?? top.faceUp }, packOf(stack)) });
  return { changes, select: [id] };
};

/**
 * Gather cards/stacks into one stack at the position of the first id. The first node's cards end up
 * at the bottom, later ones on top. A stack target keeps its id.
 */
export const gather: Command<{ ids: string[]; faceUp?: boolean }> = (doc, a, ctx) => {
  const nodes = a.ids.map((id) => doc.nodes.find((n) => n.id === id)).filter((n): n is CanvasNode => !!n && isCardish(n));
  let cards: CardData[] = nodes.flatMap(cardsOf);
  if (nodes.length < 2 || cards.length < 2) return [];
  if (a.faceUp !== undefined) cards = cards.map((c) => ({ ...c, faceUp: a.faceUp! }));
  const anchor = nodes[0];
  const id = isStack(anchor) ? anchor.id : ctx.newId();
  const changes: Change[] = nodes.filter((n) => n.id !== id).map((n): Change => ({ op: 'del', id: n.id }));
  changes.push({ op: 'put', node: stackNode(id, anchor.x, anchor.y, cards, packOf(anchor)) }, { op: 'front', ids: [id] });
  return { changes, select: [id] };
};

/** Lay a stack out as an overlapping row, bottom card left. */
export const spread: Command<{ id: string; step?: number }> = (doc, a, ctx) => {
  const stack = doc.nodes.find((n) => n.id === a.id);
  if (!stack || !isStack(stack)) return [];
  const step = a.step ?? 30;
  const ids: string[] = [];
  const changes: Change[] = cardsOf(stack).map((c, i): Change => {
    const id = i === 0 ? stack.id : ctx.newId();
    ids.push(id);
    return { op: 'put', node: cardNode(id, stack.x + i * step, stack.y, c, packOf(stack)) };
  });
  return { changes, select: ids };
};

/** A fresh table at (x, y): a shuffled deck, a face-up wave of spades and three cards to flip. */
export const setup: Command<{ x?: number; y?: number }> = (_doc, a, ctx) => {
  const ox = a.x ?? 0;
  const oy = a.y ?? 0;
  const faces = standardDeck();
  const spades = faces.filter((f) => f.endsWith('S'));
  const mystery = ['AH', 'AD', 'AC'];
  const rest = shuffled(
    faces.filter((f) => !f.endsWith('S') && !mystery.includes(f)),
    ctx.random,
  );
  const changes: Change[] = [];
  changes.push({ op: 'put', node: stackNode(ctx.newId(), ox, oy, rest.map((face) => ({ face, faceUp: false }))) });
  spades.forEach((face, i) => {
    const x = ox + 200 + i * 62;
    const y = oy - 30 + Math.round(Math.sin((i / (spades.length - 1)) * Math.PI) * -70);
    changes.push({ op: 'put', node: cardNode(ctx.newId(), x, y, { face, faceUp: true }) });
  });
  mystery.forEach((face, i) => {
    changes.push({ op: 'put', node: cardNode(ctx.newId(), ox + 340 + i * (CARD_W + 40), oy + CARD_H + 60, { face, faceUp: false }) });
  });
  return changes;
};

export const commands = { flip, move, shuffle, draw, gather, spread, setup };
