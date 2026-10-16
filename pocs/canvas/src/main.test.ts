import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The shell names no game: plugins register what they add to the menu, the dock and the table.
describe('main.ts', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  it('has nothing from the cards or prototype plugins beyond installing them', () => {
    expect(src).not.toMatch(/cards\.|newHand|handLabel|shift\+enter|handLabelOf/);
    expect(src.match(/plugins\/cards/g)).toHaveLength(1);
  });
  it('has no toolbar element left', () => {
    expect(src).not.toMatch(/getElementById\('toolbar'\)/);
    expect(readFileSync(new URL('../index.html', import.meta.url), 'utf8')).not.toContain('toolbar');
    expect(readFileSync(new URL('./style.css', import.meta.url), 'utf8')).not.toContain('#toolbar');
  });
});

describe('empty boards', () => {
  const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  it('New board is the only way to start over, and it puts nothing on the board', () => {
    expect(src).toContain("label: 'New board'");
    expect(src).not.toMatch(/New table|startTable|registerStarter|newKinds/);
    expect(src).toMatch(/function newBoard\(\) \{[^}]*store\.load\(\{ nodes: \[\], edges: \[\] \}\)[^}]*\}/s);
  });
  it('the board background is set in one place (variables on .cv-root)', () => {
    const css = readFileSync(new URL('./core/core.css', import.meta.url), 'utf8');
    expect(css.match(/--cv-bg:/g)).toHaveLength(1);
    expect(css).not.toContain('#1f5f3f');
  });
});
