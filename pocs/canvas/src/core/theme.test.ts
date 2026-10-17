import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parse, serialize } from './io';
import { Store } from './store';
import { registerCoreCommands } from './commands';
import { BACKGROUND_KEY, DEFAULT_BACKGROUND, PRESETS, backgroundOf, colorFromInput, isDarkColor, loadThemePref, lookOf, normalizeColor, parseThemePref, resolveTheme, saveThemePref } from './theme';

const store = () => {
  const s = new Store();
  registerCoreCommands(s);
  s.load({ nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10 }], edges: [] });
  return s;
};

describe('colors', () => {
  it('normalizes hex, rejects the rest', () => {
    expect(normalizeColor('#ABC')).toBe('#aabbcc');
    expect(normalizeColor(' #2B3340 ')).toBe('#2b3340');
    for (const bad of ['red', '#12', '#12345g', 3, null, undefined]) expect(normalizeColor(bad)).toBeUndefined();
  });
  it('takes preset ids and names as colors', () => {
    expect(colorFromInput('slate')).toBe('#2b3340');
    expect(colorFromInput('Cool grey')).toBe('#e6e9ee');
    expect(colorFromInput('#fff')).toBe('#ffffff');
    expect(colorFromInput('teal')).toBeUndefined();
  });
  it('knows dark from light, and every preset is classified sensibly', () => {
    expect(isDarkColor('#101215')).toBe(true);
    expect(isDarkColor('#2b3340')).toBe(true);
    expect(isDarkColor('#f8f9fa')).toBe(false);
    expect(PRESETS.filter((p) => isDarkColor(p.color)).map((p) => p.id)).toEqual(['slate', 'night']);
  });
});

describe('theme resolution', () => {
  it('system follows the machine; light and dark are fixed; junk is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(parseThemePref('purple')).toBe('system');
    expect(parseThemePref(null)).toBe('system');
  });
  it('is kept per device (storage), system = nothing stored', () => {
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    expect(loadThemePref(st)).toBe('system');
    saveThemePref('dark', st);
    expect(loadThemePref(st)).toBe('dark');
    saveThemePref('system', st);
    expect(mem.size).toBe(0);
  });
  it('a board without a background takes the default of the theme; its own background wins', () => {
    expect(lookOf(undefined, 'light').bg).toBe(DEFAULT_BACKGROUND.light);
    expect(lookOf(undefined, 'dark').bg).toBe(DEFAULT_BACKGROUND.dark);
    expect(lookOf(undefined, 'dark').dark).toBe(true);
    expect(lookOf('#ffffff', 'dark')).toMatchObject({ bg: '#ffffff', dark: false, ink: '#1e1e1e' });
    expect(lookOf('#101215', 'light')).toMatchObject({ bg: '#101215', dark: true, ink: '#eceff4' });
  });
});

describe('core.background', () => {
  it('is kept in the file as a top-level field and read back', () => {
    const s = store();
    expect(s.dispatch('core.background', { color: 'slate' }).ok).toBe(true);
    expect(backgroundOf(s.doc.extra)).toBe('#2b3340');
    const out = JSON.parse(serialize(s.exportDoc()));
    expect(out[BACKGROUND_KEY]).toBe('#2b3340');
    // survives a reload from the file
    const s2 = store();
    s2.load(parse(JSON.stringify(out)));
    expect(backgroundOf(s2.doc.extra)).toBe('#2b3340');
  });
  it('syncs to another client of the same doc', () => {
    const a = store();
    const b = new Store();
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    a.dispatch('core.background', { color: '#e2f1e8' });
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(backgroundOf(b.doc.extra)).toBe('#e2f1e8');
  });
  it('is undoable and redoable like other board changes', () => {
    const s = store();
    s.dispatch('core.background', { color: 'night' });
    s.dispatch('core.background', { color: 'warm' });
    s.undo();
    expect(backgroundOf(s.doc.extra)).toBe('#101215');
    s.undo();
    expect(backgroundOf(s.doc.extra)).toBeUndefined();
    s.redo();
    expect(backgroundOf(s.doc.extra)).toBe('#101215');
  });
  it('null / auto goes back to the default; the same color again is no step', () => {
    const s = store();
    s.dispatch('core.background', { color: 'mint' });
    const steps = s.undoManager.undoStack.length;
    s.dispatch('core.background', { color: 'mint' });
    expect(s.undoManager.undoStack.length).toBe(steps);
    expect(s.dispatch('core.background', { color: null }).ok).toBe(true);
    expect(backgroundOf(s.doc.extra)).toBeUndefined();
    expect(BACKGROUND_KEY in JSON.parse(serialize(s.exportDoc()))).toBe(false);
    s.dispatch('core.background', { color: 'mint' });
    s.dispatch('core.background', { color: 'auto' });
    expect(backgroundOf(s.doc.extra)).toBeUndefined();
  });
  it('refuses what is not a color and leaves the board alone', () => {
    const s = store();
    const r = s.dispatch('core.background', { color: 'chartreuse-ish' });
    expect(r.ok).toBe(false);
    expect(backgroundOf(s.doc.extra)).toBeUndefined();
  });
  it('an invalid value in a file is ignored, kept verbatim', () => {
    const s = store();
    s.load(parse(JSON.stringify({ nodes: [], edges: [], [BACKGROUND_KEY]: 'blue' })));
    expect(backgroundOf(s.doc.extra)).toBeUndefined();
    expect(JSON.parse(serialize(s.exportDoc()))[BACKGROUND_KEY]).toBe('blue');
  });
  it('core.board view tells the background', () => {
    const s = store();
    const v = s.viewSpec('core.board')!;
    expect(v.text!(v.read(s.doc, {}, null as never))).toMatch(/default/);
    s.dispatch('core.background', { color: 'slate' });
    expect(v.text!(v.read(s.doc, {}, null as never))).toBe('background: #2b3340 (Slate)');
  });
});
