import type { CanvasNode } from '../../core';
import { CARD_H, CARD_W } from '../cards/deck';
import { COLUMN_STEP, PAD } from '../cards/layout';

// Battle Line (Reiner Knizia) for free play: two card packs on top of the cards plugin, nine flag
// tokens, and a table layout of slot areas. No rules engine: players move things, like at a table.

export const FIELD = 'x-battleline';
export const TROOPS = 'battleline-troops';
export const TACTICS = 'battleline-tactics';
/** Pack id of the line's own containers (formations, discard): no cards carry it. */
export const LINE = 'battleline';

export const COLORS = [
  { code: 'r', name: 'Red', hex: '#d23b3b' },
  { code: 'o', name: 'Orange', hex: '#ef8424' },
  { code: 'y', name: 'Yellow', hex: '#efc12c' },
  { code: 'g', name: 'Green', hex: '#3a9d4f' },
  { code: 'b', name: 'Blue', hex: '#2f6fdb' },
  { code: 'p', name: 'Purple', hex: '#8a4bd1' },
] as const;
export const UNITS = ['Skirmishers', 'Peltasts', 'Javelineers', 'Hoplites', 'Phalangists', 'Hypaspists', 'Light cavalry', 'Heavy cavalry', 'Chariots', 'Elephants'];

/** Troop face codes: color letter + value, e.g. "r7", "p10". */
export const troopFaces = () => COLORS.flatMap((c) => UNITS.map((_, i) => `${c.code}${i + 1}`));
export function parseTroop(face: string) {
  const c = COLORS.find((x) => x.code === face[0]);
  const v = Number(face.slice(1));
  return c && v >= 1 && v <= 10 ? { color: c, value: v } : undefined;
}

export type TacticKind = 'Leader' | 'Morale' | 'Environment' | 'Guile';
export const TACTICS_CARDS: { face: string; name: string; kind: TacticKind; text: string }[] = [
  { face: 'alexander', name: 'Alexander', kind: 'Leader', text: 'Wild troop: play it as any color and any value. Only one leader per side.' },
  { face: 'darius', name: 'Darius', kind: 'Leader', text: 'Wild troop: play it as any color and any value. Only one leader per side.' },
  { face: 'companion', name: 'Companion Cavalry', kind: 'Morale', text: 'Counts as an 8 in whatever color you need.' },
  { face: 'shield', name: 'Shield Bearers', kind: 'Morale', text: 'Counts as a 1, 2 or 3 in whatever color you need.' },
  { face: 'fog', name: 'Fog', kind: 'Environment', text: 'Lay it on a flag: formations there no longer count, only the highest total wins.' },
  { face: 'mud', name: 'Mud', kind: 'Environment', text: 'Lay it on a flag: both sides need four cards there instead of three.' },
  { face: 'scout', name: 'Scout', kind: 'Guile', text: 'Draw three cards from the decks in any mix, then put two from your hand back on top.' },
  { face: 'redeploy', name: 'Redeploy', kind: 'Guile', text: 'Move one of your cards from an unclaimed flag to another of your slots, or discard it.' },
  { face: 'deserter', name: 'Deserter', kind: 'Guile', text: 'Discard any one card your opponent has at an unclaimed flag.' },
  { face: 'traitor', name: 'Traitor', kind: 'Guile', text: 'Take a troop from your opponent’s side of an unclaimed flag and play it on yours.' },
];
export const tactic = (face: string) => TACTICS_CARDS.find((t) => t.face === face);

export const troopLabel = (face: string) => {
  const t = parseTroop(face);
  return t ? `${t.color.name} ${t.value}` : face;
};
export const tacticLabel = (face: string) => `Tactic: ${tactic(face)?.name ?? face}`;

// --- objects -------------------------------------------------------------------------------

export type Side = 'a' | 'b';
export const SIDES: Side[] = ['a', 'b'];
/** Side a sits below the line (cards cascade down), side b above it (cards cascade up). */
export const SIDE_NAME: Record<Side, string> = { a: 'A', b: 'B' };
export const SIDE_COLOR: Record<Side, string> = { a: '#2f6fdb', b: '#c8402e' };

export interface FlagField {
  kind: 'flag';
  /** 1..9, left to right. */
  n: number;
  /** Unclaimed spot (top-left), where Reset puts it back. */
  hx: number;
  hy: number;
  claim?: Side;
}
/** Marks the line's card containers: a formation (per flag and side), a player's hand, the discard pile. */
export interface PartField {
  role: 'formation' | 'hand' | 'discard' | 'troops' | 'tactics';
  flag?: number;
  side?: Side;
}

const field = (n: CanvasNode | undefined) => n?.[FIELD] as Record<string, unknown> | undefined;
export const isFlag = (n: CanvasNode | undefined): boolean => field(n)?.kind === 'flag';
export const flag = (n: CanvasNode) => n[FIELD] as FlagField;
export const part = (n: CanvasNode) => field(n) as PartField | undefined;
export const isPart = (n: CanvasNode | undefined, role: PartField['role']) => field(n)?.role === role;
export const flagText = (f: FlagField) => `Flag ${f.n}${f.claim ? ` (claimed by ${SIDE_NAME[f.claim]})` : ''}`;

// --- geometry ------------------------------------------------------------------------------

export const FLAG_W = 76;
export const FLAG_H = 100;
/** How far a claimed flag sits toward its side. */
export const CLAIM_DY = 76;
export const FORM_W = CARD_W + 2 * PAD;
/** A formation is sized for four cards (Mud); three slots are outlined. */
export const FORM_H = 2 * PAD + CARD_H + 3 * COLUMN_STEP;
export const COL = FORM_W + 18;
/** Gap between the line's middle and a formation's near edge (room for a claimed flag). */
export const NEAR = FLAG_H / 2 + CLAIM_DY + 30;

/** Where everything goes for a line centered at (cx, cy). */
export function geometry(cx: number, cy: number) {
  const colX = (i: number) => Math.round(cx + (i - 4) * COL); // column center, i = 0..8
  const left = colX(0) - FORM_W / 2;
  const right = colX(8) + FORM_W / 2;
  return {
    flag: (i: number) => ({ x: colX(i) - FLAG_W / 2, y: Math.round(cy - FLAG_H / 2) }),
    formation: (i: number, side: Side) => ({ x: colX(i) - FORM_W / 2, y: side === 'a' ? cy + NEAR : cy - NEAR - FORM_H }),
    troops: { x: left - 60 - CARD_W, y: cy - CARD_H - 40 },
    tactics: { x: left - 60 - CARD_W, y: cy + 40 },
    discard: { x: right + 60, y: Math.round(cy - CARD_H / 2) },
    /** A hand's top-left: below side a's formations, above side b's. */
    hand: (side: Side, w: number, h: number) => ({ x: Math.round(cx - w / 2), y: side === 'a' ? cy + NEAR + FORM_H + 50 : cy - NEAR - FORM_H - 50 - h }),
  };
}
