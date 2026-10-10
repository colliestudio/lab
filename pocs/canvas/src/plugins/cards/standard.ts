import { PACK, RANKS, label, type Suit } from './deck';
import { registerPack } from './packs';
import { STANDARD_BACK, standardFaceHtml } from './render';

// The standard 52-card pack as registered data. Sort order: suits alternate colors (♠ ♥ ♣ ♦), A..K.
const SUIT_ORDER: Suit[] = ['S', 'H', 'C', 'D'];

registerPack({
  id: PACK,
  name: 'Standard 52',
  cards: SUIT_ORDER.flatMap((s) => RANKS.map((r) => ({ face: r + s, label: label(r + s) }))),
  face: standardFaceHtml,
  back: STANDARD_BACK,
  cols: 13,
});


