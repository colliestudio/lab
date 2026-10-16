import * as z from 'zod/mini';
import { registerCoreCommands } from '../../src/core/commands';
import type { ArgSchema, CommandSpec, ViewSpec } from '../../src/core/agent';
import type { DocView } from '../../src/core/doc';
import { resolveNode } from '../../src/core/query';
import { Store } from '../../src/core/store';
import { PLUGIN_LOGIC, useLogic, type PluginLogic } from '../../src/plugins/logic';

// What the bridge knows about plugins, built from their logic: which plugin owns which commands and
// views, which are described, how to validate args and how to explain them. The bridge itself names
// no plugin; everything here comes from the specs the plugins register (src/core/agent.ts).

// zod/mini ships without messages ("Invalid input"); the bridge processes load English once
z.config(z.locales.en());

export interface PluginInfo {
  id: string;
  title: string;
  summary: string;
  guide?: string;
  commands: string[];
  views: string[];
  undescribed: string[];
}

type Json = Record<string, any>;
export type Validated = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

const CORE: PluginLogic = { id: 'core', title: 'Canvas core', summary: 'Commands every object gets: move, duplicate, delete, arrows.', register: registerCoreCommands };

const isRef = (p: Json | undefined): boolean => !!p && (p.format === 'canvas-node' || (Array.isArray(p.anyOf) && p.anyOf.some(isRef)));
const isRefList = (p: Json | undefined): boolean => !!p && ((p.type === 'array' && isRef(p.items)) || (Array.isArray(p.anyOf) && p.anyOf.some(isRefList)));

function typeName(p: Json): string {
  if (p.format === 'canvas-node') return 'node';
  if (p.enum) return p.enum.map(String).join('|');
  if (p.anyOf) return p.anyOf.map(typeName).join('|');
  if (Array.isArray(p.type)) return p.type.join('|');
  if (p.type === 'array') return `${typeName(p.items ?? {})}[]`;
  if (p.type === 'object') return p.properties ? `{${Object.keys(p.properties).join(', ')}}` : 'object';
  return p.type ?? 'any';
}

/** The sub-schema at an issue path (properties by name, array items by index; the non-null side of a nullable). */
function schemaAt(js: Json, path: (string | number)[]): Json | undefined {
  let cur: Json | undefined = js;
  for (const seg of path) {
    const c: Json | undefined = cur?.anyOf ? (cur.anyOf as Json[]).find((m) => m.type !== 'null') : cur;
    cur = typeof seg === 'number' ? c?.items : c?.properties?.[seg];
  }
  return cur?.anyOf ? (cur.anyOf as Json[]).find((m) => m.type !== 'null') : cur;
}

export function buildCatalog(logic: readonly PluginLogic[] = PLUGIN_LOGIC) {
  const store = new Store();
  const entries = [CORE, ...logic];
  const owner = new Map<string, string>(); // command or view name → plugin id
  for (const entry of entries) {
    const before = new Set([...store.commandNames(), ...store.viewNames()]);
    useLogic(store, entry);
    for (const n of [...store.commandNames(), ...store.viewNames()]) if (!before.has(n)) owner.set(n, entry.id);
  }
  const schemas = new WeakMap<ArgSchema, Json>();

  const plugins = (): PluginInfo[] =>
    entries.map((e) => {
      const commands = store.commandNames().filter((n) => owner.get(n) === e.id);
      return {
        id: e.id,
        title: e.title ?? e.id,
        summary: e.summary ?? '',
        guide: e.guide,
        commands,
        views: store.viewNames().filter((n) => owner.get(n) === e.id),
        undescribed: commands.filter((n) => !store.spec(n)),
      };
    });
  const plugin = (id: string) => plugins().find((p) => p.id === id);

  /** JSON Schema of the args (what MCP clients see), without the `$schema` marker. */
  const jsonSchema = (schema: ArgSchema): Json => {
    let js = schemas.get(schema);
    if (!js) {
      const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Json;
      schemas.set(schema, (js = rest));
    }
    return js;
  };

  /** The JSON Schema for MCP clients: the node-reference marker (bridge-internal) is left out. */
  const publicSchema = (schema: ArgSchema): Json => JSON.parse(JSON.stringify(jsonSchema(schema), (k, v) => (k === 'format' && v === 'canvas-node' ? undefined : v)));

  const moreHint = (name: string, kind: 'command' | 'view') => {
    const p = owner.get(name);
    return `More: canvas_help ${JSON.stringify(kind === 'command' ? { plugin: p, command: name } : { plugin: p })}`;
  };

  /** Args against the command's (or view's) schema. Every problem is listed, with the field, an example and where to read more. */
  const validate = (name: string, args: unknown, kind: 'command' | 'view' = 'command'): Validated => {
    const spec: CommandSpec | ViewSpec | undefined = kind === 'command' ? store.spec(name) : store.viewSpec(name);
    if (!spec) return { ok: false, error: unknownError(name, kind) };
    const r = z.safeParse(spec.args, args ?? {});
    if (r.success) return { ok: true, value: r.data as Record<string, unknown> };
    const lines = r.error.issues.flatMap((i) => {
      if (i.code === 'unrecognized_keys') {
        // the fields of the object that has the stray key, not of the top level
        const known = Object.keys(schemaAt(jsonSchema(spec.args), i.path as (string | number)[])?.properties ?? {});
        return i.keys.map((k) => `args.${[...i.path, k].join('.')}: unknown field (fields: ${known.join(', ') || 'unknown'})`);
      }
      const path = i.path.length ? `args.${i.path.join('.')}` : 'args';
      return [`${path}: ${i.message.replace(/^Invalid input: /, '')}`];
    });
    const ex = spec.example === undefined ? '' : ` Example: ${JSON.stringify(spec.example)}.`;
    return { ok: false, error: `${name}: ${lines.join('; ')}.${ex} ${moreHint(name, kind)}` };
  };

  function unknownError(name: string, kind: 'command' | 'view'): string {
    const names = kind === 'command' ? store.commandNames() : store.viewNames();
    const ns = name.split('.')[0];
    const near = names.filter((n) => n.startsWith(`${ns}.`));
    const what = kind === 'command' ? 'command' : 'view';
    if (near.length) return `unknown ${what} "${name}"; ${ns} has: ${near.join(', ')}`;
    return `unknown ${what} "${name}"; plugins: ${plugins().filter((p) => (kind === 'command' ? p.commands : p.views).length).map((p) => p.id).join(', ')} (canvas_help lists them)`;
  }

  /** Replace node references (an id or a title) in `value` by node ids, for the args the schema marks as nodes. */
  const resolveRefs = (schema: ArgSchema, value: Record<string, unknown>, doc: Pick<DocView, 'nodes'>) => {
    const props: Json = jsonSchema(schema).properties ?? {};
    const out = { ...value };
    for (const [k, p] of Object.entries(props)) {
      const v = out[k];
      if (typeof v === 'string' && isRef(p)) out[k] = resolveNode(doc, v).id;
      else if (Array.isArray(v) && isRefList(p)) out[k] = v.map((x) => (typeof x === 'string' ? resolveNode(doc, x).id : x));
    }
    return out;
  };

  const argLines = (schema: ArgSchema) => {
    const js = jsonSchema(schema);
    const req = new Set<string>(js.required ?? []);
    return Object.entries<Json>(js.properties ?? {}).map(([k, p]) => `    ${k}${req.has(k) ? '' : '?'}: ${typeName(p)}${p.description ? ` - ${p.description}` : ''}`);
  };

  const commandText = (name: string) => {
    const s = store.spec(name)!;
    const cli = s.cli?.length ? `\n    cli: ${s.cli.map((f) => `canvas ${f.verb}`).join(' | ')}` : '';
    return [`  ${name} - ${s.description}`, ...argLines(s.args), `    example: ${JSON.stringify(s.example)}${cli}`].join('\n');
  };
  const viewText = (name: string) => {
    const s = store.viewSpec(name)!;
    const ex = s.example === undefined ? [] : [`    example: ${JSON.stringify(s.example)}`];
    return [`  ${name} - ${s.description}${s.wait ? ' (use canvas_wait to block until ready)' : ''}`, ...argLines(s.args), ...ex].join('\n');
  };

  /** Plain-text help: all plugins; one plugin (guide, commands, views); one command or view in full. */
  const helpText = (pluginId?: string, name?: string): string => {
    if (name && pluginId && !name.includes('.')) name = `${pluginId}.${name}`;
    if (name) {
      if (store.spec(name)) return `${commandText(name)}\n  run: canvas_do ${JSON.stringify({ command: name, args: store.spec(name)!.example })}`;
      if (store.viewSpec(name)) return `${viewText(name)}\n  read: canvas_look ${JSON.stringify({ view: name })}`;
      if (store.has(name)) return `${name} - no description yet; it runs with canvas_do, args as the command takes them (unchecked).`;
      throw new Error(unknownError(name, 'command'));
    }
    if (!pluginId) {
      const rows = plugins().map((p) => `  ${p.id} - ${p.summary || p.title} (${p.commands.length - p.undescribed.length} commands described${p.undescribed.length ? `, ${p.undescribed.length} not` : ''}, ${p.views.length} views)`);
      return ['Plugins on this canvas:', ...rows, '', 'canvas_help {"plugin": "<id>"} gives a plugin\'s guide, commands and views; with "command" one in full.', 'canvas_look reads (no args: the nodes), canvas_do runs a command, canvas_wait blocks on a view.'].join('\n');
    }
    const p = plugin(pluginId);
    if (!p) throw new Error(`unknown plugin "${pluginId}"; plugins: ${plugins().map((x) => x.id).join(', ')}`);
    const described = p.commands.filter((n) => store.spec(n));
    return [
      `${p.title} (${p.id})${p.summary ? `: ${p.summary}` : ''}`,
      ...(p.guide ? ['', p.guide.trim()] : []),
      ...(described.length ? ['', 'Commands (canvas_do {command, args}):', ...described.map(commandText)] : []),
      ...(p.views.length ? ['', 'Views (canvas_look {view, args}):', ...p.views.map(viewText)] : []),
      ...(p.undescribed.length ? ['', `Not described yet (callable with canvas_do, args unchecked): ${p.undescribed.join(', ')}`] : []),
    ].join('\n');
  };

  const commandJson = (name: string) => {
    const s = store.spec(name)!;
    return { name, description: s.description, args: jsonSchema(s.args), example: s.example, ...(s.tool ? { tool: s.tool } : {}), ...(s.cli ? { cli: s.cli } : {}) };
  };
  const viewJson = (name: string) => {
    const s = store.viewSpec(name)!;
    return { name, description: s.description, args: jsonSchema(s.args), ...(s.example !== undefined ? { example: s.example } : {}), ...(s.wait ? { wait: true } : {}), ...(s.tool ? { tool: s.tool } : {}) };
  };
  /** The same help as JSON (GET /agent/help). */
  const helpJson = (pluginId?: string, name?: string): unknown => {
    if (name && pluginId && !name.includes('.')) name = `${pluginId}.${name}`;
    if (name) {
      if (store.spec(name)) return commandJson(name);
      if (store.viewSpec(name)) return viewJson(name);
      if (store.has(name)) return { name, undescribed: true };
      throw new Error(unknownError(name, 'command'));
    }
    if (!pluginId) return plugins().map((p) => ({ id: p.id, title: p.title, summary: p.summary, commands: p.commands.length - p.undescribed.length, views: p.views.length, undescribed: p.undescribed.length }));
    const p = plugin(pluginId);
    if (!p) throw new Error(`unknown plugin "${pluginId}"; plugins: ${plugins().map((x) => x.id).join(', ')}`);
    return { id: p.id, title: p.title, summary: p.summary, guide: p.guide, commands: p.commands.filter((n) => store.spec(n)).map(commandJson), views: p.views.map(viewJson), undescribed: p.undescribed };
  };

  return {
    plugins,
    plugin,
    owner: (name: string) => owner.get(name),
    spec: (name: string) => store.spec(name),
    viewSpec: (name: string) => store.viewSpec(name),
    hasCommand: (name: string) => store.has(name),
    commandNames: () => store.commandNames(),
    viewNames: () => store.viewNames(),
    jsonSchema,
    publicSchema,
    validate,
    resolveRefs,
    helpText,
    helpJson,
    unknownError,
  };
}

export type Catalog = ReturnType<typeof buildCatalog>;

let shared: Catalog | undefined;
/** The catalog of the built-in plugins, built once per process. */
export const catalog = () => (shared ??= buildCatalog());
