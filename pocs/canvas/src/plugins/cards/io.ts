import type { CanvasDoc, CanvasNode, DocFilter } from '../../core';
import { FIELD, LAYOUTS, PACK, cardNode, deckNode, faceLabel, type CardField, type DeckField } from './deck';
import { isPackFace } from './packs';

// JSON Canvas import repair and export shaping for card nodes.

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Make imported card data safe: drop invalid `x-cards`, convert stage-1 decks (card array inside the
 * deck node) into card nodes, unhook cards from missing decks, drop empty decks (empty hands stay).
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
      const entries = f.stack.filter((c): c is { face: string; faceUp?: unknown } => obj(c) && isPackFace(pack, c.face));
      if (!entries.length) continue;
      out.push(deckNode(n.id, n.x, n.y, undefined, pack));
      entries.forEach((c, i) =>
        out.push(cardNode(ctx.newId(), n.x, n.y, { face: c.face, faceUp: c.faceUp === true, stack: n.id, order: i + 1, home: n.id }, undefined, pack)),
      );
      continue;
    }
    if (f.deck === true) {
      const d: DeckField = { pack, deck: true };
      if (f.home === true) d.home = true;
      else {
        if (typeof f.layout === 'string' && (LAYOUTS as string[]).includes(f.layout) && f.layout !== 'stack') d.layout = f.layout as DeckField['layout'];
        // stage-2 hands (`hand: true`) are owned groups now
        if (f.hand === true && typeof n.owner === 'string') d.layout ??= 'fan';
      }
      if (typeof f.color === 'string' && /^#[0-9a-f]{6}$/i.test(f.color)) d.color = f.color;
      out.push({ ...n, [FIELD]: d });
      continue;
    }
    if (isPackFace(pack, f.face)) {
      const c: CardField = { pack, face: f.face, faceUp: f.faceUp === true };
      if (typeof f.stack === 'string') {
        c.stack = f.stack;
        c.order = typeof f.order === 'number' && Number.isFinite(f.order) ? f.order : 0;
      }
      if (typeof f.home === 'string') c.home = f.home;
      out.push({ ...n, text: n.text ?? faceLabel(pack, f.face), [FIELD]: c });
      continue;
    }
    out.push(strip(n));
  }
  // unhook cards whose deck is missing; drop decks that hold no cards and are nobody's home
  const decks = new Set(out.filter((n) => obj(n[FIELD]) && (n[FIELD] as any).deck === true).map((n) => n.id));
  const used = new Set<string>();
  for (const n of out) {
    const f = n[FIELD] as CardField | undefined;
    if (f?.home && decks.has(f.home)) used.add(f.home);
    if (!f?.stack) continue;
    if (decks.has(f.stack)) used.add(f.stack);
    else {
      delete f.stack;
      delete f.order;
    }
  }
  // an empty hand (a group with an owner) is a player's seat: keep it (Reset empties hands)
  const hand = (n: CanvasNode) => typeof n.owner === 'string' && !!n.owner;
  return { ...doc, nodes: out.filter((n) => !decks.has(n.id) || used.has(n.id) || hand(n)) };
};

function strip(n: CanvasNode): CanvasNode {
  const { [FIELD]: _drop, ...rest } = n;
  console.warn(`cards: ignoring invalid ${FIELD} on node ${n.id}`);
  return rest as CanvasNode;
}

/**
 * Export: every card stays a node and every container becomes a JSON Canvas `group` (with a label)
 * sized to its layout. Cards in a pile sit at the pile's position, just below it in the array; cards
 * in a group or hand are already at their laid-out spots, listed after it so Obsidian shows them on
 * top. Lossless on re-import.
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
    if (!deckIds.has(n.id)) return [n];
    const cards = byDeck.get(n.id) ?? [];
    cards.sort((a, b) => ((a[FIELD] as CardField).order ?? 0) - ((b[FIELD] as CardField).order ?? 0));
    const f = n[FIELD] as DeckField;
    const spread = f.layout && f.layout !== 'stack';
    const owned = !f.home && typeof n.owner === 'string' && !!n.owner;
    const name = f.home ? 'Deck' : owned ? (n.label ?? 'Hand') : spread ? 'Group' : 'Pile';
    const { text: _t, ...rest } = n;
    const group = { ...rest, type: 'group', label: owned ? name : `${name}: ${cards.length} card${cards.length === 1 ? '' : 's'}` };
    return spread ? [group, ...cards] : [...cards.map((c) => ({ ...c, x: n.x, y: n.y })), group];
  });
  return { ...doc, nodes };
};
