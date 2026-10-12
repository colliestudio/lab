import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parse, serialize } from './io';
import { Store } from './store';
import { registerCoreCommands } from './commands';
import type { CanvasDoc } from './doc';

const file = {
  version: '1.0-x',
  'x-app': { theme: 'felt' },
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A♠', color: '3' },
    { id: 'b', type: 'text', x: 5, y: 5, width: 10, height: 10, text: 'hi', 'x-other': { k: [1, 2] } },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'x', 'x-other': 1 }],
};

function store(doc?: CanvasDoc) {
  const s = new Store();
  registerCoreCommands(s);
  if (doc) s.load(doc);
  return s;
}

describe('io', () => {
  it('round-trips nodes, edges and unknown top-level fields through the Y store', () => {
    const s = store(parse(JSON.stringify(file)));
    expect(JSON.parse(serialize(s.exportDoc()))).toEqual(file);
  });
  it('exports nodes in z order without the z field', () => {
    const s = store(parse(JSON.stringify(file)));
    s.dispatch('core.front', { ids: ['a'] });
    const out = JSON.parse(serialize(s.exportDoc()));
    expect(out.nodes.map((n: any) => n.id)).toEqual(['b', 'a']);
    expect(out.nodes[0].z).toBeUndefined();
  });
  it('skips malformed nodes and dangling edges instead of failing', () => {
    const d = parse(
      JSON.stringify({ nodes: [{ id: 'a', type: 'text', x: '0', y: 0, width: 1, height: 1 }, file.nodes[0]], edges: file.edges }),
    );
    expect(d.nodes.map((n) => n.id)).toEqual(['a']);
    expect(d.edges).toEqual([]);
    expect(d.skipped).toHaveLength(2);
    expect(() => parse('[]')).toThrow();
  });
});

describe('store', () => {
  it('applies per-field changes and keeps plugin fields as nested maps', () => {
    const s = store(parse(JSON.stringify(file)));
    s.apply([{ op: 'set', id: 'b', key: 'x-other.k', value: 7 }, { op: 'set', id: 'a', key: 'color', value: undefined }]);
    expect(s.doc.get('b')!['x-other']).toEqual({ k: 7 });
    expect(s.doc.get('a')!.color).toBeUndefined();
    // a set on a deleted node doesn't resurrect it
    s.apply([{ op: 'del', id: 'a' }, { op: 'set', id: 'a', key: 'x', value: 1 }]);
    expect(s.doc.get('a')).toBeUndefined();
    expect(s.doc.edges).toEqual([]);
  });
  it('front is a no-op when already on top', () => {
    const s = store(parse(JSON.stringify(file)));
    expect(s.dispatch('core.front', { ids: ['b'] }).changes).toEqual([]);
    expect(s.dispatch('core.front', { ids: ['a'] }).changes).toHaveLength(1);
  });
  it('rejects bad args without throwing', () => {
    const s = store(parse(JSON.stringify(file)));
    expect(s.dispatch('core.move', { ids: 'a', dx: 1, dy: 1 }).changes).toEqual([]);
    expect(s.dispatch('core.move', null).changes).toEqual([]);
    expect(s.dispatch('nope', {}).ok).toBe(false);
  });
  it('undo/redo one dispatch at a time; merged dispatches undo together', () => {
    const s = store(parse(JSON.stringify(file)));
    s.dispatch('core.move', { ids: ['a'], dx: 10, dy: 0 });
    s.dispatch('core.move', { ids: ['a'], dx: 10, dy: 0 });
    s.dispatch('core.move', { ids: ['a'], dx: 10, dy: 0 }, { merge: true });
    expect(s.doc.get('a')!.x).toBe(30);
    s.undo();
    expect(s.doc.get('a')!.x).toBe(10);
    s.undo();
    expect(s.doc.get('a')!.x).toBe(0);
    s.redo();
    expect(s.doc.get('a')!.x).toBe(10);
  });
  it('repairs: after an undo/redo they fix what it touched, in the same step; after a remote change on every peer', () => {
    // a toy invariant: `x-pair.x` mirrors x (a partial undo could break it)
    const pairs = (s: Store) =>
      s.repairs.push((doc, a) =>
        doc.nodes.filter((n) => a.ids.includes(n.id) && (n as any)['x-pair'] && (n as any)['x-pair'].x !== n.x).map((n) => ({ op: 'set' as const, id: n.id, key: 'x-pair.x', value: n.x })),
      );
    const da = new Y.Doc();
    const db = new Y.Doc();
    da.on('update', (u: Uint8Array, o: unknown) => o !== 'remote' && Y.applyUpdate(db, u, 'remote'));
    db.on('update', (u: Uint8Array, o: unknown) => o !== 'remote' && Y.applyUpdate(da, u, 'remote'));
    const A = new Store({ ydoc: da });
    const B = new Store({ ydoc: db });
    registerCoreCommands(A);
    registerCoreCommands(B);
    pairs(A);
    pairs(B);
    A.dispatch('core.add', { nodes: [{ id: 'p', type: 'text', x: 0, y: 0, width: 1, height: 1, 'x-pair': { x: 0 } }] });
    A.newUndoStep();
    A.apply([{ op: 'set', id: 'p', key: 'x', value: 5 }, { op: 'set', id: 'p', key: 'x-pair.x', value: 5 }]);
    // B changes only the mirror: A's undo can't restore it (never overwrites another player's change)
    B.apply([{ op: 'set', id: 'p', key: 'x-pair.x', value: 9 }], 'other');
    expect((A.doc.get('p') as any)['x-pair'].x).toBe(5); // the remote change was repaired: mirror = x again
    A.undo();
    for (const s of [A, B]) expect(s.doc.get('p')!.x).toBe(0);
    for (const s of [A, B]) expect((s.doc.get('p') as any)['x-pair'].x).toBe(0);
    expect(A.undoManager.redoStack).toHaveLength(1);
    A.redo();
    expect(A.doc.get('p')!.x).toBe(5);
    expect((A.doc.get('p') as any)['x-pair'].x).toBe(5);
    expect(A.undoManager.undoStack).toHaveLength(2);
    expect(A.undoManager.redoStack).toHaveLength(0);
  });
  it('selection drops deleted nodes', () => {
    const s = store(parse(JSON.stringify(file)));
    s.select(['a', 'b']);
    s.dispatch('core.delete', { ids: ['a'] });
    expect([...s.selection]).toEqual(['b']);
  });
});

describe('riders', () => {
  const n = (id: string, z: number, extra: Record<string, unknown> = {}) => ({ id, type: 'text', x: 0, y: 0, width: 10, height: 10, z, ...extra });
  function boardStore() {
    const s = store();
    s.addRiderRule((node, get) => {
      const on = (node as any)['x-on'];
      return typeof on === 'string' && get(on) ? on : undefined;
    });
    s.load({ nodes: [n('board', 1), n('p1', 2, { 'x-on': 'board' }), n('p2', 3, { 'x-on': 'board' }), n('other', 4), n('ghost', 5, { 'x-on': 'gone' })], edges: [] });
    return s;
  }
  it('move carries riders with their carrier (per-field sets), not the other way round', () => {
    const s = boardStore();
    expect(s.doc.riders('board').map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(s.doc.carrierOf('ghost')).toBeUndefined();
    s.dispatch('core.move', { ids: ['board'], dx: 5, dy: 7 });
    expect(['board', 'p1', 'p2'].map((id) => [s.doc.get(id)!.x, s.doc.get(id)!.y])).toEqual([[5, 7], [5, 7], [5, 7]]);
    expect(s.doc.get('other')!.x).toBe(0);
    // moving board + rider together moves the rider once
    s.dispatch('core.move', { ids: ['p1', 'board'], dx: 1, dy: 0 });
    expect(s.doc.get('p1')!.x).toBe(6);
    s.dispatch('core.move', { ids: ['p2'], dx: 10, dy: 0 });
    expect(s.doc.get('board')!.x).toBe(6);
  });
  it('front brings riders along just above their carrier', () => {
    const s = boardStore();
    s.dispatch('core.front', { ids: ['board'] });
    expect(s.doc.visible.map((v) => v.id)).toEqual(['other', 'ghost', 'board', 'p1', 'p2']);
    expect(s.dispatch('core.front', { ids: ['board'] }).changes).toEqual([]);
  });
  it('a rule may go by geometry: it gets every linked node in z order', () => {
    const s = store();
    // ride the topmost lower "mat" whose box holds the node's center
    s.addRiderRule((node, _get, all) => {
      if ((node as any)['x-mat']) return;
      const cx = node.x + node.width / 2;
      const cy = node.y + node.height / 2;
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i];
        if ((m as any)['x-mat'] && (m.z ?? 0) < (node.z ?? 0) && cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) return m.id;
      }
    });
    s.load({ nodes: [{ ...n('mat', 1, { 'x-mat': true }), width: 100, height: 100 }, { ...n('on', 2), x: 50, y: 50 }, { ...n('off', 3), x: 200 }], edges: [] });
    expect(s.doc.riders('mat').map((r) => r.id)).toEqual(['on']);
    s.dispatch('core.move', { ids: ['mat'], dx: 10, dy: 0 });
    expect([s.doc.get('on')!.x, s.doc.get('off')!.x]).toEqual([60, 200]);
  });
});

describe('duplicate', () => {
  it('copies nodes offset on top and selects them; plugin rules shape or refuse copies', () => {
    const s = store(parse(JSON.stringify(file)));
    s.duplicateRules.push((n) => (n.id === 'b' ? null : undefined));
    s.duplicateRules.push((n) => ({ ...n, text: 'copy' }));
    const r = s.dispatch('core.duplicate', { ids: ['a', 'b'] });
    expect(r.select).toHaveLength(1);
    const c = s.doc.get(r.select![0])!;
    expect(c).toMatchObject({ type: 'text', x: 24, y: 24, text: 'copy', color: '3' });
    expect(s.doc.visible.at(-1)!.id).toBe(c.id);
    expect([...s.selection]).toEqual([c.id]);
    expect(s.dispatch('core.duplicate', { ids: ['b'] }).changes).toEqual([]);
  });
});

describe('snapshot cache', () => {
  it('reuses unchanged nodes and refreshes changed ones (own, nested, remote, undo)', async () => {
    const Y = await import('yjs');
    const s = store(parse(JSON.stringify(file)));
    const a0 = s.doc.get('a');
    const b0 = s.doc.get('b');
    s.dispatch('core.move', { ids: ['a'], dx: 3, dy: 0 });
    expect(s.doc.get('b')).toBe(b0); // untouched node: same object
    expect(s.doc.get('a')).not.toBe(a0);
    expect(s.doc.get('a')!.x).toBe(3);
    s.newUndoStep();
    s.apply([{ op: 'set', id: 'b', key: 'x-other.k', value: 7 }]);
    expect(s.doc.get('b')!['x-other']).toEqual({ k: 7 });
    s.undo();
    expect(s.doc.get('b')!['x-other']).toEqual({ k: [1, 2] });
    const t = new Store({ ydoc: new Y.Doc() });
    Y.applyUpdate(t.ydoc, Y.encodeStateAsUpdate(s.ydoc));
    expect(t.doc.get('a')!.x).toBe(3);
    s.dispatch('core.move', { ids: ['a'], dx: 1, dy: 0 });
    Y.applyUpdate(t.ydoc, Y.encodeStateAsUpdate(s.ydoc, Y.encodeStateVector(t.ydoc)));
    expect(t.doc.get('a')!.x).toBe(4);
    s.dispatch('core.delete', { ids: ['a'] });
    expect(s.doc.get('a')).toBeUndefined();
  });
});

describe('adoptViewRules', () => {
  it('a second store over another doc reads it with the first store’s rules', () => {
    const main = new Store();
    main.addRiderRule((n) => (n['x-on'] as string | undefined) ?? undefined);
    const other = new Store();
    other.load({ nodes: [{ id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10 }, { id: 'p', type: 'text', x: 1, y: 1, width: 1, height: 1, 'x-on': 'b' }], edges: [] });
    expect(other.doc.carrierOf('p')).toBeUndefined();
    other.adoptViewRules(main);
    expect(other.doc.carrierOf('p')).toBe('b');
  });
  it('invalidate rebuilds the snapshot and notifies', () => {
    const s = new Store();
    let flag = false;
    s.addRiderRule((n) => (flag && n.id === 'p' ? 'b' : undefined));
    s.load({ nodes: [{ id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10 }, { id: 'p', type: 'text', x: 1, y: 1, width: 1, height: 1 }], edges: [] });
    expect(s.doc.carrierOf('p')).toBeUndefined();
    flag = true;
    let heard = 0;
    s.subscribe(() => heard++);
    s.invalidate();
    expect(s.doc.carrierOf('p')).toBe('b');
    expect(heard).toBe(1);
  });
});
