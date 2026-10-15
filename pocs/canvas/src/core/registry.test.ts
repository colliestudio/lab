import { describe, expect, it } from 'vitest';
import { Registry } from './registry';

type Item = { id: string; section?: string; order?: number };
const ids = (r: Registry<Item>, sections?: string[]) => r.list(sections).map((i) => i.id);

describe('Registry', () => {
  it('lists by section, then order, then registration order', () => {
    const r = new Registry<Item>();
    r.add({ id: 'c', section: 'add' });
    r.add({ id: 'a2', section: 'tools', order: 2 });
    r.add({ id: 'a1', section: 'tools', order: 1 });
    r.add({ id: 'b', section: 'create' });
    r.add({ id: 'a3', section: 'tools' });
    expect(ids(r, ['tools', 'create', 'add'])).toEqual(['a1', 'a2', 'a3', 'b', 'c']);
  });
  it('puts sections nobody listed before the last listed one', () => {
    const r = new Registry<Item>();
    r.add({ id: 'add', section: 'add' });
    r.add({ id: 'odd', section: 'plugin' });
    r.add({ id: 'sel', section: 'tools' });
    expect(ids(r, ['tools', 'create', 'add'])).toEqual(['sel', 'odd', 'add']);
  });
  it('registering an id again replaces it in place', () => {
    const r = new Registry<Item & { v: number }>();
    r.add({ id: 'x', v: 1 });
    r.add({ id: 'y', v: 1 });
    r.add({ id: 'x', v: 2 });
    expect(r.list().map((i) => [i.id, i.v])).toEqual([['x', 2], ['y', 1]]);
  });
  it('a disposer removes its item, but not one that replaced it', () => {
    const r = new Registry<Item>();
    const off1 = r.add({ id: 'x' });
    off1();
    expect(ids(r)).toEqual([]);
    const off2 = r.add({ id: 'x' });
    r.add({ id: 'x' });
    off2();
    expect(ids(r)).toEqual(['x']);
  });
  it('tells listeners about adds and removals, until they unsubscribe', () => {
    const r = new Registry<Item>();
    let n = 0;
    const off = r.onChange(() => n++);
    const dispose = r.add({ id: 'x' });
    dispose();
    expect(n).toBe(2);
    off();
    r.add({ id: 'y' });
    expect(n).toBe(2);
  });
});
