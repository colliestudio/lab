import { canvasColor, type CanvasNode } from '../../core';
import { fillOf, shapeOf, sizeOf, strokeOf, type ShapeKind } from './model';

const SVG = 'http://www.w3.org/2000/svg';

/** What a shape's look depends on (everything but its words). */
export const styleKey = (n: CanvasNode) => JSON.stringify([n['x-shape'], n.width, n.height]);

/** Draw a shape into its node box: the outline (CSS, or an SVG for a diamond) and the text on top. */
export function renderShape(n: CanvasNode, el: HTMLElement) {
  const s = shapeOf(n)!;
  const kind: ShapeKind = s.kind;
  const wrap = document.createElement('div');
  wrap.className = `dg-shape dg-k-${kind}${s.dashed ? ' dg-dashed' : ''}`;
  const fill = fillOf(s);
  // an unset stroke is the board's ink, unless the shape has a (light) fill of its own to sit on
  wrap.style.setProperty('--dg-stroke', s.stroke === undefined && fill === 'none' ? 'var(--cv-ink)' : canvasColor(strokeOf(s))!);
  wrap.style.setProperty('--dg-fill', fill === 'none' ? 'transparent' : canvasColor(fill)!);
  wrap.style.setProperty('--dg-size', `${sizeOf(s)}px`);
  if (kind === 'diamond') {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'dg-svg');
    svg.setAttribute('viewBox', `0 0 ${n.width} ${n.height}`);
    const poly = document.createElementNS(SVG, 'polygon');
    const w = n.width;
    const h = n.height;
    poly.setAttribute('points', `${w / 2},1.5 ${w - 1.5},${h / 2} ${w / 2},${h - 1.5} 1.5,${h / 2}`);
    svg.append(poly);
    wrap.append(svg);
  }
  const box = document.createElement('div');
  box.className = 'dg-text-box';
  const text = document.createElement('div');
  text.className = 'dg-text';
  text.textContent = n.text ?? '';
  box.append(text);
  wrap.append(box);
  el.replaceChildren(wrap);
}
