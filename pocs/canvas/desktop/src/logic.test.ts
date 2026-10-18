import { describe, expect, it } from 'vitest';
import { classify, iconSpec, nameHash, normalizeBackend, parseArgs, popoutId, pushRecent, sanitizeState } from './logic';

const B = 'http://mini.internal:5310';

describe('normalizeBackend', () => {
  it('takes an address as typed', () => {
    expect(normalizeBackend('mini.internal:5310')).toBe(B);
    expect(normalizeBackend(' http://mini.internal:5310/some/path ')).toBe(B);
    expect(normalizeBackend('https://canvas.example.com/')).toBe('https://canvas.example.com');
  });
  it('refuses what is not http(s)', () => {
    for (const s of ['', '  ', 'file:///etc/passwd', 'javascript:alert(1)', 'http://']) expect(normalizeBackend(s)).toBeNull();
  });
});

describe('classify', () => {
  it('routes the backend own pages', () => {
    expect(classify(B, `${B}/b/My%20canvas`)).toEqual({ kind: 'canvas', name: 'My canvas' });
    expect(classify(B, `${B}/b/x/?agentView=1`)).toEqual({ kind: 'canvas', name: 'x' });
    expect(classify(B, `${B}/`)).toEqual({ kind: 'home' });
    expect(classify(B, `${B}/api/boards`)).toEqual({ kind: 'internal' });
  });
  it('sends other sites to the browser and refuses odd schemes', () => {
    expect(classify(B, 'https://example.com/b/x')).toEqual({ kind: 'external' });
    expect(classify(B, 'http://mini.internal:5311/b/x')).toEqual({ kind: 'external' });
    for (const u of ['file:///etc/passwd', 'javascript:1', 'not a url', 'smb://host/x']) expect(classify(B, u)).toEqual({ kind: 'deny' });
  });
});

describe('sanitizeState', () => {
  it('falls back on junk', () => {
    expect(sanitizeState(null, B)).toEqual({ backend: B, main: { canvas: null, bounds: undefined }, recent: [] });
    expect(sanitizeState({ backend: 'file:///x', main: 'no', recent: [1] }, B)).toEqual({ backend: B, main: { canvas: null, bounds: undefined }, recent: [] });
  });
  it('keeps the main window, drops bad bounds', () => {
    expect(sanitizeState({ backend: 'http://other:1/', main: { canvas: 'a', bounds: { x: 1.4, y: 2, width: 800, height: 600 } }, recent: ['a', 'b'] }, B)).toEqual({
      backend: 'http://other:1',
      main: { canvas: 'a', bounds: { x: 1, y: 2, width: 800, height: 600 } },
      recent: ['a', 'b'],
    });
    expect(sanitizeState({ main: { canvas: 'a', bounds: { width: 5, height: 5 } } }, B).main).toEqual({ canvas: 'a', bounds: undefined });
  });
  it('reads the 0.2 window list: the first window becomes the main window', () => {
    expect(sanitizeState({ windows: [3, { board: '', bounds: {} }, { board: 'a', bounds: { width: 800, height: 600 } }, { board: null }] }, B).main).toEqual({ canvas: 'a', bounds: { width: 800, height: 600 } });
  });
});

describe('recent', () => {
  it('moves a reopened canvas to the front and caps the list', () => {
    expect(pushRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(pushRecent(Array.from({ length: 10 }, (_, i) => `n${i}`), 'new')).toHaveLength(10);
  });
});

describe('pop-out launch', () => {
  it('parses the launch arguments', () => {
    expect(parseArgs(['/x/app', '--canvas=My canvas'])).toEqual({ popout: 'My canvas', open: undefined });
    expect(parseArgs(['--open-canvas=a=b', 'file.canvas'])).toEqual({ popout: undefined, open: 'a=b' });
    expect(parseArgs(['--canvas='])).toEqual({ popout: undefined, open: undefined });
  });
  it('keys a pop-out by a stable hash', () => {
    expect(nameHash('Roadmap')).toBe(nameHash('Roadmap'));
    expect(nameHash('Roadmap')).not.toBe(nameHash('roadmap'));
    expect(popoutId('My Road/map!')).toMatch(/^my-road-map-[0-9a-f]{8}$/);
    expect(popoutId('日本')).toMatch(/^canvas-[0-9a-f]{8}$/);
    expect(popoutId('a/b')).not.toBe(popoutId('a b')); // same slug, different names
  });
  it('gives each canvas a stable letter and color', () => {
    expect(iconSpec('  roadmap').letter).toBe('R');
    expect(iconSpec('Roadmap')).toEqual(iconSpec('Roadmap'));
    expect(iconSpec('Roadmap').hue).toBeGreaterThanOrEqual(0);
    expect(iconSpec('Roadmap').hue).toBeLessThan(360);
    expect(iconSpec('...').letter).toBe('#');
    expect(iconSpec('Retro').hue).not.toBe(iconSpec('Roadmap').hue);
  });
});
