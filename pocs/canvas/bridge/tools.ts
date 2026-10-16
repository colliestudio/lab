import { chatText } from '../src/core/chat';
import type { Catalog } from './catalog';
import type { Client } from './client';

// The agent's tools, generated: four generic ones that reach everything plugins describe
// (canvas_look / canvas_do / canvas_help / canvas_wait), the core ones (list, log, undo, chat), and one
// named tool for each command or view whose spec carries a `tool` name (kept so existing agents'
// tool names still work). No plugin is named here; it all comes from the catalog.

type Json = Record<string, any>;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Json;
  call(c: Client, args: Record<string, any>): Promise<string>;
}

const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const obj = (properties: Json = {}, required: string[] = []): Json => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const str = (description: string): Json => ({ type: 'string', description });
const num = (description: string): Json => ({ type: 'number', description });

export function toolList(cat: Catalog): ToolSpec[] {
  // examples come from whatever the plugins describe, never from names written here
  const first = cat.plugins().flatMap((p) => p.commands).find((n) => cat.spec(n) && cat.owner(n) !== 'core');
  const e = first ? { name: first, args: cat.spec(first)!.example } : { name: '<plugin>.<command>', args: {} };
  const show = (name: string, value: unknown) => {
    const text = cat.viewSpec(name)?.text;
    return text ? text(value) : json(value);
  };
  const doneText = (r: { result: unknown; text?: string; undescribed?: boolean }) => (r.text ?? json(r.result)) + (r.undescribed ? '\n(no description for this command yet: its args were not checked)' : '');

  const generic: ToolSpec[] = [
    {
      name: 'canvas_look',
      description: 'Look at the canvas. Without `view`: the nodes (id, type, text, position, column, outgoing links), filtered by type/text/column/ext. With `view` (a name from canvas_help, e.g. a game plugin\'s state): that view as text.',
      inputSchema: obj({ view: str('view name, e.g. one listed by canvas_help'), args: { type: 'object', description: 'the view\'s arguments' }, type: str('text | group | link | file | …'), text: str('substring'), column: str('column (group) label'), ext: str('plugin namespace on the node (x-…)') }),
      call: async (c, a) => (a.view ? show(a.view, await c.view(a.view, a.args ?? {})) : json(await c.query({ type: a.type, text: a.text, column: a.column, ext: a.ext }))),
    },
    {
      name: 'canvas_do',
      description: `Run a command by name, e.g. ${JSON.stringify({ command: e.name, args: e.args })}. canvas_help lists the commands with their arguments and examples. Node arguments take an id or a title. Bad arguments are refused with the field and an example.`,
      inputSchema: obj({ command: str('command name from canvas_help'), args: { type: 'object', description: 'the command\'s arguments (see canvas_help)' } }, ['command']),
      call: async (c, a) => doneText(await c.run(a.command, a.args ?? {})),
    },
    {
      name: 'canvas_help',
      description: 'What can be done here. Without arguments: the plugins. With `plugin`: its guide, commands (arguments, examples) and views. With `command` (or a view name): that one in full.',
      inputSchema: obj({ plugin: str('plugin id from the plugin list'), command: str('command or view name') }),
      call: async (_c, a) => cat.helpText(a.plugin, a.command),
    },
    {
      name: 'canvas_wait',
      description: 'Block until a view is ready (e.g. it is your move), then return it. Returns "still waiting" after timeout_s (default 240); call again.',
      inputSchema: obj({ view: str('a waitable view, see canvas_help'), args: { type: 'object', description: 'the view\'s arguments' }, timeout_s: num('seconds, default 240') }, ['view']),
      call: async (c, a) => waited(a.view, await c.waitLong(a.view, a.args ?? {}, a.timeout_s ?? 240)),
    },
  ];
  const waited = (view: string, v: unknown) => (v === undefined ? (cat.viewSpec(view)?.waiting ?? 'still waiting; call canvas_wait again') : show(view, v));

  const core: ToolSpec[] = [
    {
      name: 'canvas_list',
      description: 'List nodes on the canvas (id, type, text, position, column, outgoing links). Filters are optional.',
      inputSchema: obj({ type: str('text | group | link | file | …'), text: { type: 'string' }, column: str('column (group) label'), ext: str('plugin namespace on the node (x-…)') }),
      call: async (c, a) => json(await c.query(a)),
    },
    {
      name: 'canvas_undo',
      description: 'Undo your own last step (other players’ steps are theirs to undo).',
      inputSchema: obj({ redo: { type: 'boolean' } }),
      call: async (c, a) => {
        const r = await c.undo(!!a.redo);
        if (!r.ok) throw new Error(r.error);
        return 'done';
      },
    },
    {
      name: 'canvas_log',
      description: 'Recent events on the canvas: who did what (people, agents, the file, tools).',
      inputSchema: obj({ limit: { type: 'number' } }),
      call: async (c, a) => (await c.log(a.limit ?? 20)).map((e) => `${e.time.slice(11, 19)} ${e.actor ?? '—'} ${e.text}`).join('\n'),
    },
    {
      name: 'chat_send',
      description: 'Say something in the table chat, as a player. Mention people with @Name (or @all). `node` = a node (id or title) the message is about.',
      inputSchema: obj({ text: { type: 'string' }, node: str('node id or title') }, ['text']),
      call: async (c, a) => {
        await c.say(a.text, a.node);
        return 'sent';
      },
    },
    {
      name: 'chat_read',
      description: 'Read the table chat: the last `limit` messages (default 20), or only what is new since you last looked (`only_new`).',
      inputSchema: obj({ limit: { type: 'number' }, only_new: { type: 'boolean' } }),
      call: async (c, a) => chatText(await c.chatRead({ limit: a.limit, onlyNew: a.only_new }), await c.doc()) || (a.only_new ? '(nothing new)' : '(no messages)'),
    },
    {
      name: 'chat_wait',
      description: 'Block until someone else says something in the table chat, then return the new messages. Returns "nothing new" after timeout_s (default 240); call again. Reply with chat_send.',
      inputSchema: obj({ timeout_s: { type: 'number' } }),
      call: async (c, a) => chatText(await c.chatWait(a.timeout_s ?? 240), await c.doc()) || 'nothing new yet; call chat_wait again',
    },
  ];

  // one named tool per spec that has a `tool` name
  const named: ToolSpec[] = [];
  for (const p of cat.plugins()) {
    for (const name of p.commands) {
      const s = cat.spec(name);
      if (!s?.tool) continue;
      named.push({ name: s.tool, description: s.description, inputSchema: cat.publicSchema(s.args), call: async (c, a) => doneText(await c.run(name, a)) });
    }
    for (const name of p.views) {
      const s = cat.viewSpec(name)!;
      if (!s.tool) continue;
      const schema = cat.publicSchema(s.args);
      if (s.wait) {
        schema.properties = { ...schema.properties, timeout_s: num('seconds, default 240') };
        named.push({ name: s.tool, description: `${s.description} Returns "still waiting" after timeout_s (default 240); call again.`, inputSchema: schema, call: async (c, { timeout_s, ...a }) => waited(name, await c.waitLong(name, a, timeout_s ?? 240)) });
      } else named.push({ name: s.tool, description: s.description, inputSchema: schema, call: async (c, a) => show(name, await c.view(name, a)) });
    }
  }
  const tools = [...generic, ...core, ...named];
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`two tools named ${t.name}`);
    seen.add(t.name);
  }
  return tools;
}

