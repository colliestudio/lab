import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, parse, serialize, type CommandCtx } from '../../core';
import { registerCoreCommands } from '../../core/commands';
import { registerComponentsLogic } from './logic';
import { exportJson, exportMarkdown, refEdges } from './export';
import { cleanType, coerce, data, instancesOf, library, titleOf } from './model';

function ctx(): CommandCtx {
  let n = 0;
  return { newId: () => `id${++n}`, random: () => 0.5 };
}
function store(ydoc?: Y.Doc) {
  const s = new Store({ ctx: ctx(), ydoc });
  registerCoreCommands(s);
  registerComponentsLogic(s);
  return s;
}
const starter = (s: Store) => s.dispatch('components.starter', { x: 0, y: 0 });
const byTitle = (s: Store, title: string) => s.doc.nodes.find((n) => titleOf(s.doc, n) === title)!;

describe('components', () => {
  it('starter defines four types in the doc library and instances that reference each other', () => {
    const s = store();
    starter(s);
    expect(Object.keys(library(s.doc)).sort()).toEqual(['adr', 'metric', 'persona', 'story']);
    expect(instancesOf(s.doc, 'story')).toHaveLength(3);
    const hana = byTitle(s, 'Hana, the host');
    const story = byTitle(s, 'Share a table by link');
    expect(data(story).as).toBe(hana.id);
    expect(refEdges(s.doc).map((e) => [e.from, e.to])).toContainEqual([story.id, hana.id]);
    // starting again keeps the types (no duplicates), adds more instances
    starter(s);
    expect(Object.keys(library(s.doc))).toHaveLength(4);
    expect(instancesOf(s.doc, 'story')).toHaveLength(6);
  });

  it('adding a field to a type shows on every instance; undo takes it back (meta is undoable)', () => {
    const s = store();
    starter(s);
    s.dispatch('components.addField', { type: 'persona', field: { label: 'Company size', kind: 'number', card: true } });
    expect(library(s.doc).persona.fields.at(-1)).toEqual({ id: 'company_size', label: 'Company size', kind: 'number', card: true });
    const hana = byTitle(s, 'Hana, the host');
    const before = hana.height;
    s.dispatch('components.set', { id: hana.id, field: 'company_size', value: '1,200' });
    expect(data(s.doc.get(hana.id)!).company_size).toBe(1200);
    expect(s.doc.get(hana.id)!.height).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
    s.undo();
    s.undo();
    expect(library(s.doc).persona.fields.some((f) => f.id === 'company_size')).toBe(false);
    s.redo();
    expect(library(s.doc).persona.fields.at(-1)!.id).toBe('company_size');
  });

  it('removing a field clears its values in the same undo step', () => {
    const s = store();
    starter(s);
    const hana = byTitle(s, 'Hana, the host');
    s.dispatch('components.removeField', { type: 'persona', field: 'quote' });
    expect(data(s.doc.get(hana.id)!).quote).toBeUndefined();
    s.undo();
    expect(data(s.doc.get(hana.id)!).quote).toMatch(/shuffling/);
    expect(library(s.doc).persona.fields.some((f) => f.id === 'quote')).toBe(true);
  });

  it('values are validated against the field kind', () => {
    const s = store();
    starter(s);
    const st = byTitle(s, 'Share a table by link');
    const metric = byTitle(s, 'Time to first table');
    const get = (f: string) => data(s.doc.get(st.id)!)[f];
    s.dispatch('components.set', { id: st.id, field: 'status', value: 'Nope' });
    expect(get('status')).toBe('Done');
    s.dispatch('components.set', { id: st.id, field: 'points', value: 'abc' });
    expect(get('points')).toBe(3);
    // a ref must point at an instance of the right type
    s.dispatch('components.set', { id: st.id, field: 'as', value: metric.id });
    expect(get('as')).not.toBe(metric.id);
    s.dispatch('components.set', { id: st.id, field: 'as', value: '' });
    expect(get('as')).toBeUndefined();
    expect(coerce({ id: 'a', label: 'A', kind: 'image' }, 'javascript:alert(1)')).toBeNull();
    expect(coerce({ id: 'a', label: 'A', kind: 'list' }, 'one\n\n two ')).toEqual(['one', 'two']);
  });

  it('type definitions are cleaned to bounded plain data (unknown keys, bad colors, scripts dropped)', () => {
    const t = cleanType({ id: 'x', name: 'X', color: 'red;background:url(x)', onRender: 'alert(1)', fields: [{ label: 'A' }, { label: 'A' }, { label: 'K', kind: 'enum', options: ['a', 'a', 3] }] });
    expect(t).toEqual({ id: 'x', name: 'X', fields: [{ id: 'a', label: 'A', kind: 'text' }, { id: 'a_2', label: 'A', kind: 'text' }, { id: 'k', label: 'K', kind: 'enum', options: ['a'] }] });
    expect(cleanType({ id: 'bad id', name: 'X' })).toBeUndefined();
  });

  it('an agent defines a type by JSON and creates instances', () => {
    const s = store();
    s.dispatch('components.defineType', { def: { name: 'Domain event', icon: '🟧', color: '#f5a623', fields: [{ label: 'Event', kind: 'text' }, { label: 'Actor', kind: 'text', card: true }] } });
    expect(library(s.doc).domain_event.name).toBe('Domain event');
    const r = s.dispatch('components.create', { type: 'domain_event', x: 10, y: 20, values: { event: 'Order placed', actor: 'Customer', bogus: 1 } });
    const n = s.doc.get(r.select![0])!;
    expect(data(n)).toEqual({ $type: 'domain_event', event: 'Order placed', actor: 'Customer' });
    // can't delete a type that has instances
    s.dispatch('components.deleteType', { type: 'domain_event' });
    expect(library(s.doc).domain_event).toBeDefined();
  });

  it('two peers editing different types and different fields both survive', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const sa = store(a);
    starter(sa);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const sb = store(b);
    const hana = byTitle(sa, 'Hana, the host');
    sa.dispatch('components.addField', { type: 'persona', field: { label: 'Age', kind: 'number' } });
    sb.dispatch('components.addField', { type: 'story', field: { label: 'Epic', kind: 'text' } });
    sa.dispatch('components.set', { id: hana.id, field: 'role', value: 'Host' });
    sb.dispatch('components.set', { id: hana.id, field: 'quote', value: 'Hi' });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    for (const s of [sa, sb]) {
      expect(library(s.doc).persona.fields.some((f) => f.id === 'age')).toBe(true);
      expect(library(s.doc).story.fields.some((f) => f.id === 'epic')).toBe(true);
      expect(data(s.doc.get(hana.id)!)).toMatchObject({ role: 'Host', quote: 'Hi' });
    }
  });

  it('the library and instances travel in the .canvas file; refs export as edges and come back as values only', () => {
    const s = store();
    starter(s);
    const file = serialize(s.exportDoc());
    const raw = JSON.parse(file);
    expect(Object.keys(raw['x-components'])).toContain('persona');
    expect(raw.edges.length).toBe(refEdges(s.doc).length);
    expect(raw.nodes.find((n: any) => n['x-components'].want === 'Share a table by link').text).toMatch(/As a:\*\* Hana, the host/);
    const t = store();
    t.load(parse(file));
    expect(t.doc.edges).toHaveLength(0);
    expect(instancesOf(t.doc, 'story')).toHaveLength(3);
    expect(refEdges(t.doc)).toHaveLength(refEdges(s.doc).length);
    expect(t.doc.nodes.every((n) => n.text === undefined)).toBe(true);
    // the reloaded library is per-type mergeable again (nested map)
    t.dispatch('components.addField', { type: 'adr', field: { label: 'Owner' } });
    expect(library(t.doc).adr.fields.at(-1)!.id).toBe('owner');
  });

  it('exports instances as JSON and Markdown for agents', () => {
    const s = store();
    starter(s);
    const j = exportJson(s.doc, 'story');
    expect(j.types.map((t) => t.id)).toEqual(['story']);
    expect(j.instances.story[0]).toMatchObject({ title: 'Share a table by link', as: { title: 'Hana, the host' }, status: 'Done' });
    const md = exportMarkdown(s.doc);
    expect(md).toContain('# 🧑 Persona (2)');
    expect(md).toContain('## Share a table by link');
    expect(md).toContain('**As a:** Hana, the host');
    expect(md).toContain('- Set up a table in a minute');
  });
});
