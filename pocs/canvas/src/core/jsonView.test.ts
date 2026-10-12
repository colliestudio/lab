import { describe, expect, it } from 'vitest';
import { registerCoreCommands } from './commands';
import type { CanvasDoc } from './doc';
import { JsonSession, MASK, blocks, nodeAt, type Redactor } from './jsonView';
import { parse } from './io';
import { Store } from './store';

const n = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'text', x: 0, y: 0, width: 100, height: 50, ...extra });
const doc: CanvasDoc = { nodes: [n('a', { text: 'A' }), n('b', { text: 'B', y: 80 }), n('c', { text: 'C', y: 160 })], edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }] };

function setup(redactors: Redactor[] = [], viewer = 'me') {
  const s = new Store();
  registerCoreCommands(s);
  s.actor = () => ({ id: 'me', name: 'Alex', color: '#fff' });
  s.load(parse(JSON.stringify(doc)));
  return { s, j: new JsonSession(s, redactors, () => viewer) };
}
const edit = (text: string, f: (d: any) => void) => {
  const d = JSON.parse(text);
  f(d);
  return JSON.stringify(d, null, '\t');
};
const logLines = (s: Store) => s.log.toArray().map((e) => e.text);

describe('JsonSession: editing the text', () => {
  it('shows the canonical text and applies a field edit as one undoable, logged step', () => {
    const { s, j } = setup();
    expect(j.text).toBe(j.current());
    const r = j.apply(edit(j.text, (d) => (d.nodes[1].text = 'B2')));
    expect(r).toMatchObject({ ok: true, line: 'edited the JSON: 1 changed' });
    expect(s.doc.get('b')!.text).toBe('B2');
    expect(logLines(s)).toEqual(['edited the JSON: 1 changed']);
    s.undo();
    expect(s.doc.get('b')!.text).toBe('B');
  });

  it('survives what others changed meanwhile (3-way field merge), also on the same node', () => {
    const { s, j } = setup();
    const mine = edit(j.text, (d) => (d.nodes[1].text = 'B2')); // I start from this text...
    s.dispatch('core.move', { ids: ['b'], dx: 0, dy: 10 }); // ...someone moves b (same node, other field)
    s.dispatch('core.move', { ids: ['c'], dx: 5, dy: 0 }); // ...and c (other node)
    const r = j.apply(mine);
    expect(r.ok).toBe(true);
    expect(s.doc.get('b')).toMatchObject({ text: 'B2', y: 90 });
    expect(s.doc.get('c')!.x).toBe(5);
    expect(JSON.parse(j.text).nodes[1]).toMatchObject({ text: 'B2', y: 90 }); // the panel then shows the merge
  });

  it('adds, removes and links', () => {
    const { s, j } = setup();
    const r = j.apply(
      edit(j.text, (d) => {
        d.nodes = d.nodes.filter((x: any) => x.id !== 'c');
        d.nodes.push(n('d', { text: 'D' }));
        d.edges.push({ id: 'e2', fromNode: 'a', toNode: 'd' });
      }),
    );
    expect(r).toMatchObject({ ok: true, line: 'edited the JSON: 1 added, 1 removed, 1 link' });
    expect(s.doc.get('c')).toBeUndefined();
    expect(s.doc.get('d')!.text).toBe('D');
    expect(s.doc.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    s.undo();
    expect(s.doc.get('c')).toBeDefined();
    expect(s.doc.get('d')).toBeUndefined();
  });

  it('does nothing for reformatted-but-same text', () => {
    const { s, j } = setup();
    const r = j.apply(JSON.stringify(JSON.parse(j.text)));
    expect(r).toMatchObject({ ok: true, line: null });
    expect(s.log.length).toBe(0);
    expect(s.undoManager.undoStack.length).toBe(0);
  });

  it('refuses invalid JSON, invalid nodes and top-level edits, leaving the doc alone', () => {
    const { s, j } = setup();
    const before = j.current();
    expect(j.apply('{ "nodes": [')).toMatchObject({ ok: false });
    expect(j.apply(edit(j.text, (d) => delete d.nodes[0].width))).toMatchObject({ ok: false, error: expect.stringContaining('node #0') });
    expect(j.apply(edit(j.text, (d) => d.nodes.push(d.nodes[0])))).toMatchObject({ ok: false });
    expect(j.apply(edit(j.text, (d) => (d.version = '2')))).toMatchObject({ ok: false, error: expect.stringContaining('read-only') });
    expect(j.apply('[]')).toMatchObject({ ok: false });
    expect(j.current()).toBe(before);
    expect(s.undoManager.undoStack.length).toBe(0);
  });

  it('core.patch (open to any peer or agent) refuses malformed changes and writes its own log line', () => {
    const { s } = setup();
    for (const changes of [[{ op: 'add', node: null }], [{ op: 'add', node: { id: 'q' } }], [{ op: 'set', id: 'a', key: 'x', value: 'abc' }], [{ op: 'set', id: 'a', key: 'id', value: 'b' }], [{ op: 'bogus' }]]) {
      expect(s.dispatch('core.patch', { changes })).toMatchObject({ ok: false });
    }
    expect(s.undoManager.undoStack.length).toBe(0);
    expect(s.dispatch('core.patch', { changes: [{ op: 'set', id: 'a', key: 'color', value: '2' }], text: 'resigned the game' })).toMatchObject({ ok: true });
    expect(logLines(s)).toEqual(['edited the JSON: 1 changed']);
  });

  it('error says where for broken JSON', () => {
    const { j } = setup();
    const r = j.apply('{\n"nodes": [\n  1 2\n]}');
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/line 3|position/);
  });
});

describe('redaction', () => {
  // a stand-in for the cards plugin: n.secret is hidden for everyone but its owner; "ghost" nodes don't exist for others
  const redactor: Redactor = (node, { viewer }) => {
    if (node.id === 'c' && viewer !== 'owner') return null;
    if (node.id === 'b' && viewer !== 'owner') return { ...node, text: MASK };
    return node;
  };

  it('leaves out nodes (and their links) and masks fields for other viewers', () => {
    const other = setup([redactor], 'other');
    const t = JSON.parse(other.j.text);
    expect(t.nodes.map((x: any) => x.id)).toEqual(['a', 'b']);
    expect(t.nodes[1].text).toBe(MASK);
    expect(other.j.text).not.toContain('"C"');
    const owner = setup([redactor], 'owner');
    expect(JSON.parse(owner.j.text).nodes.map((x: any) => x.text)).toEqual(['A', 'B', 'C']);
    // links to a left-out node go too
    const withLink = setup([redactor], 'other');
    withLink.s.dispatch('core.add', { nodes: [] });
    expect(JSON.parse(withLink.j.text).edges).toHaveLength(1);
  });

  it('applying an untouched masked view changes nothing; a masked value is never written; hidden nodes survive', () => {
    const { s, j } = setup([redactor], 'other');
    expect(j.apply(j.text)).toMatchObject({ ok: true, line: null });
    // editing another field of the masked node is fine, and the secret stays
    const r = j.apply(edit(j.text, (d) => (d.nodes[1].color = '4')));
    expect(r).toMatchObject({ ok: true, line: 'edited the JSON: 1 changed' });
    expect(s.doc.get('b')).toMatchObject({ text: 'B', color: '4' });
    // a pasted node that still carries the mask loses that field
    j.apply(edit(j.text, (d) => d.nodes.push(n('z', { text: MASK, label: 'L' }))));
    expect(s.doc.get('z')).toMatchObject({ label: 'L' });
    expect(s.doc.get('z')!.text).toBeUndefined();
    // deleting everything visible does not delete the node the viewer can't see
    j.apply(edit(j.text, (d) => (d.nodes = [])));
    expect(s.doc.get('c')).toBeDefined();
    expect(s.doc.get('a')).toBeUndefined();
  });
});

describe('blocks / nodeAt', () => {
  const { j } = setup();
  const text = j.text;

  it('finds each node entry and edge entry with its id', () => {
    const b = blocks(text);
    expect(b.filter((x) => x.kind === 'nodes').map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(b.filter((x) => x.kind === 'edges').map((x) => x.id)).toEqual(['e1']);
    const a = b.find((x) => x.id === 'a')!;
    expect(JSON.parse(text.slice(a.from, a.to)).text).toBe('A');
  });

  it('maps a caret to the node it is in; braces inside strings do not confuse it', () => {
    const t = JSON.stringify({ nodes: [n('a', { text: '} { "id": "x" ]' }), n('b')], edges: [] }, null, '\t');
    expect(nodeAt(t, t.indexOf('"id": "b"'))).toBe('b');
    expect(nodeAt(t, t.indexOf('"x"') + 1)).toBe('a');
    expect(nodeAt(t, 0)).toBeUndefined();
    expect(nodeAt(t, t.indexOf('"edges"'))).toBeUndefined();
  });

  it('copes with text that is broken after some entries', () => {
    const b = blocks(text.slice(0, text.indexOf('"id": "c"') - 4));
    expect(b.map((x) => x.id)).toEqual(['a', 'b']);
  });
});
