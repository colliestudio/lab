import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/core/store';
import { registerBoardLogic } from '../src/plugins/board/logic';
import { diffFile, stableSerialize } from './canonical';
import { Host, makeActor } from './host';

const n = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'text', x: 0, y: 0, width: 100, height: 50, ...extra });

describe('stableSerialize', () => {
  it('fixed key order, sorted extras and edges, no z', () => {
    const a = stableSerialize({ nodes: [{ height: 5, 'x-b': { z: 1, a: 2 }, y: 1, x: 2, id: 'a', type: 'text', width: 3, z: 4 }], edges: [{ id: 'e2', toNode: 'a', fromNode: 'a' }, { id: 'e1', fromNode: 'a', toNode: 'a' }], extra: { version: '1' } });
    expect(JSON.parse(a)).toEqual({ version: '1', nodes: [{ id: 'a', type: 'text', x: 2, y: 1, width: 3, height: 5, 'x-b': { a: 2, z: 1 } }], edges: [{ id: 'e1', fromNode: 'a', toNode: 'a' }, { id: 'e2', fromNode: 'a', toNode: 'a' }] });
    expect(a.indexOf('"x"')).toBeLessThan(a.indexOf('"y"'));
    expect(a.indexOf('"a": 2')).toBeLessThan(a.indexOf('"z": 1'));
  });
});

describe('diffFile', () => {
  it('per-field sets, plugin sub-fields, adds/removes, edges', () => {
    const cur = { nodes: [{ ...n('a', { text: 'x', 'x-s': { k: 1, j: 2 } }), z: 1 }, { ...n('b'), z: 2 }], edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] };
    const next = { nodes: [n('a', { text: 'y', 'x-s': { k: 1, j: 3 } }), n('c')], edges: [] };
    const d = diffFile(cur, next);
    expect(d.changes).toEqual([
      { op: 'set', id: 'a', key: 'text', value: 'y' },
      { op: 'set', id: 'a', key: 'x-s.j', value: 3 },
      { op: 'add', node: { ...n('c'), z: 2 } },
      { op: 'del', id: 'b' },
      { op: 'unedge', id: 'e' },
    ]);
    expect(d.summary).toEqual({ added: ['c'], changed: ['a'], removed: ['b'], edges: 1 });
  });
  it('renumbers z only when the file reorders', () => {
    const cur = { nodes: [{ ...n('a'), z: 10 }, { ...n('b'), z: 20 }], edges: [] };
    expect(diffFile(cur, { nodes: [n('a'), n('b')], edges: [] }).changes).toEqual([]);
    expect(diffFile(cur, { nodes: [n('b'), n('a')], edges: [] }).changes).toEqual([
      { op: 'set', id: 'b', key: 'z', value: 1 },
      { op: 'set', id: 'a', key: 'z', value: 2 },
    ]);
  });
});

describe('Host', () => {
  const claude = makeActor('Claude');
  const bot = makeActor('Backlog.md', 'tool');

  it('round-trips: file → doc → same canonical text', () => {
    const h = new Host();
    const text = stableSerialize({ nodes: [n('a', { text: 'hi', color: '4' }), n('b')], edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'x' }], extra: { version: '1.0' } });
    expect(h.applyFile(text)).toBe('edited the file: 2 added, 1 link');
    expect(h.fileText()).toBe(text);
    expect(h.applyFile(text)).toBeNull();
  });

  it('a file edit merges with a concurrent edit to another field', () => {
    const h = new Host();
    h.applyFile(stableSerialize({ nodes: [n('a', { text: 'hi' })], edges: [] }));
    const before = h.fileText();
    h.written(before);
    h.dispatch(claude, 'board.update', { id: 'a', color: '1' }); // in the doc, not yet in the file
    h.applyFile(before.replace('"hi"', '"hello"')); // an editor changed the text of the old file
    const a = h.store.doc.get('a')!;
    expect(a.text).toBe('hello');
    expect(a.color).toBe('1'); // the file didn't touch color: the live edit stays
  });

  it('each actor has its own undo and log name', () => {
    const h = new Host();
    h.dispatch(claude, 'board.add', { id: 'c1', text: 'from claude' });
    h.dispatch(bot, 'board.add', { id: 'b1', text: 'from bot' });
    expect(h.undo(claude)).toBe(true);
    expect(h.store.doc.get('c1')).toBeUndefined();
    expect(h.store.doc.get('b1')).toBeDefined();
    expect(h.undo(claude)).toBe(false);
    const log = h.store.log.toArray().map((e) => `${e.actor?.name}: ${e.text}`);
    expect(log).toEqual(['Claude: added note “from claude”', 'Backlog.md: added note “from bot”', 'Claude: undid: added note “from claude”']);
  });

  it('undo takes the top step only: an overwritten step is not skipped for the one before', () => {
    const h = new Host();
    h.dispatch(claude, 'board.add', { id: 'a', text: 'one' });
    h.dispatch(claude, 'board.update', { id: 'a', text: 'two' });
    h.dispatch(bot, 'board.update', { id: 'a', text: 'three' }); // overwrites Claude's last step
    expect(h.undo(claude)).toBe(false); // nothing left to revert in that step
    expect(h.store.doc.get('a')?.text).toBe('three'); // the note is still there (it was the add that got undone before)
    expect(h.undo(claude)).toBe(true); // the step before is next
    expect(h.store.doc.get('a')).toBeUndefined();
  });

  it('syncs with a browser-side store over Yjs updates, presence per actor', () => {
    const h = new Host();
    const browser = new Store({ ydoc: new Y.Doc() });
    registerBoardLogic(browser);
    h.ydoc.on('update', (u: Uint8Array) => Y.applyUpdate(browser.ydoc, u));
    browser.ydoc.on('update', (u: Uint8Array) => Y.applyUpdate(h.ydoc, u));
    const joined: number[] = [];
    h.onSeat((a, j) => j && joined.push(a.clientID));
    h.dispatch(claude, 'board.add', { id: 'a', text: 'live', x: 10, y: 20 });
    expect(browser.doc.get('a')!.text).toBe('live');
    browser.dispatch('board.update', { id: 'a', text: 'edited by a person' });
    expect(JSON.parse(h.fileText()).nodes[0].text).toBe('edited by a person');
    expect(joined).toHaveLength(1);
    h.sweep(0, Date.now() + 1);
    expect(h.seated()).toEqual([]);
  });

  it('an agent draws a diagram: shapes, a labelled arrow, a restyle; the file keeps x-shape and x-edge', () => {
    const h = new Host();
    h.dispatch(claude, 'diagram.add', { id: 'a', kind: 'ellipse', text: 'Start', x: 0, y: 0 });
    h.dispatch(claude, 'diagram.addConnected', { from: 'a', id: 'b', kind: 'rect', text: 'Work', side: 'bottom' });
    const arrow = h.store.doc.edges[0].id;
    h.dispatch(claude, 'core.edge', { id: arrow, label: 'then', dashed: true });
    h.dispatch(claude, 'diagram.update', { id: 'b', fill: '#b2f2bb' });
    const file = JSON.parse(h.fileText());
    expect(file.nodes.map((x: { id: string; type: string; 'x-shape': { kind: string } }) => [x.id, x.type, x['x-shape'].kind])).toEqual([['a', 'text', 'ellipse'], ['b', 'text', 'rect']]);
    expect(file.nodes[1]['x-shape'].fill).toBe('#b2f2bb');
    expect(file.edges).toEqual([expect.objectContaining({ fromNode: 'a', toNode: 'b', fromSide: 'bottom', toSide: 'top', label: 'then', 'x-edge': { dashed: true } })]);
    // the agent's own undo takes back the restyle, then the label
    expect(h.undo(claude)).toBe(true);
    expect(h.store.doc.get('b')!['x-shape']).toEqual({ kind: 'rect' });
    expect(h.undo(claude)).toBe(true);
    expect(h.store.doc.edge(arrow)!.label).toBeUndefined();
    // file round trip
    const text = h.fileText();
    const h2 = new Host();
    h2.applyFile(text);
    expect(h2.fileText()).toBe(text);
  });
});
