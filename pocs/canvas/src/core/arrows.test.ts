import { describe, expect, it } from 'vitest';
import { anchor, edgeGeometry, edgeSides, isStyled, sideToward } from './edges';

const a = { x: 0, y: 0, w: 100, h: 60 };
const b = { x: 300, y: 0, w: 100, h: 60 };
const e = (extra: object = {}) => ({ id: 'e', fromNode: 'a', toNode: 'b', 'x-edge': {}, ...extra });

describe('arrow geometry', () => {
  it('anchors sit at the middle of a side', () => {
    expect(anchor(a, 'right')).toEqual({ x: 100, y: 30 });
    expect(anchor(a, 'top')).toEqual({ x: 50, y: 0 });
  });

  it('picks the side facing the other end', () => {
    expect(sideToward(a, { x: 500, y: 30 })).toBe('right');
    expect(sideToward(a, { x: 50, y: -400 })).toBe('top');
    expect(edgeSides(a, b)).toEqual(['right', 'left']);
    expect(edgeSides(a, { ...b, x: 0, y: 300 })).toEqual(['bottom', 'top']);
    // a named side stays; the other end faces it
    expect(edgeSides(a, b, 'bottom')).toEqual(['bottom', 'left']);
    expect(edgeSides(a, b, undefined, 'top')).toEqual(['right', 'top']);
  });

  it('a straight arrow runs side to side and ends pointing along its path', () => {
    const g = edgeGeometry(e(), a, b);
    expect(g.d).toBe('M100,30 L300,30');
    expect(g.mid).toEqual({ x: 200, y: 30 });
    expect(g.angleTo).toBeCloseTo(0);
    expect(g.angleFrom).toBeCloseTo(Math.PI);
  });

  it('a curved arrow leaves and arrives square to the sides', () => {
    const g = edgeGeometry(e({ fromSide: 'bottom', toSide: 'bottom', 'x-edge': { curve: true } }), a, b);
    expect(g.d.startsWith('M50,60 C')).toBe(true);
    // arrives going upward into the bottom side
    expect(g.angleTo).toBeCloseTo(-Math.PI / 2);
  });

  it('only edges with x-edge are styled (board and prototype edges keep their look)', () => {
    expect(isStyled(e())).toBe(true);
    expect(isStyled({ id: 'x', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left' })).toBe(false);
  });
});
