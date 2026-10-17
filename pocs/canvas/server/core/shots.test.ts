import { describe, expect, it } from 'vitest';
import { parseShotArgs, shotSize } from './shots';

describe('whole-board shot size', () => {
  it('asks for the board’s own shape only for a whole-board shot with no size given', () => {
    const doc = { nodes: [{ id: 'a' }] };
    expect(parseShotArgs({}, doc).autoSize).toBe(true);
    expect(parseShotArgs({ width: 800 }, doc).autoSize).toBeUndefined();
    expect(parseShotArgs({ height: 800 }, doc).autoSize).toBeUndefined();
    expect(parseShotArgs({ node: 'a' }, doc).autoSize).toBeUndefined();
    expect(parseShotArgs({ region: { x: 0, y: 0, width: 5, height: 5 } }, doc).autoSize).toBeUndefined();
  });

  const base = { width: 1000, height: 750, padding: 40 };
  it('keeps the default size when the board reads fine in it (or is empty)', () => {
    expect(shotSize(base, { width: 1500, height: 900 })).toEqual({ width: 1000, height: 750 });
    expect(shotSize(base, null)).toEqual({ width: 1000, height: 750 });
  });

  it('a wide board gets a wide picture, a tall one a tall picture, capped at 2000', () => {
    const wide = shotSize(base, { width: 24000, height: 3500 });
    expect(wide.width).toBe(2000);
    expect(wide.height).toBe(800);
    expect(wide.height).toBeGreaterThanOrEqual(400);
    const tall = shotSize(base, { width: 3000, height: 24000 });
    expect(tall.height).toBe(2000);
    expect(tall.width).toBe(800);
    const huge = shotSize(base, { width: 90000, height: 90000 });
    expect(huge).toEqual({ width: 2000, height: 2000 });
  });
});
