import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDoc } from './grade';
import { JOBS } from './jobs';

// Boards the first real agent runs produced (2026-10-16, poc b37e48f): pin what the graders say about them.
const board = (job: string) => loadDoc(readFileSync(join(__dirname, 'fixtures', `baseline-${job}.canvas`), 'utf8'));
const verdict = (job: string) => Object.fromEntries(JOBS[job].grade(board(job)).map((c) => [c.id, c.pass]));

describe('baseline boards', () => {
  it('notes: a sensible board passes everything', () => {
    expect(verdict('notes')).toEqual({ columns: true, 'notes-per-column': true, 'no-empty-notes': true, links: true });
  });
  it('storm: stickies from the diagram plugin are not an event storm board', () => {
    expect(verdict('storm')).toMatchObject({ board: false, events: false, commands: false });
  });
  it('proto (regraded by the tightened grader): Play can click through the arrows; the links in the pages are dead (href, no data-goto)', () => {
    expect(verdict('proto')).toEqual({ pages: true, titles: true, html: true, start: true, 'in-page-links': false, 'no-broken-links': false, navigation: true, arrows: true });
  });
  it('checkout (2026-10-16, poc bf0763d): the pages exist and start at the cart, but nothing in them links, goes back or shares state', () => {
    expect(verdict('checkout')).toEqual({ pages: true, titles: true, start: true, forward: false, back: false, state: false, 'no-broken-links': true });
  });
  it('arch (2026-10-16, poc 0db45e0): the agent drew a complete diagram as one Excalidraw scene; graded 0/5 because it has no diagram shapes and no Canvas frame', () => {
    expect(JOBS.arch.grade(board('arch')).find((c) => c.id === 'components')!.detail).toBe('drew in Excalidraw (1 scene), not diagram shapes');
    expect(verdict('arch')).toEqual({ frame: false, components: false, 'in-frame': false, connected: false, labeled: false });
  });
});
