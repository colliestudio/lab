import { describe, expect, it } from 'vitest';
import { FORMAT_KEY, FORMAT_VERSION, FormatError, checkFormat, formatOf, migrateFormat } from './format';
import { parse, serialize } from './io';
import type { CanvasDoc } from './doc';

const doc = (extra?: Record<string, unknown>): CanvasDoc => ({ nodes: [], edges: [], extra });

describe('format version', () => {
  it('a missing field is version 1', () => {
    expect(formatOf(undefined)).toBe(1);
    expect(formatOf({ other: 1 })).toBe(1);
    expect(checkFormat(doc())).toBe(1);
  });

  it('the current version passes', () => {
    expect(checkFormat(doc({ [FORMAT_KEY]: FORMAT_VERSION }))).toBe(FORMAT_VERSION);
  });

  it('a newer version is refused, naming both', () => {
    expect(() => checkFormat(doc({ [FORMAT_KEY]: FORMAT_VERSION + 1 }))).toThrow(FormatError);
    expect(() => checkFormat(doc({ [FORMAT_KEY]: 2 }))).toThrow(/format 2.*supports up to 1/);
  });

  it('anything but a positive integer is refused', () => {
    for (const bad of ['1', 0, -1, 1.5, null, true]) expect(() => formatOf({ [FORMAT_KEY]: bad }), String(bad)).toThrow(FormatError);
  });

  it('migrating stamps the version and keeps other fields', () => {
    const out = migrateFormat(doc({ keep: 'me' }));
    expect(out.extra).toEqual({ keep: 'me', [FORMAT_KEY]: FORMAT_VERSION });
    expect(() => migrateFormat(doc({ [FORMAT_KEY]: 99 }))).toThrow(FormatError);
  });

  it('survives serialize and parse', () => {
    const text = serialize(migrateFormat(doc()));
    expect(parse(text).extra?.[FORMAT_KEY]).toBe(FORMAT_VERSION);
    expect(serialize(parse(text))).toBe(text);
  });
});
