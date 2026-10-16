import * as z from 'zod/mini';
import { describe, expect, it } from 'vitest';
import { command, nodeRef, view } from './agent';
import { Store } from './store';

describe('command specs', () => {
  const spec = command({ description: 'Say hi.', args: z.strictObject({ who: z.string() }), example: { who: 'you' } });

  it('register keeps the spec; without one the command still runs', () => {
    const s = new Store();
    s.register('t.hi', () => [], spec);
    s.register('t.plain', () => []);
    expect(s.spec('t.hi')).toBe(spec);
    expect(s.spec('t.plain')).toBeUndefined();
    expect(s.dispatch('t.plain', {}).ok).toBe(true);
  });

  it('views register once per name', () => {
    const s = new Store();
    const v = view({ description: 'x', args: z.strictObject({}), read: () => 1 });
    s.registerView('t.v', v);
    expect(s.view('t.v')).toBe(v);
    expect(s.viewNames()).toEqual(['t.v']);
    expect(() => s.registerView('t.v', v)).toThrow(/already registered/);
  });

  it('nodeRef shows up in JSON Schema as format canvas-node, also inside arrays', () => {
    const js = z.toJSONSchema(z.strictObject({ a: nodeRef(), b: z.optional(z.array(nodeRef())) }), { io: 'input' }) as any;
    expect(js.properties.a.format).toBe('canvas-node');
    expect(js.properties.b.items.format).toBe('canvas-node');
    expect(js.required).toEqual(['a']);
  });
});
