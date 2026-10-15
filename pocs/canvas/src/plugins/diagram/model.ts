import type { CanvasNode } from '../../core';

// Diagram shapes are JSON Canvas `text` nodes: `text` holds the words (Obsidian shows a plain text
// card) and `x-shape` holds the look. Arrows are core edges (see core/edges.ts).

export type ShapeKind = 'rect' | 'ellipse' | 'diamond' | 'text' | 'sticky';
export const KINDS: readonly ShapeKind[] = ['rect', 'ellipse', 'diamond', 'text', 'sticky'];

export interface ShapeStyle {
  kind: ShapeKind;
  /** Outline color (CSS color). */
  stroke?: string;
  /** Fill color (CSS color); "none" = see through. */
  fill?: string;
  dashed?: boolean;
  /** Text size in px. */
  size?: number;
}

export const isKind = (v: unknown): v is ShapeKind => KINDS.includes(v as ShapeKind);

export function shapeOf(n: CanvasNode | undefined): ShapeStyle | undefined {
  const s = n?.['x-shape'] as ShapeStyle | undefined;
  return n?.type === 'text' && s && isKind(s.kind) ? s : undefined;
}
export const isShape = (n: CanvasNode) => !!shapeOf(n);

export const DEFAULT_SIZE: Record<ShapeKind, { w: number; h: number }> = {
  rect: { w: 160, h: 80 },
  ellipse: { w: 160, h: 90 },
  diamond: { w: 170, h: 110 },
  text: { w: 80, h: 32 },
  sticky: { w: 170, h: 130 },
};
export const MIN_SIZE = 24;

export const INK = '#1e1e1e';
export const DEFAULT_FILL: Record<ShapeKind, string> = { rect: '#ffffff', ellipse: '#ffffff', diamond: '#ffffff', text: 'none', sticky: '#ffec99' };

export const STROKES = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5'];
export const FILLS = ['none', '#ffffff', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#eebefa'];
export const TEXT_SIZES: { label: string; px: number }[] = [
  { label: 'S', px: 14 },
  { label: 'M', px: 18 },
  { label: 'L', px: 24 },
  { label: 'XL', px: 32 },
];
export const DEFAULT_TEXT_SIZE = 18;

export const fillOf = (s: ShapeStyle) => s.fill ?? DEFAULT_FILL[s.kind];
export const strokeOf = (s: ShapeStyle) => s.stroke ?? INK;
export const sizeOf = (s: ShapeStyle) => s.size ?? DEFAULT_TEXT_SIZE;

/** Rough box for some text (no DOM, so agents and tests get the same answer): keeps a text shape snug. */
export function textBox(text: string, size: number): { w: number; h: number } {
  const lines = (text || ' ').split('\n');
  const longest = Math.max(...lines.map((l) => l.length), 2);
  return { w: Math.max(MIN_SIZE, Math.ceil(longest * size * 0.58 + 12)), h: Math.max(MIN_SIZE, Math.ceil(lines.length * size * 1.3 + 8)) };
}

export const nameOf = (n: CanvasNode | undefined) => {
  const s = (n?.text ?? '').split('\n')[0].trim();
  return s ? `“${s.length > 30 ? s.slice(0, 29) + '…' : s}”` : 'a shape';
};
