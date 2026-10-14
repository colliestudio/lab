import { describe, expect, it } from 'vitest';
import { Viewport, nextStep, wheelZoomFactor } from './viewport';

describe('viewport', () => {
  it('zoomAt keeps the screen point fixed and clamps to 10%–400%', () => {
    const v = new Viewport();
    v.set(100, 50, 1);
    const before = v.toWorld(300, 200);
    v.zoomAt(300, 200, 2);
    expect(v.toWorld(300, 200)).toEqual(before);
    v.zoomAt(0, 0, 100);
    expect(v.zoom).toBe(4);
    v.zoomAt(0, 0, 1e-6);
    expect(v.zoom).toBe(0.1);
  });
  it('steps through fixed levels from any zoom', () => {
    expect(nextStep(1, 1)).toBe(1.25);
    expect(nextStep(1, -1)).toBe(0.8);
    expect(nextStep(0.9, 1)).toBe(1);
    expect(nextStep(0.9, -1)).toBe(0.8);
    expect(nextStep(4, 1)).toBe(4);
    expect(nextStep(0.1, -1)).toBe(0.1);
    const v = new Viewport();
    v.zoomTo(0, 0, 0.7);
    v.zoomStep(1, 0, 0);
    expect(v.zoom).toBe(0.8);
  });
  it('wheel zoom factor: notches capped at ±25%, smooth deltas small, pixel/line agree', () => {
    expect(wheelZoomFactor(-100)).toBe(1.25);
    expect(wheelZoomFactor(100)).toBe(0.8);
    expect(wheelZoomFactor(-3, 1)).toBe(1.25);
    expect(wheelZoomFactor(-4)).toBeCloseTo(Math.exp(0.04));
    expect(wheelZoomFactor(0)).toBe(1);
  });
});
