import type { CliForm } from '../src/core/agent';
import type { Catalog } from './catalog';
import { kebab } from './flags';

// The CLI verbs plugins describe (the `cli` forms on their specs), looked up by the words typed.

export interface Form {
  words: string[];
  form: CliForm;
  /** The command or view this verb calls. */
  name: string;
  kind: 'command' | 'view';
}

/** Every form, in plugin order. */
export function buildForms(cat: Catalog): Form[] {
  return cat
    .plugins()
    .flatMap((p) => [
      ...p.commands.flatMap((name) => (cat.spec(name)?.cli ?? []).map((form) => ({ words: form.verb.split(' '), form, name, kind: 'command' as const }))),
      ...p.views.flatMap((name) => (cat.viewSpec(name)?.cli ?? []).map((form) => ({ words: form.verb.split(' '), form, name, kind: 'view' as const }))),
    ]);
}

/** The form whose verb the words start with; the longest verb wins (`chess move` over `chess`). */
export const findForm = (forms: Form[], pos: string[]) =>
  forms.filter((x) => x.words.every((w, i) => pos[i] === w)).sort((a, b) => b.words.length - a.words.length)[0];

/** One line of usage: `style NODE [--text V] [--dashed]`; values show their choices (`--side top|right|bottom|left`). */
export function formUsage(cat: Catalog, f: Form): string {
  if (f.form.usage) return f.form.usage;
  const spec = f.kind === 'command' ? cat.spec(f.name)! : cat.viewSpec(f.name)!;
  const schema = cat.jsonSchema(spec.args);
  const props: Record<string, any> = schema.properties ?? {};
  const req = new Set<string>(schema.required ?? []);
  const given = new Set([...(f.form.pos ?? []), ...(f.form.rest ? [f.form.rest] : []), ...Object.keys(f.form.set ?? {})]);
  const choices = (k: string) => {
    const p = props[k]?.anyOf ? props[k].anyOf.find((m: { type?: string }) => m.type !== 'null') : props[k];
    return p?.enum ? p.enum.join('|') : undefined;
  };
  const positional = [...(f.form.pos ?? []).map((k) => choices(k) ?? k.toUpperCase()), ...(f.form.rest ? [`${f.form.rest.toUpperCase()}…`] : [])];
  const flagOf = (k: string) => Object.entries(f.form.alias ?? {}).find(([, arg]) => arg === k)?.[0] ?? kebab(k);
  const flags = Object.keys(props)
    .filter((k) => !given.has(k))
    .map((k) => {
      const flag = `--${flagOf(k)}${props[k].type === 'boolean' ? '' : ` ${choices(k) ?? 'V'}`}`;
      return req.has(k) ? flag : `[${flag}]`;
    });
  if (f.kind === 'view' && (spec as { wait?: true }).wait) flags.push('[--timeout S]');
  return `${f.form.verb} ${[...positional, ...flags].join(' ')}`.trim();
}
