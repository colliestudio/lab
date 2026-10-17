import { chatText } from '../../src/core/chat';
import type { Catalog } from '../../bridge/catalog';
import { client, type Client } from '../../bridge/client';
import { toolList, type ToolResult, type ToolSpec } from '../../bridge/tools';
import { fold } from '../core/directory';
import { localSend } from './local';
import { MAX_NAME, type McpSession } from './session';

// The tools an MCP session sees: the bridge's generated tools (bridge/tools.ts), each acting on a
// board the session has joined, plus canvas_boards / canvas_join / canvas_leave and a chat_wait that
// waits on every joined board. Tool bodies are the bridge's own; only the client under them differs
// (in-process, as the seat joined).

/** The argument added to every board-acting tool to say which joined board (plugin tools may already use "board" for their own). */
export const BOARD_ARG = 'canvas';

type Json = Record<string, any>;

export interface CallCtx {
  signal: AbortSignal;
}

export interface SessionTool {
  name: string;
  description: string;
  inputSchema: Json;
  call(args: Json, ctx: CallCtx): Promise<ToolResult>;
}

const str = (description: string): Json => ({ type: 'string', description });
const obj = (properties: Json, required: string[] = []): Json => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

/**
 * `tools` made to act on a joined board: they take the optional BOARD_ARG, which is removed before
 * the tool's own checks. The board is resolved when the tool first uses its client, so tools that
 * never do (canvas_help) work before any join.
 */
export function scopedTools(tools: ToolSpec[], session: McpSession): SessionTool[] {
  return tools.map((t) => {
    if (t.inputSchema.properties?.[BOARD_ARG]) throw new Error(`tool ${t.name} already has an argument named ${BOARD_ARG}`);
    const inputSchema = { ...t.inputSchema, properties: { ...t.inputSchema.properties, [BOARD_ARG]: str('which joined canvas; optional when you joined only one') } };
    return {
      name: t.name,
      description: t.description,
      inputSchema,
      call: (args, ctx) => {
        const { [BOARD_ARG]: which, ...rest } = args;
        let real: Client | undefined;
        const lazy = new Proxy({} as Client, {
          get(_, prop) {
            if (!real) {
              const j = session.resolve(which === undefined ? undefined : String(which));
              real = client({ as: j.actor.name, send: localSend(j.board, AbortSignal.any([ctx.signal, session.abort.signal, j.abort.signal])) });
            }
            return Reflect.get(real, prop);
          },
        });
        return t.call(lazy, rest);
      },
    };
  });
}

const JOIN_PROPS: Json = {
  board: str('the canvas name (canvas_boards lists them)'),
  name: str(`the name others see on your cursor and in the log, up to ${MAX_NAME} characters`),
  create: { type: 'boolean', description: 'make the canvas if it does not exist (default false)' },
};
const LEAVE_PROPS: Json = { board: str('a canvas you joined') };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function sessionTools(cat: Catalog, session: McpSession): SessionTool[] {
  const own: SessionTool[] = [
    {
      name: 'canvas_boards',
      description: 'List the canvases this service has, and which ones you have joined (with the name you sit under). Join one with canvas_join.',
      inputSchema: obj({}),
      call: async () => {
        const list = await session.svc.directory.list();
        const mine = (n: string) => session.joins.get(fold(n));
        const line = (e: (typeof list)[number]) => `${e.name}  ${e.loaded ? 'loaded' : 'not loaded'} · ${plural(e.browsers, 'browser')}${mine(e.name) ? ` · joined as ${mine(e.name)!.actor.name}` : ''}${e.error ? ` · cannot open: ${e.error}` : ''}`;
        const sorted = [...list.filter((e) => mine(e.name)), ...list.filter((e) => !mine(e.name))];
        return sorted.length ? sorted.map(line).join('\n') : '(no canvases yet: canvas_join with create: true makes one)';
      },
    },
    {
      name: 'canvas_join',
      description: 'Join a canvas: you get a seat there under `name` (your own cursor, log name and undo history). You can join several canvases and the same canvas can have several agents. Other tools then act on the canvas you joined; with several joined, pass `canvas` to say which. Joining again under the same name changes nothing.',
      inputSchema: obj(JOIN_PROPS, ['board', 'name']),
      call: async (a) => {
        const j = await session.join(String(a.board ?? ''), String(a.name ?? ''), { create: a.create === true });
        const host = j.board.host;
        const doc = host.store.doc;
        const others = host.seated().filter((x) => x.id !== j.actor.id).map((x) => x.name);
        const unread = host.unreadChat(j.actor);
        return [
          `joined "${j.name}" as ${j.actor.name}: ${plural(doc.nodes.length, 'node')}, ${plural(doc.edges.length, 'edge')}`,
          `also seated: ${others.length ? others.join(', ') : 'nobody'}`,
          `unread chat: ${unread}`,
          'canvas_help says what can be done here; chat_wait waits for what others say',
        ].join('\n');
      },
    },
    {
      name: 'canvas_leave',
      description: 'Leave a canvas you joined: your cursor and undo history go. Rejoining later starts a fresh seat.',
      inputSchema: obj(LEAVE_PROPS, ['board']),
      call: async (a) => `left "${session.leave(String(a.board ?? '')).name}"`,
    },
  ];
  const scoped = scopedTools(toolList(cat), session);
  const single = scoped.find((t) => t.name === 'chat_wait');
  if (!single) throw new Error('no chat_wait tool to extend');
  const chatWait: SessionTool = {
    ...single,
    description: `${single.description} With several canvases joined and no \`${BOARD_ARG}\`, it waits on all of them and names the canvas of each message.`,
    call: async (args, ctx) => {
      if (args[BOARD_ARG] !== undefined || session.joins.size < 2) return single.call(args, ctx);
      const t = Number(args.timeout_s ?? 240);
      return waitAll(session, Number.isFinite(t) ? t : 240, ctx.signal);
    },
  };
  return [...own, ...scoped.map((t) => (t.name === 'chat_wait' ? chatWait : t))];
}

/** First message on any joined board wins; the waits on the others are cancelled (marking nothing seen), then read for what arrived meanwhile. */
async function waitAll(session: McpSession, timeoutS: number, signal: AbortSignal): Promise<string> {
  const joins = [...session.joins.values()];
  const ms = Math.min(Math.max(timeoutS, 1), 290) * 1000;
  const stop = new AbortController();
  const all = AbortSignal.any([signal, session.abort.signal, stop.signal]);
  const waits = joins.map(async (j) => {
    const msgs = await j.board.host.waitChat(j.actor, ms, AbortSignal.any([all, j.abort.signal]));
    if (msgs) stop.abort();
    return msgs;
  });
  const got = await Promise.all(waits);
  const parts: string[] = [];
  joins.forEach((j, i) => {
    const msgs = got[i] ?? (signal.aborted || session.closed || j.abort.signal.aborted ? [] : j.board.host.readChat(j.actor, { onlyNew: true }));
    if (msgs.length) parts.push(`# ${j.name}\n${chatText(msgs, j.board.host.store.doc)}`);
  });
  return parts.join('\n\n') || 'nothing new yet; call chat_wait again';
}
