import { describe, expect, it } from 'vitest';
import { loadPlayer, savePlayer, PALETTE } from './player';

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe('player storage', () => {
  it('first load creates and saves an unnamed default "Player N"', () => {
    const s = mem();
    const p = loadPlayer(s, 'k', () => 0.5);
    expect(p).toMatchObject({ name: 'Player 50', named: false });
    expect(PALETTE).toContain(p.color);
    expect(loadPlayer(s, 'k')).toEqual(p); // stable id/name across loads
  });
  it('old entries without `named` count as unnamed (asked once more), keep their id', () => {
    const s = mem({ k: JSON.stringify({ id: 'abc', name: 'Player 7', color: '#4363d8' }) });
    expect(loadPlayer(s, 'k')).toEqual({ id: 'abc', name: 'Player 7', color: '#4363d8', named: false });
  });
  it('saving a choice marks named, trims, caps length, keeps id; blank keeps the old name', () => {
    const s = mem({ k: JSON.stringify({ id: 'abc', name: 'Player 7', color: '#4363d8' }) });
    const p = savePlayer({ name: '  Hannah   B  ', color: '#e6194b' }, s, 'k');
    expect(p).toEqual({ id: 'abc', name: 'Hannah B', color: '#e6194b', named: true });
    expect(loadPlayer(s, 'k').named).toBe(true);
    expect(savePlayer({ name: '   ' }, s, 'k').name).toBe('Hannah B');
    expect(savePlayer({ name: 'x'.repeat(50), color: 'red' }, s, 'k')).toMatchObject({ name: 'x'.repeat(24), color: '#e6194b' });
  });
  it('junk in storage is replaced by a fresh default', () => {
    const s = mem({ k: '{nope' });
    expect(loadPlayer(s, 'k').named).toBe(false);
  });
});
