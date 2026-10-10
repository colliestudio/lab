import type { CanvasDoc, CanvasNode, DocFilter } from '../../core';
import { FIELD, PACK, cardNode, deckNode, isFace, label, type CardField } from './deck';

// JSON Canvas import repair and export shaping for card nodes.

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Make imported card data safe: drop invalid `x-cards`, convert stage-1 decks (card array inside the
 * deck node) into card nodes, unhook cards from missing decks, drop empty decks.
 */
export const repairImport: DocFilter = (doc, ctx) => {
  const out: CanvasNode[] = [];
  for (const n of doc.nodes) {
    const f = n[FIELD];
    if (f === undefined) {
      out.push(n);
      continue;
    }
    if (!obj(f)) {
      out.push(strip(n));
      continue;
    }
    const pack = typeof f.pack === 'string' ? f.pack : PACK;
    if (Array.isArray(f.stack)) {
      // stage-1 format: { stack: [{face, faceUp}, ...] } bottom first
      const entries = f.stack.filter((c): c is { face: string; faceUp?: unknown } => obj(c) && isFace(c.face));
      if (!entries.length) continue;
      out.push(deckNode(n.id, n.x, n.y, undefined, pack));
      entries.forEach((c, i) =>
        out.push(cardNode(ctx.newId(), n.x, n.y, { face: c.face, faceUp: c.faceUp === true, stack: n.id, order: i + 1 }, undefined, pack)),
      );
      continue;
    }
    if (f.deck === true) {
      out.push({ ...n, [FIELD]: { pack, deck: true } });
      continue;
    }
    if (isFace(f.face)) {
      const c: CardField = { pack, face: f.face, faceUp: f.faceUp === true };
      if (typeof f.stack === 'string') {
        c.stack = f.stack;
        c.order = typeof f.order === 'number' && Number.isFinite(f.order) ? f.order : 0;
      }
      out.push({ ...n, text: n.text ?? label(f.face), [FIELD]: c });
      continue;
    }
    out.push(strip(n));
  }
  // unhook cards whose deck is missing; drop decks without cards
  const decks = new Set(out.filter((n) => obj(n[FIELD]) && (n[FIELD] as any).deck === true).map((n) => n.id));
  const used = new Set<string>();
  for (const n of out) {
    const f = n[FIELD] as CardField | undefined;
    if (!f?.stack) continue;
    if (decks.has(f.stack)) used.add(f.stack);
    else {
      delete f.stack;
      delete f.order;
    }
  }
  return { ...doc, nodes: out.filter((n) => !decks.has(n.id) || used.has(n.id)) };
};

function strip(n: CanvasNode): CanvasNode {
  const { [FIELD]: _drop, ...rest } = n;
  console.warn(`cards: ignoring invalid ${FIELD} on node ${n.id}`);
  return rest as CanvasNode;
}

/**
 * Export: every card stays a node. Cards in a deck sit at the deck's position, just below it in the
 * array, and the deck's text says how many it holds — readable in Obsidian, lossless on re-import.
 */
export const shapeExport: DocFilter = (doc: CanvasDoc) => {
  const byDeck = new Map<string, CanvasNode[]>();
  const deckIds = new Set(doc.nodes.filter((n) => (n[FIELD] as any)?.deck === true).map((n) => n.id));
  const rest: CanvasNode[] = [];
  for (const n of doc.nodes) {
    const s = (n[FIELD] as CardField | undefined)?.stack;
    if (s && deckIds.has(s)) {
      let l = byDeck.get(s);
      if (!l) byDeck.set(s, (l = []));
      l.push(n);
    } else rest.push(n);
  }
  const nodes = rest.flatMap((n) => {
    const cards = byDeck.get(n.id);
    if (!cards) return [n];
    cards.sort((a, b) => ((a[FIELD] as CardField).order ?? 0) - ((b[FIELD] as CardField).order ?? 0));
    return [...cards.map((c) => ({ ...c, x: n.x, y: n.y })), { ...n, text: `Deck: ${cards.length} cards` }];
  });
  return { ...doc, nodes };
};
