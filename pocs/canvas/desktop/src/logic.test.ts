import { describe, expect, it } from 'vitest';
import { classify, normalizeBackend, pushRecent, sanitizeState } from './logic';

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
    expect(classify(B, `${B}/b/My%20board`)).toEqual({ kind: 'board', name: 'My board' });
    expect(classify(B, `${B}/b/x/?agentView=1`)).toEqual({ kind: 'board', name: 'x' });
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
    expect(sanitizeState(null, B)).toEqual({ backend: B, windows: [], recent: [] });
    expect(sanitizeState({ backend: 'file:///x', windows: 'no', recent: [1] }, B)).toEqual({ backend: B, windows: [], recent: [] });
  });
  it('keeps valid windows once each, drops bad bounds', () => {
    const s = sanitizeState(
      { backend: 'http://other:1/', windows: [{ board: 'a', bounds: { x: 1.4, y: 2, width: 800, height: 600 } }, { board: 'a' }, { board: null, bounds: { width: 5, height: 5 } }, { board: '' }, 3], recent: ['a', 'b'] },
      B,
    );
    expect(s).toEqual({ backend: 'http://other:1', windows: [{ board: 'a', bounds: { x: 1, y: 2, width: 800, height: 600 } }, { board: null, bounds: undefined }], recent: ['a', 'b'] });
  });
});

describe('recent', () => {
  it('moves a reopened board to the front and caps the list', () => {
    expect(pushRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(pushRecent(Array.from({ length: 10 }, (_, i) => `n${i}`), 'new')).toHaveLength(10);
  });
});
