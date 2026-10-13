import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boardsDir, isBoardFile, realPath } from './paths';

const homes: string[] = [];
const home = () => homes[homes.push(mkdtempSync(join(tmpdir(), 'cc-home-'))) - 1];
afterEach(() => homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })));

describe('boardsDir', () => {
  it('uses the iCloud Drive folder when iCloud Drive exists, and creates it', () => {
    const h = home();
    mkdirSync(join(h, 'Library/Mobile Documents/com~apple~CloudDocs'), { recursive: true });
    const d = boardsDir(h);
    expect(d).toBe(join(h, 'Library/Mobile Documents/com~apple~CloudDocs/Collie Canvas'));
    expect(boardsDir(h)).toBe(d); // idempotent
  });
  it('falls back to ~/Collie Canvas', () => {
    const h = home();
    expect(boardsDir(h)).toBe(join(h, 'Collie Canvas'));
  });
  it('does not create when asked not to', () => {
    const h = home();
    boardsDir(h, false);
    expect(() => mkdirSync(join(h, 'Collie Canvas'))).not.toThrow();
  });
});

describe('iCloud placeholders', () => {
  it('maps the evicted stub to the real file', () => {
    expect(realPath('/x/.plan.canvas.icloud')).toBe('/x/plan.canvas');
    expect(realPath('/x/plan.canvas')).toBe('/x/plan.canvas');
    expect(isBoardFile('/x/.plan.canvas.icloud')).toBe(true);
    expect(isBoardFile('/x/notes.txt.icloud')).toBe(false);
  });
});
