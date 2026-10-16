import { parse } from '../src/core/io';
import type { CanvasDoc } from '../src/core/doc';
import type { ChatMessage } from '../src/core/chat';
import type { AgentApi } from '../src/core/agent';
import type { NodeSummary } from '../src/core/query';

// Thin client for the bridge's HTTP API (used by the CLI and the MCP server). Agents never touch
// Yjs: they send named commands; the bridge runs them as a seated player.

export interface RunReply {
  result: unknown;
  text?: string;
  changed?: number;
  undescribed?: boolean;
}

export interface Client extends AgentApi {
  doc(): Promise<CanvasDoc>;
  query(q: Record<string, string | undefined>): Promise<NodeSummary[]>;
  /** Raw command, unchecked (compat; agents use `run`). */
  cmd(name: string, args: unknown): Promise<{ ok: boolean; error?: string; touched?: string[]; select?: string[]; changed?: number }>;
  /** A command as an agent: args checked against the plugin's description (throws the reason, with the field and an example). */
  run(name: string, args: object): Promise<RunReply>;
  undo(redo?: boolean): Promise<{ ok: boolean; error?: string }>;
  log(limit?: number): Promise<{ time: string; actor: string | null; text: string }[]>;
  status(): Promise<unknown>;
  /** A plugin view as this actor (e.g. chess.state); throws its error. */
  view<T = any>(name: string, args?: object): Promise<T>;
  /** Long-poll a view until it's ready (e.g. chess.turn); undefined after `timeoutS` (≤ 290). */
  wait<T = any>(name: string, args?: object, timeoutS?: number): Promise<T | undefined>;
  /** `wait` repeated in slices until `totalS` has passed (a long call may be cut off by whoever called). */
  waitLong<T = any>(name: string, args?: object, totalS?: number, slice?: number): Promise<T | undefined>;
  /** The bridge's help for plugins (JSON). */
  help(plugin?: string, command?: string): Promise<any>;
  /** Say something in the table chat; `node` = id or title of a node it is about. */
  say(text: string, node?: string): Promise<ChatMessage>;
  /** Last `limit` messages, or only those since you last looked (`onlyNew`). Either marks everything as seen. */
  chatRead(opts?: { limit?: number; onlyNew?: boolean }): Promise<ChatMessage[]>;
  /** Long-poll for new messages from others; `[]` after `timeoutS` with none. */
  chatWait(timeoutS?: number): Promise<ChatMessage[]>;
}

const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined));

export function client(opts: { url?: string; as?: string; kind?: 'agent' | 'tool' } = {}): Client {
  const base = (opts.url ?? process.env.CANVAS_BRIDGE ?? 'http://localhost:5222').replace(/\/+$/, '');
  const as = opts.as ?? process.env.CANVAS_AS ?? 'Claude';
  const kind = opts.kind ?? 'agent';
  const req = async (path: string, init?: { body: unknown }) => {
    let res: Response;
    try {
      res = await fetch(base + path, init ? { method: 'POST', body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : undefined);
    } catch {
      throw new Error(`can't reach the canvas bridge at ${base} (start it: pnpm bridge <file.canvas>)`);
    }
    const text = await res.text();
    return text;
  };
  const json = async (path: string, init?: { body: unknown }) => JSON.parse(await req(path, init));
  const viewPath = (kindOf: 'view' | 'wait', name: string, args: object, extra: Record<string, string> = {}) => `/${kindOf}/${name}?${qs({ args: JSON.stringify(args), as, kind, ...extra })}`;
  const self: Client = {
    doc: async () => parse(await req('/doc')),
    query: (q) => json(`/query?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]))}`),
    cmd: (name, args) => json('/cmd', { body: { as, kind, name, args } }),
    run: async (name, args) => {
      const r = await json('/agent/run', { body: { as, kind, name, args } });
      if (!r.ok) throw new Error(r.error ?? 'failed');
      return r;
    },
    undo: (redo = false) => json(redo ? '/redo' : '/undo', { body: { as, kind } }),
    log: (limit = 20) => json(`/log?limit=${limit}`),
    status: () => json('/status'),
    view: async (name, args = {}) => {
      const r = await json(viewPath('view', name, args));
      if (r?.error) throw new Error(r.error);
      return r;
    },
    wait: async (name, args = {}, timeoutS = 50) => {
      const r = await json(viewPath('wait', name, args, { timeout: String(timeoutS) }));
      if (r?.waiting) return undefined;
      if (r?.error) throw new Error(r.error);
      return r;
    },
    waitLong: async (name, args = {}, totalS = 290, slice = 50) => {
      const end = Date.now() + totalS * 1000;
      while (Date.now() < end) {
        const left = Math.max(1, Math.min(slice, Math.round((end - Date.now()) / 1000)));
        const v = await self.wait(name, args, left);
        if (v !== undefined) return v;
      }
      return undefined;
    },
    help: async (plugin, command) => {
      const r = await json(`/agent/help?${qs({ plugin, command })}`);
      if (r?.error) throw new Error(r.error);
      return r;
    },
    say: async (text, node) => {
      const r = await json('/chat/say', { body: { as, kind, text, node } });
      if (!r.ok) throw new Error(r.error ?? 'failed');
      return r.message;
    },
    chatRead: async (o = {}) => {
      const r = await json(`/chat/read?${qs({ as, kind, limit: o.limit ? String(o.limit) : undefined, new: o.onlyNew ? '1' : undefined })}`);
      if (!Array.isArray(r)) throw new Error(r?.error ?? 'unexpected reply');
      return r;
    },
    chatWait: async (timeoutS = 50) => {
      const r = await json(`/chat/wait?${qs({ as, kind, timeout: String(timeoutS) })}`);
      if (Array.isArray(r)) return r;
      if (r?.waiting) return [];
      throw new Error(r?.error ?? 'unexpected reply');
    },
  };
  return self;
}
