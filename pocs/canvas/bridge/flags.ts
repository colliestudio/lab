import type { CliForm } from '../src/core/agent';

// Command line words and flags to a command's args, by the arg schema (JSON Schema): which flag is
// which arg, numbers and booleans from text, `none` as null where an arg can be cleared.

type Json = Record<string, any>;

/** Flags the CLI itself takes; they never become args. */
export const GLOBAL_FLAGS = new Set(['as', 'bridge', 'json', 'n', 'timeout']);

export const kebab = (k: string) => k.replace(/_/g, '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** The non-null part of a schema, and whether null is allowed. */
function leaf(p: Json): { schema: Json; nullable: boolean } {
  if (Array.isArray(p.anyOf)) {
    const rest = p.anyOf.filter((m: Json) => m.type !== 'null');
    return { schema: rest[0] ?? {}, nullable: rest.length !== p.anyOf.length };
  }
  if (Array.isArray(p.type)) {
    const rest = p.type.filter((t: string) => t !== 'null');
    return { schema: { ...p, type: rest[0] }, nullable: rest.length !== p.type.length };
  }
  return { schema: p, nullable: false };
}

/** One word of the command line as the arg's value. */
export function coerce(name: string, raw: string, prop: Json, keepNone = false): unknown {
  const { schema, nullable } = leaf(prop);
  if (raw === 'none' && nullable && !keepNone) return null;
  switch (schema.type) {
    case 'number':
    case 'integer': {
      const n = Number(raw);
      if (raw.trim() === '' || Number.isNaN(n)) throw new Error(`--${kebab(name)}: "${raw}" is not a number`);
      return n;
    }
    case 'boolean':
      if (raw === 'true' || raw === 'false') return raw === 'true';
      throw new Error(`--${kebab(name)}: "${raw}" is not true or false`);
    case 'array':
      return /^\s*\[/.test(raw) ? JSON.parse(raw) : raw.split(',');
    case 'object':
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`--${kebab(name)}: expected JSON, got "${raw}"`);
      }
    default:
      return raw.replace(/\\n/g, '\n');
  }
}

function propFor(props: Json, flag: string): string | undefined {
  const camel = flag.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return [flag, flag.replace(/-/g, '_'), camel].find((k) => k in props);
}

/**
 * Args for a command or view from a CLI form: `set` first, then the positional words (`pos`, then
 * `rest` for the remaining words), then flags. Unknown flags and leftover words are errors that
 * list what is accepted.
 */
export function cliArgs(schema: Json, form: Pick<CliForm, 'verb' | 'pos' | 'rest' | 'set' | 'keepNone' | 'alias' | 'compose'>, words: string[], flags: Record<string, string>): Record<string, unknown> {
  if (form.compose) return form.compose(words, Object.fromEntries(Object.entries(flags).filter(([k]) => !GLOBAL_FLAGS.has(k))));
  const props: Json = schema.properties ?? {};
  const out: Record<string, unknown> = { ...form.set };
  const keep = new Set(form.keepNone ?? []);
  const put = (k: string, raw: string) => (out[k] = coerce(k, raw, props[k], keep.has(k)));
  const pos = form.pos ?? [];
  pos.forEach((k, i) => {
    if (words[i] !== undefined) put(k, words[i]);
  });
  const extra = words.slice(pos.length);
  if (form.rest) {
    const type = leaf(props[form.rest] ?? {}).schema.type;
    const joined = extra.join(' ');
    if (type === 'array') out[form.rest] = /^\s*[[{]/.test(joined) ? [].concat(JSON.parse(joined)) : extra; // JSON, or the words
    else if (extra.length || !(form.rest in out)) out[form.rest] = extra.join(' ').replace(/\\n/g, '\n');
  } else if (extra.length) throw new Error(`${form.verb}: unexpected argument${extra.length > 1 ? 's' : ''} ${extra.join(' ')}`);
  for (const [flag, raw] of Object.entries(flags)) {
    if (GLOBAL_FLAGS.has(flag)) continue;
    const k = form.alias?.[flag] ?? propFor(props, flag);
    if (!k) throw new Error(`${form.verb}: unknown flag --${flag} (flags: ${Object.keys(props).filter((p) => !pos.includes(p) && p !== form.rest).map((p) => `--${kebab(p)}`).join(' ') || 'none'})`);
    put(k, raw);
  }
  return out;
}

/** `a b --x 1 --flag -n 5 -- rest words` to positional words, flags (a bare flag is "true") and what follows `--`. */
export function parseArgv(argv: string[]) {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = 'true';
      else flags[a.slice(2)] = argv[++i];
    } else if (a === '-n') flags.n = argv[++i];
    else pos.push(a);
  }
  return { pos, flags, rest };
}
