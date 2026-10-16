import { describe, expect, it, vi } from 'vitest';
import { createUnique, fileStem, openServedBoard } from './newBoard';

type Reply = { status: number; json: unknown };
function service(replies: Reply[]) {
  const calls: unknown[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    const r = replies.shift()!;
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const created = (name: string): Reply => ({ status: 201, json: { name } });
const taken: Reply = { status: 409, json: { error: 'a board named "x" already exists' } };

describe('createUnique', () => {
  it('tries base, base 2… while the name is taken', async () => {
    const { f, calls } = service([taken, taken, created('x 3')]);
    expect(await createUnique('x', undefined, f)).toBe('x 3');
    expect(calls).toEqual([{ name: 'x' }, { name: 'x 2' }, { name: 'x 3' }]);
  });
  it('sends the text on every try', async () => {
    const { f, calls } = service([taken, created('x 2')]);
    await createUnique('x', 'FILE', f);
    expect(calls).toEqual([{ name: 'x', text: 'FILE' }, { name: 'x 2', text: 'FILE' }]);
  });
  it('stops on a newer format or an invalid file', async () => {
    await expect(createUnique('x', 't', service([{ status: 409, json: { error: 'newer', kind: 'newer' } }]).f)).rejects.toMatchObject({ kind: 'newer' });
    await expect(createUnique('x', 't', service([{ status: 422, json: { error: 'bad', kind: 'invalid' } }]).f)).rejects.toMatchObject({ status: 422 });
  });
  it('falls back to Untitled for a name the service refuses, and for an empty one', async () => {
    const { f, calls } = service([{ status: 400, json: { error: 'bad name' } }, created('Untitled')]);
    expect(await createUnique('a/b', undefined, f)).toBe('Untitled');
    expect(calls).toEqual([{ name: 'a/b' }, { name: 'Untitled' }]);
    expect(await createUnique('  ', undefined, service([created('Untitled')]).f)).toBe('Untitled');
  });
  it('gives up after 20 taken names', async () => {
    await expect(createUnique('x', undefined, service(Array.from({ length: 20 }, () => taken)).f)).rejects.toThrow(/free name/);
  });
});

describe('openServedBoard', () => {
  const fakeWin = (blocked = false) => {
    const tab = { opener: 'x' as unknown, location: { href: '' }, close: vi.fn() };
    const win = { open: vi.fn(() => (blocked ? null : tab)), location: { href: '' } };
    return { tab, win: win as unknown as Pick<Window, 'open' | 'location'>, open: win.open };
  };
  it('opens the tab before the board exists, then points it at the board', async () => {
    const { tab, win, open } = fakeWin();
    let release!: (n: string) => void;
    const p = openServedBoard(() => new Promise<string>((r) => (release = r)), win);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe('');
    release('my board');
    expect(await p).toBe('my board');
    expect(tab.location.href).toBe('/b/my%20board');
    expect(tab.opener).toBeNull();
  });
  it('goes there in this tab when the tab was blocked', async () => {
    const { win } = fakeWin(true);
    await openServedBoard(async () => 'b', win);
    expect(win.location.href).toBe('/b/b');
  });
  it('closes the blank tab and rethrows when the board could not be made', async () => {
    const { tab, win } = fakeWin();
    await expect(openServedBoard(() => Promise.reject(new Error('no')), win)).rejects.toThrow('no');
    expect(tab.close).toHaveBeenCalled();
  });
});

describe('fileStem', () => {
  it('drops .canvas and .json', () => {
    expect(fileStem('My game.canvas')).toBe('My game');
    expect(fileStem('x.JSON')).toBe('x');
    expect(fileStem('x.y')).toBe('x.y');
  });
});
