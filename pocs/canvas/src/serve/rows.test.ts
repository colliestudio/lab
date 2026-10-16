import { describe, expect, it } from 'vitest';
import { toRows } from './rows';

const NOW = Date.parse('2026-10-16T12:00:00Z');

describe('toRows', () => {
  it('keeps the server order and says state, age and error', () => {
    const rows = toRows(
      [
        { name: 'b', loaded: true, browsers: 2, modified: NOW - 3 * 60_000 },
        { name: 'a', loaded: true, browsers: 0, modified: NOW - 10_000 },
        { name: 'c b', loaded: false, browsers: 1, modified: NOW - 5 * 3600_000 },
        { name: 'new', loaded: false, browsers: 0, modified: NOW - 3 * 86400_000, error: 'format 99' },
        { name: 'bare', loaded: false, browsers: 0 },
      ],
      NOW,
    );
    expect(rows.map((r) => [r.name, r.href, r.modified, r.state, r.error])).toEqual([
      ['b', '/b/b', '3 min ago', 'open · 2 browsers', undefined],
      ['a', '/b/a', 'just now', 'loaded', undefined],
      ['c b', '/b/c%20b', '5 h ago', 'open · 1 browser', undefined],
      ['new', '/b/new', '3 d ago', '', 'format 99'],
      ['bare', '/b/bare', '', '', undefined],
    ]);
  });
  it('an empty folder is an empty list', () => {
    expect(toRows([], NOW)).toEqual([]);
  });
});
