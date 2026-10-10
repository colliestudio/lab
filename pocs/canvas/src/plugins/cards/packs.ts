// Deck packs are data: a pack = its cards (face code + readable label, in sort order) plus how a
// face and a back look. The cards plugin only knows packs through this registry; standard-52 is
// one registered pack (see standard.ts) and other plugins add theirs (Battle Line troops/tactics).

export interface PackCard {
  /** Face code stored on the card node (`x-cards.face`), unique within the pack. */
  face: string;
  /** Readable text, e.g. "10♥", "Red 7": the card node's `text` in JSON Canvas files. */
  label: string;
}

export interface Pack {
  id: string;
  name: string;
  /** Every card of the pack, in sort order (Sort uses this order). */
  cards: PackCard[];
  /** HTML of a face-up card: one `.pc-card` element filling the node box. */
  face(face: string): string;
  /** HTML of a face-down card; default: the standard back. */
  back?: string;
  /** What its home deck's tab says (default "Deck"), e.g. "Troops". */
  deckName?: string;
}

const packs = new Map<string, Pack>();
const index = new Map<string, Map<string, number>>();

/** Add (or replace) a pack. Plugins call this at import time. */
export function registerPack(p: Pack) {
  packs.set(p.id, p);
  index.set(p.id, new Map(p.cards.map((c, i) => [c.face, i])));
}

export const getPack = (id: string): Pack | undefined => packs.get(id);

/** Face codes of a pack, in sort order (empty if unknown). */
export const packFaces = (id: string): string[] => packs.get(id)?.cards.map((c) => c.face) ?? [];

/** A face of a registered pack; for an unknown pack (plugin not loaded) any non-empty string. */
export function isPackFace(pack: string, face: unknown): face is string {
  if (typeof face !== 'string' || !face) return false;
  const i = index.get(pack);
  return i ? i.has(face) : true;
}

/** Readable label of a face, if its pack is registered. */
export const packLabel = (pack: string, face: string): string | undefined => {
  const i = index.get(pack)?.get(face);
  return i === undefined ? undefined : packs.get(pack)!.cards[i].label;
};

/** Position in the pack's sort order, if known. */
export const packOrder = (pack: string, face: string): number | undefined => index.get(pack)?.get(face);
