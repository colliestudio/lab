import type { CanvasDoc } from './doc';

// The version of the .canvas file format, kept as a top-level JSON Canvas extension field. A server
// that finds a newer version than it knows refuses the board (it cannot know what changed) and leaves
// the file alone; an older version is migrated step by step on load. A file without the field is
// version 1: every file written before the field existed.

export const FORMAT_KEY = 'x-canvas-format';
export const FORMAT_VERSION = 1;

/** A valid version above what is supported (as opposed to a malformed field). */
const isNewer = (found: unknown, supported: number): boolean => typeof found === 'number' && Number.isInteger(found) && found > supported;

export class FormatError extends Error {
  constructor(
    readonly found: unknown,
    readonly supported = FORMAT_VERSION,
  ) {
    super(
      isNewer(found, supported)
        ? `this canvas is format ${found}; this server supports up to ${supported}. Update the server to open it (the file is untouched).`
        : `${FORMAT_KEY} must be a positive integer (found ${JSON.stringify(found) ?? 'nothing'})`,
    );
    this.name = 'FormatError';
  }

  /** A valid version this code is too old for (as opposed to a malformed field). */
  get newer(): boolean {
    return isNewer(this.found, this.supported);
  }
}

/** The file's format version; a missing field means 1. Throws FormatError for anything but a positive integer. */
export function formatOf(extra: Record<string, unknown> | undefined): number {
  const v = extra?.[FORMAT_KEY];
  if (v === undefined) return 1;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new FormatError(typeof v === 'number' ? String(v) : v);
  return v;
}

/** Throws FormatError when the doc is newer than this code supports; returns its version. */
export function checkFormat(doc: Pick<CanvasDoc, 'extra'>): number {
  const v = formatOf(doc.extra);
  if (v > FORMAT_VERSION) throw new FormatError(v);
  return v;
}

/** Index i upgrades version i+1 to i+2. Empty while version 1 is the only one. */
export const FORMAT_MIGRATIONS: ((d: CanvasDoc) => CanvasDoc)[] = [];

/** Upgrades a doc to FORMAT_VERSION and stamps the field. Throws FormatError when it is newer. */
export function migrateFormat(doc: CanvasDoc): CanvasDoc {
  let v = checkFormat(doc);
  let out = doc;
  while (v < FORMAT_VERSION) out = FORMAT_MIGRATIONS[v++ - 1](out);
  return { ...out, extra: { ...out.extra, [FORMAT_KEY]: FORMAT_VERSION } };
}
